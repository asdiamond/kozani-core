import * as vscode from 'vscode';
import { getGitHubSession } from '../auth';
import { Connection, CreateConnectionRequest, createConnection, deleteConnection, fetchConnections } from './api';

const CREDENTIALS_PREFIX = 'kozani.conn.';

export interface ConnectionCredentials {
	username: string;
	password: string;
	ssl?: boolean;
}

export interface FullConnection extends Connection {
	credentials?: ConnectionCredentials;
}

export class ConnectionManager {
	private connections: Connection[] = [];
	private readonly _onDidChangeConnections = new vscode.EventEmitter<void>();
	public readonly onDidChangeConnections = this._onDidChangeConnections.event;

	constructor(private readonly secrets: vscode.SecretStorage) { }

	async refresh(): Promise<void> {
		const session = await getGitHubSession(false);
		if (!session) {
			this.connections = [];
			this._onDidChangeConnections.fire();
			return;
		}

		try {
			this.connections = await fetchConnections(session.accessToken);
			this._onDidChangeConnections.fire();
		} catch (error) {
			console.error('[Kozani] Failed to fetch connections:', error);
			vscode.window.showErrorMessage('Failed to fetch database connections');
		}
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

	async addConnection(data: CreateConnectionRequest, credentials: ConnectionCredentials): Promise<Connection | undefined> {
		const session = await getGitHubSession(true);
		if (!session) {
			vscode.window.showErrorMessage('Please sign in to add a connection');
			return undefined;
		}

		try {
			const connection = await createConnection(session.accessToken, data);
			await this.saveCredentials(connection.id, credentials);
			await this.refresh();
			return connection;
		} catch (error) {
			console.error('[Kozani] Failed to create connection:', error);
			vscode.window.showErrorMessage('Failed to create database connection');
			return undefined;
		}
	}

	async removeConnection(connectionId: string): Promise<boolean> {
		const session = await getGitHubSession(false);
		if (!session) {
			vscode.window.showErrorMessage('Please sign in to remove a connection');
			return false;
		}

		try {
			await deleteConnection(session.accessToken, connectionId);
			await this.deleteCredentials(connectionId);
			await this.refresh();
			return true;
		} catch (error) {
			console.error('[Kozani] Failed to delete connection:', error);
			vscode.window.showErrorMessage('Failed to delete database connection');
			return false;
		}
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
