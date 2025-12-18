import * as vscode from 'vscode';
import { getGitHubSession } from './auth';
import { registerLanguageModelProvider, registerChatParticipant } from './chat';
import { ConnectionManager, ConnectionTreeProvider, ConnectionTreeItem, TableTreeItem, ViewTreeItem, showConnectionForm, syncAllSchemasInBackground } from './database';
import { KozaniNotebookSerializer, KozaniNotebookController } from './notebook';

console.log('[Kozani] Extension module loaded');

export async function activate(context: vscode.ExtensionContext) {
	console.log('[Kozani] Extension activating...');

	registerLanguageModelProvider(context);
	registerChatParticipant(context);

	// Initialize connection manager and tree view
	const connectionManager = new ConnectionManager(context.secrets);
	const treeProvider = new ConnectionTreeProvider(connectionManager);

	const treeView = vscode.window.createTreeView('kozani.connections', {
		treeDataProvider: treeProvider,
		showCollapseAll: false
	});
	context.subscriptions.push(treeView);

	// Register notebook serializer and controller
	const notebookSerializer = new KozaniNotebookSerializer();
	const notebookController = new KozaniNotebookController(connectionManager);

	context.subscriptions.push(
		vscode.workspace.registerNotebookSerializer('kozani-notebook', notebookSerializer),
		notebookController
	);

	// Initial load of connections, then sync schemas in background
	connectionManager.refresh().then(() => {
		syncAllSchemasInBackground(connectionManager);
	});

	// Commands
	const signInCommand = vscode.commands.registerCommand('kozani-ext.signIn', async () => {
		const session = await getGitHubSession(true);
		if (session) {
			vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
			await connectionManager.refresh();
		}
	});

	const addConnectionCommand = vscode.commands.registerCommand('kozani-ext.addConnection', () => {
		showConnectionForm(connectionManager);
	});

	const removeConnectionCommand = vscode.commands.registerCommand('kozani-ext.removeConnection', async (item: ConnectionTreeItem) => {
		if (!item) { return; }

		const confirm = await vscode.window.showWarningMessage(
			`Remove connection "${item.connection.name}"?`,
			{ modal: true },
			'Remove'
		);

		if (confirm === 'Remove') {
			const success = await connectionManager.removeConnection(item.connection.id);
			if (success) {
				vscode.window.showInformationMessage(`Connection "${item.connection.name}" removed`);
			}
		}
	});

	const refreshConnectionsCommand = vscode.commands.registerCommand('kozani-ext.refreshConnections', async () => {
		await connectionManager.refresh();
	});

	// New Query command - opens a blank .kozani notebook
	const newQueryCommand = vscode.commands.registerCommand('kozani-ext.newQuery', async (item: ConnectionTreeItem) => {
		const connectionId = item?.connection?.id;

		// Create notebook with a starter cell (non-empty to help VSCode initialize text models)
		const notebookData = new vscode.NotebookData([
			new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '-- Write your SQL query here\n', 'sql')
		]);

		if (connectionId) {
			notebookData.metadata = { connectionId };
		}

		const doc = await vscode.workspace.openNotebookDocument('kozani-notebook', notebookData);
		await vscode.window.showNotebookDocument(doc);
	});

	// New Query from Table - opens a notebook with SELECT * FROM table
	const newQueryFromTableCommand = vscode.commands.registerCommand('kozani-ext.newQueryFromTable', async (item: TableTreeItem | ViewTreeItem) => {
		if (!item) { return; }

		const tableName = item.itemType === 'table' ? item.tableName : item.viewName;
		const sql = `SELECT * FROM ${item.schemaName}.${tableName}\nLIMIT 100;`;

		const notebookData = new vscode.NotebookData([
			new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql, 'sql')
		]);

		notebookData.metadata = {
			connectionId: item.conn.id,
			database: item.database
		};

		const doc = await vscode.workspace.openNotebookDocument('kozani-notebook', notebookData);
		await vscode.window.showNotebookDocument(doc);
	});

	context.subscriptions.push(
		signInCommand,
		addConnectionCommand,
		removeConnectionCommand,
		refreshConnectionsCommand,
		newQueryCommand,
		newQueryFromTableCommand
	);

	console.log('[Kozani] Extension activated');
}

export function deactivate() {
	console.log('[Kozani] Extension deactivated');
}
