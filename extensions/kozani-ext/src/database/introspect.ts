import { Client, ClientConfig } from 'pg';
import { FullConnection } from './connectionManager';

/**
 * Raw schema element as returned by Postgres.
 * This is the format we send to the backend - minimal transformation.
 */
export interface SchemaElement {
	table_schema: string;
	table_name: string;
	table_type: string;  // 'BASE TABLE' or 'VIEW'
	column_name: string;
	data_type: string;
	is_nullable: boolean;
	is_pk: boolean;
	fk_reference: string | null;  // 'schema.table.column' or null
}

/**
 * Single query that returns all schema elements for a database.
 * Uses pg_catalog directly for speed (information_schema is slow).
 */
// prettier-ignore
const INTROSPECT_QUERY = /* sql */`
SELECT
n.nspname as table_schema,
c.relname as table_name,
CASE c.relkind WHEN 'r' THEN 'BASE TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'VIEW' END as table_type,
a.attname as column_name,
pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
NOT a.attnotnull as is_nullable,
COALESCE(pk.is_pk, false) as is_pk,
fk.fk_reference
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
LEFT JOIN (
SELECT con.conrelid, unnest(con.conkey) as attnum, true as is_pk
FROM pg_catalog.pg_constraint con WHERE con.contype = 'p'
) pk ON pk.conrelid = c.oid AND pk.attnum = a.attnum
LEFT JOIN (
SELECT con.conrelid, unnest(con.conkey) as attnum,
fn.nspname || '.' || fc.relname || '.' || fa.attname as fk_reference
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
JOIN pg_catalog.pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = ANY(con.confkey)
WHERE con.contype = 'f'
) fk ON fk.conrelid = c.oid AND fk.attnum = a.attnum
WHERE c.relkind IN ('r', 'v', 'm')
AND a.attnum > 0
AND NOT a.attisdropped
AND n.nspname NOT IN ('pg_catalog', 'information_schema')
AND n.nspname NOT LIKE 'pg_toast%'
AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY n.nspname, c.relname, a.attnum
`;

/**
 * Introspects a database and returns all schema elements in a flat array.
 * One query, no loops, minimal transformation.
 */
export async function introspectDatabase(conn: FullConnection, database?: string): Promise<SchemaElement[]> {
	if (!conn.credentials) {
		throw new Error('Connection credentials not available');
	}

	const config: ClientConfig = {
		host: conn.host,
		port: conn.port,
		database: database || conn.default_database || 'postgres',
		user: conn.credentials.username,
		password: conn.credentials.password,
		ssl: conn.credentials.ssl ? { rejectUnauthorized: false } : undefined,
		connectionTimeoutMillis: 10000,
	};

	const client = new Client(config);

	try {
		await client.connect();
		const result = await client.query(INTROSPECT_QUERY);
		return result.rows as SchemaElement[];
	} finally {
		await client.end();
	}
}

