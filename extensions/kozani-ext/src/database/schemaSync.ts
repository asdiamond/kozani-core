import * as vscode from 'vscode';
import { ConnectionManager, FullConnection } from './connectionManager';
import { introspectDatabase, SchemaElement } from './introspect';
import { upsertSchema } from './api';
import { getGitHubSession } from '../auth';
import { debug, error, warn } from '../debug';
import * as kozaniFolder from './kozaniFolder';

// Re-export for external use
export type { SchemaElement } from './introspect';

/**
 * Convert flat SchemaElement array to SchemaYaml format for a single schema.
 */
function elementsToSchemaYaml(schemaName: string, elements: SchemaElement[]): kozaniFolder.SchemaYaml {
	const tables: Record<string, kozaniFolder.TableYaml> = {};
	const views: Record<string, kozaniFolder.ViewYaml> = {};

	// Group elements by table
	const elementsByTable = new Map<string, SchemaElement[]>();
	for (const el of elements) {
		const key = el.table_name;
		if (!elementsByTable.has(key)) {
			elementsByTable.set(key, []);
		}
		elementsByTable.get(key)!.push(el);
	}

	// Convert each table/view
	for (const [tableName, tableElements] of elementsByTable) {
		const isView = tableElements[0]?.table_type === 'VIEW';

		const columns: kozaniFolder.ColumnYaml[] = tableElements.map(el => ({
			name: el.column_name,
			type: el.data_type,
			nullable: el.is_nullable,
			primary_key: el.is_pk || undefined,
		}));

		// Collect foreign keys
		const foreignKeys: kozaniFolder.ForeignKeyYaml[] = tableElements
			.filter(el => el.fk_reference)
			.map(el => {
				const [refSchema, refTable, refColumn] = el.fk_reference!.split('.');
				return {
					column: el.column_name,
					references: {
						table: refTable,
						column: refColumn,
						schema: refSchema !== schemaName ? refSchema : undefined,
					}
				};
			});

		if (isView) {
			views[tableName] = { columns };
		} else {
			tables[tableName] = {
				columns,
				foreign_keys: foreignKeys.length > 0 ? foreignKeys : undefined,
			};
		}
	}

	return {
		schema: schemaName,
		tables,
		views: Object.keys(views).length > 0 ? views : undefined,
	};
}

/**
 * Write schemas to local YAML files.
 * Returns the number of schemas written.
 */
async function writeLocalSchemas(connectionName: string, elements: SchemaElement[]): Promise<number> {
	// Group elements by schema
	const elementsBySchema = new Map<string, SchemaElement[]>();
	for (const el of elements) {
		if (!elementsBySchema.has(el.table_schema)) {
			elementsBySchema.set(el.table_schema, []);
		}
		elementsBySchema.get(el.table_schema)!.push(el);
	}

	let written = 0;
	for (const [schemaName, schemaElements] of elementsBySchema) {
		// Read existing schema to preserve user descriptions
		const existing = await kozaniFolder.readSchemaYaml(connectionName, schemaName);

		// Convert to YAML format
		const incoming = elementsToSchemaYaml(schemaName, schemaElements);

		// Merge (preserve user descriptions)
		const merged = kozaniFolder.mergeSchemas(existing, incoming);

		// Write
		const success = await kozaniFolder.writeSchemaYaml(connectionName, schemaName, merged);
		if (success) {
			written++;
		}
	}

	return written;
}

/**
 * Syncs schema for a single connection.
 * 1. Writes to local YAML files (always)
 * 2. Syncs to backend for vector search (if authenticated)
 * Returns true if local write succeeded.
 */
async function syncConnectionSchema(conn: FullConnection, token?: string): Promise<boolean> {
	if (!conn.credentials) {
		debug(`Skipping ${conn.name}: no credentials stored`);
		return false;
	}

	const database = conn.default_database || 'postgres';

	try {
		debug(`Introspecting schema for "${conn.name}" (${database})...`);
		const elements = await introspectDatabase(conn, database);

		// Count unique tables for logging
		const tables = new Set(elements.map(e => `${e.table_schema}.${e.table_name}`));
		debug(`Schema for "${conn.name}": ${elements.length} columns across ${tables.size} tables/views`);

		// Step 1: Write to local YAML files (always do this)
		const schemasWritten = await writeLocalSchemas(conn.name, elements);
		debug(`Wrote ${schemasWritten} schema files to .kozani/${conn.name}/schemas/`);

		// Step 2: Sync to backend (optional, only if authenticated)
		if (token) {
			try {
				await upsertSchema(token, conn.name, elements);
				debug(`Schema synced to backend for "${conn.name}"`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				warn(`Backend sync failed for "${conn.name}": ${msg} (local YAML saved successfully)`);
			}
		} else {
			debug(`Skipping backend sync for "${conn.name}": not authenticated`);
		}

		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		error(`Failed to sync schema for "${conn.name}": ${msg}`);
		return false;
	}
}

/**
 * Background job that syncs schemas for all connections with stored credentials.
 * Shows progress in the status bar.
 */
export async function syncAllSchemasInBackground(connectionManager: ConnectionManager): Promise<void> {
	// Get session (optional - we can still write local files without it)
	const session = await getGitHubSession(false);
	const token = session?.accessToken;

	if (!token) {
		debug('No GitHub session, will only write local schema files (no backend sync)');
	}

	const connections = connectionManager.getConnections();

	if (connections.length === 0) {
		debug('No connections to sync');
		return;
	}

	vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Window,
			title: 'Syncing database schemas',
		},
		async (progress) => {
			let synced = 0;
			let failed = 0;

			for (let i = 0; i < connections.length; i++) {
				const conn = connections[i];
				progress.report({
					message: `(${i + 1}/${connections.length}) ${conn.name}`,
				});

				const fullConn = await connectionManager.getFullConnection(conn.name);
				if (!fullConn) {
					failed++;
					continue;
				}

				const success = await syncConnectionSchema(fullConn, token);
				if (success) {
					synced++;
				} else {
					failed++;
				}
			}

			if (synced > 0 || failed > 0) {
				debug(`Schema sync complete: ${synced} synced, ${failed} skipped/failed`);
			}
		}
	);
}

/**
 * Sync schema for a single connection by name.
 * Useful after adding a new connection.
 */
export async function syncConnectionSchemaByName(
	connectionManager: ConnectionManager,
	connectionName: string
): Promise<boolean> {
	const session = await getGitHubSession(false);
	const fullConn = await connectionManager.getFullConnection(connectionName);

	if (!fullConn) {
		warn(`Cannot sync schema: connection "${connectionName}" not found`);
		return false;
	}

	return syncConnectionSchema(fullConn, session?.accessToken);
}
