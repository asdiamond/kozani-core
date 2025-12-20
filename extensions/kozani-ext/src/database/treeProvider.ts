import * as vscode from 'vscode';
import { Connection, ConnectionManager, FullConnection } from './connectionManager';
import * as pg from './pgClient';

// Tree item types for contextValue
type TreeItemType = 'connection' | 'schema' | 'table' | 'view' | 'column';

/**
 * Base class for all database tree items.
 */
abstract class DatabaseTreeItem extends vscode.TreeItem {
	abstract readonly itemType: TreeItemType;
	abstract getChildren(connectionManager: ConnectionManager): Promise<DatabaseTreeItem[]>;
}

/**
 * Root level: a database connection.
 */
export class ConnectionTreeItem extends DatabaseTreeItem {
	readonly itemType = 'connection' as const;

	constructor(public readonly connection: Connection) {
		super(connection.name, vscode.TreeItemCollapsibleState.Collapsed);
		this.tooltip = `${connection.host}:${connection.port}`;
		this.description = connection.host;
		this.contextValue = 'connection';
		this.iconPath = new vscode.ThemeIcon('database');
	}

	async getChildren(connectionManager: ConnectionManager): Promise<DatabaseTreeItem[]> {
		const fullConn = await connectionManager.getFullConnection(this.connection.id);
		if (!fullConn || !fullConn.credentials) {
			vscode.window.showErrorMessage(`No credentials found for connection "${this.connection.name}"`);
			return [];
		}

		try {
			const database = fullConn.default_database || 'postgres';
			const schemas = await pg.listSchemas(fullConn, database);
			return schemas.map(s => new SchemaTreeItem(fullConn, database, s.name));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Failed to connect: ${msg}`);
			return [];
		}
	}
}

/**
 * Schema level (e.g., "public").
 */
class SchemaTreeItem extends DatabaseTreeItem {
	readonly itemType = 'schema' as const;

	constructor(
		private readonly conn: FullConnection,
		private readonly database: string,
		public readonly schemaName: string
	) {
		super(schemaName, vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = 'schema';
		this.iconPath = new vscode.ThemeIcon('symbol-namespace');
	}

	async getChildren(): Promise<DatabaseTreeItem[]> {
		try {
			const items = await pg.listTablesAndViews(this.conn, this.database, this.schemaName);
			return items.map(item =>
				item.type === 'table'
					? new TableTreeItem(this.conn, this.database, this.schemaName, item.name)
					: new ViewTreeItem(this.conn, this.database, this.schemaName, item.name)
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Failed to list tables/views: ${msg}`);
			return [];
		}
	}
}

/**
 * A table within a schema.
 */
export class TableTreeItem extends DatabaseTreeItem {
	readonly itemType = 'table' as const;

	constructor(
		public readonly conn: FullConnection,
		public readonly database: string,
		public readonly schemaName: string,
		public readonly tableName: string
	) {
		super(tableName, vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = 'table';
		this.iconPath = new vscode.ThemeIcon('symbol-class');
		this.tooltip = `${schemaName}.${tableName}`;
	}

	async getChildren(): Promise<DatabaseTreeItem[]> {
		try {
			const columns = await pg.listColumns(this.conn, this.database, this.schemaName, this.tableName);
			return columns.map(c => new ColumnTreeItem(c));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Failed to list columns: ${msg}`);
			return [];
		}
	}
}

/**
 * A view within a schema.
 */
export class ViewTreeItem extends DatabaseTreeItem {
	readonly itemType = 'view' as const;

	constructor(
		public readonly conn: FullConnection,
		public readonly database: string,
		public readonly schemaName: string,
		public readonly viewName: string
	) {
		super(viewName, vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = 'view';
		this.iconPath = new vscode.ThemeIcon('symbol-interface');
		this.tooltip = `${schemaName}.${viewName}`;
	}

	async getChildren(): Promise<DatabaseTreeItem[]> {
		try {
			const columns = await pg.listColumns(this.conn, this.database, this.schemaName, this.viewName);
			return columns.map(c => new ColumnTreeItem(c));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Failed to list columns: ${msg}`);
			return [];
		}
	}
}

/**
 * A column within a table or view (leaf node).
 */
class ColumnTreeItem extends DatabaseTreeItem {
	readonly itemType = 'column' as const;

	constructor(column: pg.ColumnInfo) {
		const label = column.name;
		super(label, vscode.TreeItemCollapsibleState.None);

		this.description = column.type + (column.isPrimaryKey ? ' (PK)' : '');
		this.tooltip = [
			column.name,
			`Type: ${column.type}`,
			`Nullable: ${column.nullable ? 'yes' : 'no'}`,
			column.isPrimaryKey ? 'Primary Key' : null,
			column.defaultValue ? `Default: ${column.defaultValue}` : null
		].filter(Boolean).join('\n');

		this.contextValue = 'column';
		this.iconPath = new vscode.ThemeIcon(
			column.isPrimaryKey ? 'key' : 'symbol-field'
		);
	}

	async getChildren(): Promise<DatabaseTreeItem[]> {
		return []; // Leaf node
	}
}

/**
 * Tree data provider for the database explorer.
 */
export class ConnectionTreeProvider implements vscode.TreeDataProvider<DatabaseTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<DatabaseTreeItem | undefined | null | void>();
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

	getTreeItem(element: DatabaseTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
		if (element) {
			return element.getChildren(this.connectionManager);
		}

		// Root level: list all connections
		const connections = this.connectionManager.getConnections();
		return connections.map(conn => new ConnectionTreeItem(conn));
	}
}
