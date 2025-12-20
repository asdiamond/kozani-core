import * as vscode from 'vscode';
import * as crypto from 'crypto';

const CONNECTIONS_KEY = 'kozani.connections';
const CREDENTIALS_PREFIX = 'kozani.conn.';

export interface Connection {
	id: string;
	name: string;
	host: string;
	port: number;
	default_database: string | null;
}

export interface ConnectionCredentials {
	username: string;
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
}

export class ConnectionManager {
	private connections: Connection[] = [];
	private readonly _onDidChangeConnections = new vscode.EventEmitter<void>();
	public readonly onDidChangeConnections = this._onDidChangeConnections.event;

	constructor(
		private readonly globalState: vscode.Memento,
		private readonly secrets: vscode.SecretStorage
	) { }

	async refresh(): Promise<void> {
		this.connections = this.globalState.get<Connection[]>(CONNECTIONS_KEY, []);
		console.log('[Kozani] Loaded connections from globalState:', JSON.stringify(this.connections, null, 2));
		this._onDidChangeConnections.fire();
	}

	private async saveConnections(): Promise<void> {
		await this.globalState.update(CONNECTIONS_KEY, this.connections);
		this._onDidChangeConnections.fire();
	}

	getConnections(): Connection[] {
		return this.connections;
	}

	async getCredentials(connectionId: string): Promise<ConnectionCredentials | undefined> {
		const key = `${CREDENTIALS_PREFIX}${connectionId}`;
		const stored = await this.secrets.get(key);
		if (!stored) {
			return undefined;
		}
		try {
			return JSON.parse(stored);
		} catch {
			return undefined;
		}
	}

	async saveCredentials(connectionId: string, credentials: ConnectionCredentials): Promise<void> {
		const key = `${CREDENTIALS_PREFIX}${connectionId}`;
		await this.secrets.store(key, JSON.stringify(credentials));
	}

	async deleteCredentials(connectionId: string): Promise<void> {
		const key = `${CREDENTIALS_PREFIX}${connectionId}`;
		await this.secrets.delete(key);
	}

	async addConnection(data: CreateConnectionRequest, credentials: ConnectionCredentials): Promise<Connection> {
		const connection: Connection = {
			id: crypto.randomUUID(),
			name: data.name,
			host: data.host,
			port: data.port ?? 5432,
			default_database: data.default_database ?? null,
		};

		this.connections.push(connection);
		await this.saveConnections();
		await this.saveCredentials(connection.id, credentials);

		return connection;
	}

	async removeConnection(connectionId: string): Promise<boolean> {
		const index = this.connections.findIndex(c => c.id === connectionId);
		if (index === -1) {
			return false;
		}

		this.connections.splice(index, 1);
		await this.saveConnections();
		await this.deleteCredentials(connectionId);

		return true;
	}

	async getFullConnection(connectionId: string): Promise<FullConnection | undefined> {
		const connection = this.connections.find(c => c.id === connectionId);
		if (!connection) {
			return undefined;
		}
		const credentials = await this.getCredentials(connectionId);
		return { ...connection, credentials };
	}
}
