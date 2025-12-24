import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { debug, warn, error } from '../debug';

// Folder name for Kozani workspace config
const KOZANI_DIR = '.kozani';

// ---------------------------------------------------------------------------
// Types for YAML file contents
// ---------------------------------------------------------------------------

/**
 * Connection metadata stored in connection.yaml (no credentials!)
 */
export interface ConnectionYaml {
	host: string;
	port: number;
	database: string | null;
	user: string;
}

/**
 * Column definition in schema YAML
 */
export interface ColumnYaml {
	name: string;
	type: string;
	nullable?: boolean;
	primary_key?: boolean;
	description?: string; // user-added, preserved on sync
}

/**
 * Foreign key definition in schema YAML
 */
export interface ForeignKeyYaml {
	column: string;
	references: {
		table: string;
		column: string;
		schema?: string;
	};
}

/**
 * Table definition in schema YAML
 */
export interface TableYaml {
	description?: string; // user-added, preserved on sync
	columns: ColumnYaml[];
	foreign_keys?: ForeignKeyYaml[];
}

/**
 * View definition in schema YAML
 */
export interface ViewYaml {
	description?: string;
	columns: ColumnYaml[];
}

/**
 * Schema YAML file structure (one per database schema like "public")
 */
export interface SchemaYaml {
	schema: string;
	tables: Record<string, TableYaml>;
	views?: Record<string, ViewYaml>;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get the workspace root folder path.
 * Returns null if no workspace is open.
 */
export function getWorkspaceRoot(): string | null {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		debug('getWorkspaceRoot: No workspace folder open');
		return null;
	}
	return folder.uri.fsPath;
}

/**
 * Get the path to the .kozani directory in the workspace.
 * Returns null if no workspace is open.
 */
export function getKozaniDir(): string | null {
	const root = getWorkspaceRoot();
	if (!root) {
		return null;
	}
	return path.join(root, KOZANI_DIR);
}

/**
 * Get the path to a specific connection's directory.
 * e.g., .kozani/prod-analytics/
 */
export function getConnectionDir(connectionName: string): string | null {
	const kozaniDir = getKozaniDir();
	if (!kozaniDir) {
		return null;
	}
	return path.join(kozaniDir, connectionName);
}

/**
 * Get the path to a connection's connection.yaml file.
 */
export function getConnectionYamlPath(connectionName: string): string | null {
	const connDir = getConnectionDir(connectionName);
	if (!connDir) {
		return null;
	}
	return path.join(connDir, 'connection.yaml');
}

/**
 * Get the path to a connection's schemas directory.
 * e.g., .kozani/prod-analytics/schemas/
 */
export function getSchemasDir(connectionName: string): string | null {
	const connDir = getConnectionDir(connectionName);
	if (!connDir) {
		return null;
	}
	return path.join(connDir, 'schemas');
}

/**
 * Get the path to a specific schema's YAML file.
 * e.g., .kozani/prod-analytics/schemas/public.yaml
 */
export function getSchemaYamlPath(connectionName: string, schemaName: string): string | null {
	const schemasDir = getSchemasDir(connectionName);
	if (!schemasDir) {
		return null;
	}
	return path.join(schemasDir, `${schemaName}.yaml`);
}

// ---------------------------------------------------------------------------
// Directory operations
// ---------------------------------------------------------------------------

/**
 * Ensure the .kozani directory exists in the workspace.
 * Creates it if it doesn't exist.
 * Returns the path or null if no workspace is open.
 */
export async function ensureKozaniDir(): Promise<string | null> {
	const kozaniDir = getKozaniDir();
	if (!kozaniDir) {
		warn('ensureKozaniDir: No workspace folder open');
		return null;
	}

	try {
		await fs.promises.mkdir(kozaniDir, { recursive: true });
		debug('ensureKozaniDir: Ensured directory exists:', kozaniDir);
		return kozaniDir;
	} catch (err) {
		error('ensureKozaniDir: Failed to create directory:', err);
		return null;
	}
}

/**
 * Ensure a connection's directory structure exists.
 * Creates .kozani/{connectionName}/ and .kozani/{connectionName}/schemas/
 */
