import * as vscode from 'vscode';
import { ConnectionManager, FullConnection } from './connectionManager';
import { introspectDatabase, SchemaElement } from './introspect';
import { upsertSchema } from './api';
import { getGitHubSession } from '../auth';
import { debug, error } from '../debug';

// Re-export for external use
export type { SchemaElement } from './introspect';

/**
 * Syncs schema for a single connection.
 * Returns true if successful, false otherwise.
 */
async function syncConnectionSchema(conn: FullConnection, token: string): Promise<boolean> {
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

		await upsertSchema(token, conn.id, elements);
		debug(`Schema synced to backend for "${conn.name}"`);

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
	const session = await getGitHubSession(false);
	if (!session) {
		debug('No GitHub session, skipping schema sync');
		return;
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

				const fullConn = await connectionManager.getFullConnection(conn.id);
				if (!fullConn) {
					failed++;
					continue;
				}

				const success = await syncConnectionSchema(fullConn, session.accessToken);
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
