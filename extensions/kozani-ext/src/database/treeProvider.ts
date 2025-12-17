import * as vscode from 'vscode';
import { Connection } from './api';
import { ConnectionManager } from './connectionManager';

export class ConnectionTreeItem extends vscode.TreeItem {
	constructor(
		public readonly connection: Connection,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState
	) {
		super(connection.name, collapsibleState);
		this.tooltip = `${connection.host}:${connection.port}`;
		this.description = connection.host;
		this.contextValue = 'connection';
		this.iconPath = new vscode.ThemeIcon('database');
	}
}

export class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<ConnectionTreeItem | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly connectionManager: ConnectionManager) {
		// Refresh tree when connections change
		connectionManager.onDidChangeConnections(() => {
			this._onDidChangeTreeData.fire();
		});
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: ConnectionTreeItem): Thenable<ConnectionTreeItem[]> {
		if (element) {
			// For now, connections don't have children
			// Later we can add databases/schemas/tables here
			return Promise.resolve([]);
		}

		// Root level: list all connections
		const connections = this.connectionManager.getConnections();
		return Promise.resolve(
			connections.map(conn => new ConnectionTreeItem(conn, vscode.TreeItemCollapsibleState.None))
		);
	}
}