export async function ensureConnectionDir(connectionName: string): Promise<string | null> {
	const connDir = getConnectionDir(connectionName);
	if (!connDir) {
		warn('ensureConnectionDir: No workspace folder open');
		return null;
	}

	try {
		// Create both the connection dir and schemas subdir
		const schemasDir = path.join(connDir, 'schemas');
		await fs.promises.mkdir(schemasDir, { recursive: true });
		debug('ensureConnectionDir: Ensured directories exist:', connDir);
		return connDir;
	} catch (err) {
		error('ensureConnectionDir: Failed to create directories:', err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Connection YAML operations
// ---------------------------------------------------------------------------

/**
 * Read a connection.yaml file for a given connection name.
 * Returns null if file doesn't exist or can't be parsed.
 */
export async function readConnectionYaml(connectionName: string): Promise<ConnectionYaml | null> {
	const yamlPath = getConnectionYamlPath(connectionName);
	if (!yamlPath) {
		return null;
	}

	try {
		const content = await fs.promises.readFile(yamlPath, 'utf8');
		const parsed = YAML.parse(content) as ConnectionYaml;
		debug('readConnectionYaml: Loaded', connectionName, parsed);
		return parsed;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			debug('readConnectionYaml: File not found for', connectionName);
		} else {
			error('readConnectionYaml: Error reading', connectionName, err);
		}
		return null;
	}
}

/**
 * Write a connection.yaml file for a given connection name.
 * Creates the connection directory if it doesn't exist.
 */
export async function writeConnectionYaml(connectionName: string, config: ConnectionYaml): Promise<boolean> {
	const yamlPath = getConnectionYamlPath(connectionName);
	if (!yamlPath) {
		warn('writeConnectionYaml: No workspace folder open');
		return false;
	}

	try {
		// Ensure directory exists
		await ensureConnectionDir(connectionName);

		// Write YAML with nice formatting
		const yamlContent = YAML.stringify(config, { indent: 2 });
		await fs.promises.writeFile(yamlPath, yamlContent, 'utf8');
		debug('writeConnectionYaml: Wrote', connectionName, 'to', yamlPath);
		return true;
	} catch (err) {
		error('writeConnectionYaml: Failed to write', connectionName, err);
		return false;
	}
}

/**
 * Delete a connection's entire directory (connection.yaml + schemas/).
 */
export async function deleteConnectionDir(connectionName: string): Promise<boolean> {
	const connDir = getConnectionDir(connectionName);
	if (!connDir) {
		return false;
	}

	try {
		await fs.promises.rm(connDir, { recursive: true, force: true });
		debug('deleteConnectionDir: Deleted', connectionName);
		return true;
	} catch (err) {
		error('deleteConnectionDir: Failed to delete', connectionName, err);
		return false;
	}
}

/**
 * List all connection names in the .kozani directory.
 * Returns folder names that contain a connection.yaml file.
 */
export async function listConnections(): Promise<string[]> {
	const kozaniDir = getKozaniDir();
	if (!kozaniDir) {
		return [];
	}

	try {
		const entries = await fs.promises.readdir(kozaniDir, { withFileTypes: true });
		const connections: string[] = [];

		for (const entry of entries) {
			if (entry.isDirectory()) {
				// Check if this directory has a connection.yaml
				const connYamlPath = path.join(kozaniDir, entry.name, 'connection.yaml');
				try {
					await fs.promises.access(connYamlPath);
					connections.push(entry.name);
				} catch {
					// No connection.yaml, skip this directory
				}
			}
		}

		debug('listConnections: Found', connections.length, 'connections:', connections);
		return connections;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			debug('listConnections: .kozani directory does not exist yet');
		} else {
			error('listConnections: Error reading .kozani directory:', err);
		}
		return [];
	}
}

// ---------------------------------------------------------------------------
// Schema YAML operations
// ---------------------------------------------------------------------------

/**
 * Read a schema YAML file.
 * Returns null if file doesn't exist or can't be parsed.
 */
export async function readSchemaYaml(connectionName: string, schemaName: string): Promise<SchemaYaml | null> {
	const yamlPath = getSchemaYamlPath(connectionName, schemaName);
	if (!yamlPath) {
		return null;
	}

	try {
		const content = await fs.promises.readFile(yamlPath, 'utf8');
		const parsed = YAML.parse(content) as SchemaYaml;
		debug('readSchemaYaml: Loaded', connectionName, '/', schemaName);
		return parsed;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			debug('readSchemaYaml: File not found for', connectionName, '/', schemaName);
		} else {
			error('readSchemaYaml: Error reading', connectionName, '/', schemaName, err);
		}
		return null;
	}
}

/**
 * Write a schema YAML file.
 * Creates the schemas directory if it doesn't exist.
 */
