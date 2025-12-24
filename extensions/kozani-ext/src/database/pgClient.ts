import { Client, ClientConfig } from 'pg';
import { FullConnection } from './connectionManager';

export interface SchemaInfo {
	name: string;
}

export interface TableInfo {
	schema: string;
	name: string;
	type: 'table' | 'view';
}

export interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
	defaultValue: string | null;
	isPrimaryKey: boolean;
}

/**
 * Creates a pg Client config from a FullConnection (metadata + credentials).
 * Username is stored in the connection YAML, password in SecretStorage.
 */
function buildClientConfig(conn: FullConnection, database?: string): ClientConfig {
	if (!conn.credentials) {
		throw new Error('Connection credentials not available');
	}

	return {
		host: conn.host,
		port: conn.port,
		database: database || conn.default_database || 'postgres',
		user: conn.user,
		password: conn.credentials.password,
		ssl: conn.credentials.ssl ? { rejectUnauthorized: false } : undefined,
		connectionTimeoutMillis: 10000,
	};
}

/**
 * Executes a query against the user's Postgres database.
 * Opens a connection, runs the query, and closes it.
 */
export async function query<T = Record<string, unknown>>(
	conn: FullConnection,
	sql: string,
	params: unknown[] = [],
	database?: string
): Promise<T[]> {
	const client = new Client(buildClientConfig(conn, database));

	try {
		await client.connect();
		const result = await client.query(sql, params);
		return result.rows as T[];
	} finally {
		await client.end();
	}
}

/**
 * Tests if a connection can be established.
 */
export async function testConnection(conn: FullConnection, database?: string): Promise<{ success: boolean; error?: string }> {
	try {
		await query(conn, 'SELECT 1', [], database);
		return { success: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { success: false, error: message };
	}
}

/**
 * Lists all databases on the server.
 */
export async function listDatabases(conn: FullConnection): Promise<string[]> {
	const rows = await query<{ datname: string }>(
		conn,
		`SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
	);
	return rows.map(r => r.datname);
}

/**
 * Lists all schemas in a database (excludes system schemas).
 * Filters out:
 * - pg_catalog, information_schema (standard system schemas)
 * - pg_toast, pg_toast_temp_* (TOAST storage schemas)
 * - pg_temp_* (session-local temporary schemas)
 */
export async function listSchemas(conn: FullConnection, database: string): Promise<SchemaInfo[]> {
	const rows = await query<{ schema_name: string }>(
		conn,
		`SELECT schema_name FROM information_schema.schemata
			WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
			AND schema_name NOT LIKE 'pg_toast%'
			AND schema_name NOT LIKE 'pg_temp%'
			ORDER BY schema_name`,
		[],
		database
	);
	return rows.map(r => ({ name: r.schema_name }));
}

/**
 * Lists all tables and views in a schema.
 */
export async function listTablesAndViews(conn: FullConnection, database: string, schema: string): Promise<TableInfo[]> {
	const rows = await query<{ table_name: string; table_type: string }>(
		conn,
		`SELECT table_name, table_type FROM information_schema.tables
			WHERE table_schema = $1
			ORDER BY table_type, table_name`,
		[schema],
		database
	);

	return rows.map(r => ({
		schema,
		name: r.table_name,
		type: r.table_type === 'VIEW' ? 'view' : 'table'
	}));
}

/**
 * Lists columns for a table or view.
 */
export async function listColumns(
	conn: FullConnection,
	database: string,
	schema: string,
	table: string
): Promise<ColumnInfo[]> {
	// Get columns with basic info
	const columns = await query<{
		column_name: string;
		data_type: string;
		is_nullable: string;
		column_default: string | null;
	}>(
		conn,
		`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
			WHERE table_schema = $1 AND table_name = $2
			ORDER BY ordinal_position`,
		[schema, table],
		database
	);

	// Get primary key columns
	const pkColumns = await query<{ column_name: string }>(
		conn,
		`SELECT kcu.column_name
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
				ON tc.constraint_name = kcu.constraint_name
				AND tc.table_schema = kcu.table_schema
			WHERE tc.constraint_type = 'PRIMARY KEY'
				AND tc.table_schema = $1
				AND tc.table_name = $2`,
		[schema, table],
		database
	);

	const pkSet = new Set(pkColumns.map(r => r.column_name));

	return columns.map(c => ({
		name: c.column_name,
		type: c.data_type,
		nullable: c.is_nullable === 'YES',
		defaultValue: c.column_default,
		isPrimaryKey: pkSet.has(c.column_name)
	}));
}
