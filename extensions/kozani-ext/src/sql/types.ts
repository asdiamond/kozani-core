/**
 * Types for the SQL Language Service.
 *
 * These wrap the existing schema YAML types from kozaniFolder.ts
 * into a structure optimized for quick lookups during language features.
 */

import type { SchemaYaml, TableYaml, ColumnYaml, ViewYaml } from '../database/kozaniFolder';

// Re-export the YAML types for convenience
export type { SchemaYaml, TableYaml, ColumnYaml, ViewYaml };

/**
 * A table with its fully qualified name for quick lookup.
 */
export interface TableInfo {
	/** Schema name (e.g., 'public') */
	schema: string;
	/** Table name (e.g., 'users') */
	name: string;
	/** Full qualified name (e.g., 'public.users') */
	fullName: string;
	/** User-added description */
	description?: string;
	/** Column definitions */
	columns: ColumnInfo[];
	/** Whether this is a view */
	isView: boolean;
}

/**
 * A column with its parent table info for quick lookup.
 */
export interface ColumnInfo {
	/** Column name (e.g., 'email') */
	name: string;
	/** PostgreSQL type (e.g., 'text', 'integer') */
	type: string;
	/** Whether the column allows NULL */
	nullable: boolean;
	/** Whether this is a primary key column */
	primaryKey: boolean;
	/** User-added description */
	description?: string;
	/** Parent table's full name (e.g., 'public.users') */
	tableName: string;
}

/**
 * Schema data for a single connection, optimized for lookups.
 */
export interface ConnectionSchema {
	/** Connection name (e.g., 'kozani-db') */
	connectionName: string;

	/** All tables indexed by full name (e.g., 'public.users') */
	tablesByFullName: Map<string, TableInfo>;

	/** All tables indexed by short name (e.g., 'users') - may have collisions */
	tablesByName: Map<string, TableInfo[]>;

	/** All columns indexed by name (e.g., 'email') - may have collisions */
	columnsByName: Map<string, ColumnInfo[]>;
}

/**
 * Convert raw YAML schema data into optimized ConnectionSchema.
 */
export function buildConnectionSchema(connectionName: string, schemas: SchemaYaml[]): ConnectionSchema {
	const tablesByFullName = new Map<string, TableInfo>();
	const tablesByName = new Map<string, TableInfo[]>();
	const columnsByName = new Map<string, ColumnInfo[]>();

	for (const schemaYaml of schemas) {
		const schemaName = schemaYaml.schema;

		// Process tables
		for (const [tableName, tableYaml] of Object.entries(schemaYaml.tables || {})) {
			const tableInfo = buildTableInfo(schemaName, tableName, tableYaml, false);
			addTable(tableInfo, tablesByFullName, tablesByName, columnsByName);
		}

		// Process views
		for (const [viewName, viewYaml] of Object.entries(schemaYaml.views || {})) {
			const tableInfo = buildTableInfo(schemaName, viewName, viewYaml, true);
			addTable(tableInfo, tablesByFullName, tablesByName, columnsByName);
		}
	}

	return {
		connectionName,
		tablesByFullName,
		tablesByName,
		columnsByName,
	};
}

function buildTableInfo(
	schemaName: string,
	tableName: string,
	yaml: TableYaml | ViewYaml,
	isView: boolean
): TableInfo {
	const fullName = `${schemaName}.${tableName}`;
	const columns: ColumnInfo[] = (yaml.columns || []).map(col => ({
		name: col.name,
		type: col.type,
		nullable: col.nullable ?? true,
		primaryKey: col.primary_key ?? false,
		description: col.description,
		tableName: fullName,
	}));

	return {
		schema: schemaName,
		name: tableName,
		fullName,
		description: yaml.description,
		columns,
		isView,
	};
}

function addTable(
	table: TableInfo,
	tablesByFullName: Map<string, TableInfo>,
	tablesByName: Map<string, TableInfo[]>,
	columnsByName: Map<string, ColumnInfo[]>
): void {
	// Index by full name (unique)
	tablesByFullName.set(table.fullName, table);

	// Index by short name (may have collisions across schemas)
	const existing = tablesByName.get(table.name) || [];
	existing.push(table);
	tablesByName.set(table.name, existing);

	// Index columns by name (for quick lookup)
	for (const col of table.columns) {
		const existingCols = columnsByName.get(col.name) || [];
		existingCols.push(col);
		columnsByName.set(col.name, existingCols);
	}
}