export async function writeSchemaYaml(connectionName: string, schemaName: string, schema: SchemaYaml): Promise<boolean> {
	const yamlPath = getSchemaYamlPath(connectionName, schemaName);
	if (!yamlPath) {
		warn('writeSchemaYaml: No workspace folder open');
		return false;
	}

	try {
		// Ensure directories exist
		await ensureConnectionDir(connectionName);

		// Write YAML with nice formatting
		const yamlContent = YAML.stringify(schema, { indent: 2 });
		await fs.promises.writeFile(yamlPath, yamlContent, 'utf8');
		debug('writeSchemaYaml: Wrote', connectionName, '/', schemaName, 'to', yamlPath);
		return true;
	} catch (err) {
		error('writeSchemaYaml: Failed to write', connectionName, '/', schemaName, err);
		return false;
	}
}

/**
 * List all schema names for a connection.
 * Returns schema names (without .yaml extension).
 */
export async function listSchemas(connectionName: string): Promise<string[]> {
	const schemasDir = getSchemasDir(connectionName);
	if (!schemasDir) {
		return [];
	}

	try {
		const entries = await fs.promises.readdir(schemasDir, { withFileTypes: true });
		const schemas: string[] = [];

		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.yaml')) {
				schemas.push(entry.name.replace(/\.yaml$/, ''));
			}
		}

		debug('listSchemas: Found', schemas.length, 'schemas for', connectionName, ':', schemas);
		return schemas;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			debug('listSchemas: schemas directory does not exist for', connectionName);
		} else {
			error('listSchemas: Error reading schemas for', connectionName, err);
		}
		return [];
	}
}

/**
 * Delete a specific schema YAML file.
 */
export async function deleteSchemaYaml(connectionName: string, schemaName: string): Promise<boolean> {
	const yamlPath = getSchemaYamlPath(connectionName, schemaName);
	if (!yamlPath) {
		return false;
	}

	try {
		await fs.promises.unlink(yamlPath);
		debug('deleteSchemaYaml: Deleted', connectionName, '/', schemaName);
		return true;
	} catch (err) {
		error('deleteSchemaYaml: Failed to delete', connectionName, '/', schemaName, err);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Schema merge utilities (preserve user descriptions on sync)
// ---------------------------------------------------------------------------

/**
 * Merge a new schema with an existing one, preserving user-added descriptions.
 * Used when refreshing schema from database - keeps any descriptions users added.
 */
export function mergeSchemas(existing: SchemaYaml | null, incoming: SchemaYaml): SchemaYaml {
	if (!existing) {
		debug('mergeSchemas: No existing schema, using incoming as-is');
		return incoming;
	}

	const merged: SchemaYaml = {
		schema: incoming.schema,
		tables: {},
		views: {},
	};

	// Merge tables
	for (const [tableName, incomingTable] of Object.entries(incoming.tables)) {
		const existingTable = existing.tables[tableName];

		if (!existingTable) {
			merged.tables[tableName] = incomingTable;
			continue;
		}

		// Preserve table-level description
		merged.tables[tableName] = {
			...incomingTable,
			description: existingTable.description || incomingTable.description,
			columns: incomingTable.columns.map(col => {
				const existingCol = existingTable.columns.find(c => c.name === col.name);
				return {
					...col,
					description: existingCol?.description || col.description,
				};
			}),
		};
	}

	// Merge views
	if (incoming.views) {
		for (const [viewName, incomingView] of Object.entries(incoming.views)) {
			const existingView = existing.views?.[viewName];

			if (!existingView) {
				merged.views![viewName] = incomingView;
				continue;
			}

			merged.views![viewName] = {
				...incomingView,
				description: existingView.description || incomingView.description,
				columns: incomingView.columns.map(col => {
					const existingCol = existingView.columns.find(c => c.name === col.name);
					return {
						...col,
						description: existingCol?.description || col.description,
					};
				}),
			};
		}
	}

	debug('mergeSchemas: Merged schema for', incoming.schema, 'preserving descriptions');
	return merged;
}

/**
 * Check if a connection exists (has a connection.yaml file).
 */
export async function connectionExists(connectionName: string): Promise<boolean> {
	const yamlPath = getConnectionYamlPath(connectionName);
	if (!yamlPath) {
		return false;
	}

	try {
		await fs.promises.access(yamlPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Rename a connection by moving its directory.
 */
export async function renameConnection(oldName: string, newName: string): Promise<boolean> {
	const oldDir = getConnectionDir(oldName);
	const newDir = getConnectionDir(newName);

	if (!oldDir || !newDir) {
		warn('renameConnection: No workspace folder open');
		return false;
	}

	try {
		await fs.promises.rename(oldDir, newDir);
		debug('renameConnection: Renamed', oldName, 'to', newName);
		return true;
	} catch (err) {
		error('renameConnection: Failed to rename', oldName, 'to', newName, err);
		return false;
	}
}

