import * as vscode from 'vscode';
import { debug, warn} from '../debug';
import * as kozaniFolder from './kozaniFolder';

const CREDENTIALS_PREFIX = 'kozani.conn.';

/**
 * Connection metadata (stored in .kozani/{name}/connection.yaml)
 * Note: `name` is the unique identifier (folder name), no UUID needed
 */
export interface Connection {
	name: string;
	host: string;
	port: number;
	default_database: string | null;
	user: string; // username stored in YAML, password in SecretStorage
}

export interface ConnectionCredentials {
	password: string;
	ssl?: boolean;
}

export interface FullConnection extends Connection {
	credentials?: ConnectionCredentials;
}

export interface CreateConnectionRequest {
	name: string;
	host: string;
	port?: number;
	default_database?: string;
	user: string;
}

export class ConnectionManager {
	private connections: Connection[] = [];
	private readonly _onDidChangeConnections = new vscode.EventEmitter<void>();
	public readonly onDidChangeConnections = this._onDidChangeConnections.event;

	constructor(
		private readonly secrets: vscode.SecretStorage
	) {
		debug('ConnectionManager: Initialized with local-first storage');
	}

	/**
	 * Load all connections from .kozani/ folder
	 */
	async refresh(): Promise<void> {
		debug('ConnectionManager.refresh: Loading connections from .kozani folder');

		const connectionNames = await kozaniFolder.listConnections();
		const connections: Connection[] = [];

		for (const name of connectionNames) {
			const yaml = await kozaniFolder.readConnectionYaml(name);
			if (yaml) {
				connections.push({
					name,
					host: yaml.host,
					port: yaml.port,
					default_database: yaml.database,
					user: yaml.user,
				});
			}
		}

		this.connections = connections;
		debug('ConnectionManager.refresh: Loaded', connections.length, 'connections:', connectionNames);
		this._onDidChangeConnections.fire();
	}

	getConnections(): Connection[] {
		return this.connections;
	}

	/**
	 * Get a connection by name
	 */
	getConnection(connectionName: string): Connection | undefined {
		return this.connections.find(c => c.name === connectionName);
	}

	/**
	 * Get credentials (password) from SecretStorage
	 */
	async getCredentials(connectionName: string): Promise<ConnectionCredentials | undefined> {
		const key = `${CREDENTIALS_PREFIX}${connectionName}`;
		const stored = await this.secrets.get(key);
		if (!stored) {
			debug('ConnectionManager.getCredentials: No credentials found for', connectionName);
			return undefined;
		}
		try {
			return JSON.parse(stored);
		} catch {
			warn('ConnectionManager.getCredentials: Failed to parse credentials for', connectionName);
			return undefined;
		}
	}

	/**
	 * Save credentials (password) to SecretStorage
	 */
	async saveCredentials(connectionName: string, credentials: ConnectionCredentials): Promise<void> {
		const key = `${CREDENTIALS_PREFIX}${connectionName}`;
		await this.secrets.store(key, JSON.stringify(credentials));
		debug('ConnectionManager.saveCredentials: Saved credentials for', connectionName);
	}

	/**
	 * Delete credentials from SecretStorage
	 */
	async deleteCredentials(connectionName: string): Promise<void> {
		const key = `${CREDENTIALS_PREFIX}${connectionName}`;
		await this.secrets.delete(key);
		debug('ConnectionManager.deleteCredentials: Deleted credentials for', connectionName);
	}

	/**
	 * Add a new connection
	 * - Writes connection.yaml to .kozani/{name}/
	 * - Stores password in SecretStorage
	 */
	async addConnection(data: CreateConnectionRequest, password: string): Promise<Connection> {
		debug('ConnectionManager.addConnection: Adding connection', data.name);

		// Check if name already exists
		if (await kozaniFolder.connectionExists(data.name)) {
			throw new Error(`Connection "${data.name}" already exists`);
		}

		// Write connection.yaml
		const yamlConfig: kozaniFolder.ConnectionYaml = {
			host: data.host,
			port: data.port ?? 5432,
			database: data.default_database ?? null,
			user: data.user,
		};

		const success = await kozaniFolder.writeConnectionYaml(data.name, yamlConfig);
		if (!success) {
			throw new Error('Failed to write connection.yaml - is a workspace folder open?');
		}

		// Save password to SecretStorage
		await this.saveCredentials(data.name, { password });

		// Create connection object
		const connection: Connection = {
			name: data.name,
			host: data.host,
			port: data.port ?? 5432,
			default_database: data.default_database ?? null,
			user: data.user,
		};

		this.connections.push(connection);
		this._onDidChangeConnections.fire();

		debug('ConnectionManager.addConnection: Successfully added', data.name);
		return connection;
	}

