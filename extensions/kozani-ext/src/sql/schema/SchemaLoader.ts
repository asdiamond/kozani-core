/**
 * SchemaLoader - Loads and caches schema data from .kozani/ YAML files.
 *
 * Wraps the existing kozaniFolder.ts functions with caching for
 * efficient lookups during language service operations.
 */

import * as vscode from 'vscode';
import { listSchemas, readSchemaYaml, type SchemaYaml } from '../../database/kozaniFolder';
import { buildConnectionSchema, type ConnectionSchema } from '../types';
import { debug } from '../../debug';

export class SchemaLoader {
	/** Cache of loaded schemas by connection name */
	private cache = new Map<string, ConnectionSchema>();

	/** File watcher for schema YAML changes */
	private watcher: vscode.FileSystemWatcher | undefined;

	/** Disposables for cleanup */
	private disposables: vscode.Disposable[] = [];

	constructor() {
		this.setupFileWatcher();
	}

	/**
	 * Get schema for a connection, loading from YAML if not cached.
	 */
	async getSchema(connectionName: string): Promise<ConnectionSchema | undefined> {
		// Return from cache if available
		if (this.cache.has(connectionName)) {
			return this.cache.get(connectionName);
		}

		// Load from YAML files
		const schema = await this.loadSchema(connectionName);
		if (schema) {
			this.cache.set(connectionName, schema);
			debug(`SchemaLoader: Cached schema for "${connectionName}" (${schema.tablesByFullName.size} tables)`);
		}

		return schema;
	}

	/**
	 * Invalidate cache for a specific connection or all connections.
	 */
	invalidate(connectionName?: string): void {
		if (connectionName) {
			this.cache.delete(connectionName);
			debug(`SchemaLoader: Invalidated cache for "${connectionName}"`);
		} else {
			this.cache.clear();
			debug('SchemaLoader: Invalidated all cached schemas');
		}
	}

	/**
	 * Load schema from .kozani/{connectionName}/schemas/*.yaml files.
	 */
	private async loadSchema(connectionName: string): Promise<ConnectionSchema | undefined> {
		try {
			// Get list of schema files (e.g., 'public', 'auth')
			const schemaNames = await listSchemas(connectionName);
			if (schemaNames.length === 0) {
				debug(`SchemaLoader: No schema files found for "${connectionName}"`);
				return undefined;
			}

			// Load each schema YAML file
			const schemas: SchemaYaml[] = [];
			for (const schemaName of schemaNames) {
				const schemaYaml = await readSchemaYaml(connectionName, schemaName);
				if (schemaYaml) {
					schemas.push(schemaYaml);
				}
			}

			if (schemas.length === 0) {
				debug(`SchemaLoader: Failed to load any schemas for "${connectionName}"`);
				return undefined;
			}

			// Build optimized schema structure
			return buildConnectionSchema(connectionName, schemas);
		} catch (err) {
			debug(`SchemaLoader: Error loading schema for "${connectionName}":`, err);
			return undefined;
		}
	}

	/**
	 * Set up file watcher to invalidate cache when YAML files change.
	 */
	private setupFileWatcher(): void {
		// Watch for changes to schema YAML files
		this.watcher = vscode.workspace.createFileSystemWatcher('**/.kozani/**/schemas/*.yaml');

		this.watcher.onDidChange((uri) => {
			const connectionName = this.extractConnectionName(uri);
			if (connectionName) {
				this.invalidate(connectionName);
			}
		});

		this.watcher.onDidCreate((uri) => {
			const connectionName = this.extractConnectionName(uri);
			if (connectionName) {
				this.invalidate(connectionName);
			}
		});

		this.watcher.onDidDelete((uri) => {
			const connectionName = this.extractConnectionName(uri);
			if (connectionName) {
				this.invalidate(connectionName);
			}
		});

		this.disposables.push(this.watcher);
	}

	/**
	 * Extract connection name from a schema YAML file path.
	 * Path format: .../.kozani/{connectionName}/schemas/{schemaName}.yaml
	 */
	private extractConnectionName(uri: vscode.Uri): string | undefined {
		const path = uri.fsPath;
		const match = path.match(/\.kozani[/\\]([^/\\]+)[/\\]schemas[/\\]/);
		return match?.[1];
	}

	/**
	 * Dispose of resources.
	 */
	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
		this.cache.clear();
	}
}

