import * as vscode from 'vscode';
import { ConnectionManager, FullConnection } from './connectionManager';
import * as pg from './pgClient';

/**
 * Schema data structure for AI context (matches backend JSONB format).
 */
export interface SchemaData {
	schemas: {
		[schemaName: string]: {
			tables: {
				[tableName: string]: {
					type: 'table' | 'view';
					columns: Array<{
						name: string;
						type: string;
						nullable: boolean;
						pk: boolean;
					}>;
				};
			};
		};
	};
}

/**
 * Introspects a single database and returns the full schema structure.
 */
async function introspectDatabase(conn: FullConnection, database: string): Promise<SchemaData> {
	const schemaData: SchemaData = { schemas: {} };

	const schemas = await pg.listSchemas(conn, database);

	for (const schema of schemas) {
		schemaData.schemas[schema.name] = { tables: {} };

		const tablesAndViews = await pg.listTablesAndViews(conn, database, schema.name);

		for (const item of tablesAndViews) {
			const columns = await pg.listColumns(conn, database, schema.name, item.name);

			schemaData.schemas[schema.name].tables[item.name] = {
				type: item.type,
				columns: columns.map(col => ({
					name: col.name,
					type: col.type,
					nullable: col.nullable,
					pk: col.isPrimaryKey,
				})),
			};
		}
	}

	return schemaData;
}

/**
 * Syncs schema for a single connection.
 * Returns true if successful, false otherwise.
 */
async function syncConnectionSchema(conn: FullConnection): Promise<boolean> {
	if (!conn.credentials) {
		console.log(`[Kozani] Skipping ${conn.name}: no credentials stored`);
		return false;
	}

	const database = conn.default_database || 'postgres';

	try {
		console.log(`[Kozani] Introspecting schema for "${conn.name}" (${database})...`);
		const schemaData = await introspectDatabase(conn, database);

		// For now, just print it out
		const tableCount = Object.values(schemaData.schemas)
			.flatMap(s => Object.keys(s.tables))
			.length;
		const schemaCount = Object.keys(schemaData.schemas).length;

		console.log(`[Kozani] Schema for "${conn.name}": ${schemaCount} schemas, ${tableCount} tables/views`);
		console.log(`[Kozani] Schema data:`, JSON.stringify(schemaData, null, 2));

		// TODO: POST to backend /api/connections/{id}/schema
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[Kozani] Failed to sync schema for "${conn.name}": ${msg}`);
		return false;
	}
}

/**
 * Background job that syncs schemas for all connections with stored credentials.
 * Shows progress in the status bar.
 */
export function syncAllSchemasInBackground(connectionManager: ConnectionManager): void {
	const connections = connectionManager.getConnections();

	if (connections.length === 0) {
		console.log('[Kozani] No connections to sync');
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

				const fullConn = await connectionManager.getFullConnection(conn.id);
				if (!fullConn) {
					failed++;
					continue;
				}

				const success = await syncConnectionSchema(fullConn);
				if (success) {
					synced++;
				} else {
					failed++;
				}
			}

			if (synced > 0 || failed > 0) {
				console.log(`[Kozani] Schema sync complete: ${synced} synced, ${failed} skipped/failed`);
			}
		}
	);
}