	/**
	 * Remove a connection
	 * - Deletes .kozani/{name}/ folder
	 * - Removes password from SecretStorage
	 */
	async removeConnection(connectionName: string): Promise<boolean> {
		debug('ConnectionManager.removeConnection: Removing connection', connectionName);

		const index = this.connections.findIndex(c => c.name === connectionName);
		if (index === -1) {
			warn('ConnectionManager.removeConnection: Connection not found', connectionName);
			return false;
		}

		// Delete the folder
		await kozaniFolder.deleteConnectionDir(connectionName);

		// Delete credentials
		await this.deleteCredentials(connectionName);

		// Remove from in-memory list
		this.connections.splice(index, 1);
		this._onDidChangeConnections.fire();

		debug('ConnectionManager.removeConnection: Successfully removed', connectionName);
		return true;
	}

	/**
	 * Get a full connection with credentials
	 */
	async getFullConnection(connectionName: string): Promise<FullConnection | undefined> {
		const connection = this.connections.find(c => c.name === connectionName);
		if (!connection) {
			debug('ConnectionManager.getFullConnection: Connection not found', connectionName);
			return undefined;
		}
		const credentials = await this.getCredentials(connectionName);
		return { ...connection, credentials };
	}

	/**
	 * Update an existing connection
	 * - Updates connection.yaml
	 * - Optionally updates password
	 */
	async updateConnection(
		connectionName: string,
		updates: Partial<Omit<CreateConnectionRequest, 'name'>>,
		newPassword?: string
	): Promise<Connection | undefined> {
		debug('ConnectionManager.updateConnection: Updating connection', connectionName);

		const existing = this.connections.find(c => c.name === connectionName);
		if (!existing) {
			warn('ConnectionManager.updateConnection: Connection not found', connectionName);
			return undefined;
		}

		// Merge updates
		const updated: Connection = {
			...existing,
			host: updates.host ?? existing.host,
			port: updates.port ?? existing.port,
			default_database: updates.default_database ?? existing.default_database,
			user: updates.user ?? existing.user,
		};

		// Write updated YAML
		const yamlConfig: kozaniFolder.ConnectionYaml = {
			host: updated.host,
			port: updated.port,
			database: updated.default_database,
			user: updated.user,
		};

		const success = await kozaniFolder.writeConnectionYaml(connectionName, yamlConfig);
		if (!success) {
			throw new Error('Failed to write connection.yaml');
		}

		// Update password if provided
		if (newPassword !== undefined) {
			await this.saveCredentials(connectionName, { password: newPassword });
		}

		// Update in-memory list
		const index = this.connections.findIndex(c => c.name === connectionName);
		this.connections[index] = updated;
		this._onDidChangeConnections.fire();

		debug('ConnectionManager.updateConnection: Successfully updated', connectionName);
		return updated;
	}

	/**
	 * Rename a connection
	 * - Renames .kozani/{oldName}/ to .kozani/{newName}/
	 * - Moves credentials to new key
	 */
	async renameConnection(oldName: string, newName: string): Promise<boolean> {
		debug('ConnectionManager.renameConnection: Renaming', oldName, 'to', newName);

		if (await kozaniFolder.connectionExists(newName)) {
			throw new Error(`Connection "${newName}" already exists`);
		}

		// Rename folder
		const success = await kozaniFolder.renameConnection(oldName, newName);
		if (!success) {
			return false;
		}

		// Move credentials
		const credentials = await this.getCredentials(oldName);
		if (credentials) {
			await this.saveCredentials(newName, credentials);
			await this.deleteCredentials(oldName);
		}

		// Update in-memory list
		const conn = this.connections.find(c => c.name === oldName);
		if (conn) {
			conn.name = newName;
		}
		this._onDidChangeConnections.fire();

		debug('ConnectionManager.renameConnection: Successfully renamed', oldName, 'to', newName);
		return true;
	}
}
