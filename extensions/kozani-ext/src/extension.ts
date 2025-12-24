import * as vscode from 'vscode';
import { getGitHubSession } from './auth';
import { registerLanguageModelProvider, registerChatParticipant } from './chat';
import { ConnectionManager, ConnectionTreeProvider, ConnectionTreeItem, TableTreeItem, ViewTreeItem, showConnectionForm, syncAllSchemasInBackground } from './database';
import { KozaniNotebookSerializer, KozaniNotebookController } from './notebook';
import { initDebug, debug } from './debug';

console.log('[Kozani] Extension module loaded');

export async function activate(context: vscode.ExtensionContext) {
	// Initialize debug logging (only outputs in development mode)
	initDebug(context);
	debug('Extension activating...');

	registerLanguageModelProvider(context);
	registerChatParticipant(context);

	// Initialize connection manager with local storage
	const connectionManager = new ConnectionManager(context.globalState, context.secrets);
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

	// Load connections from local storage (instant), then sync schemas in background
	await connectionManager.refresh();
	syncAllSchemasInBackground(connectionManager);

	// Commands
	const signInCommand = vscode.commands.registerCommand('kozani-ext.signIn', async () => {
		const session = await getGitHubSession(true);
		if (session) {
			vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
			// Trigger schema sync after sign-in
			syncAllSchemasInBackground(connectionManager);
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
		syncAllSchemasInBackground(connectionManager);
	});

	// New Query command - opens a blank .kozani notebook (in-memory, untitled)
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

	// New Notebook command - creates a .kozani file directly on disk (no OS dialog)
	const newNotebookCommand = vscode.commands.registerCommand('kozani-ext.newNotebook', async (folderUri?: vscode.Uri) => {
		// Determine the target folder
		let targetFolder: vscode.Uri;

		if (folderUri) {
			// Called from explorer context menu with a folder
			targetFolder = folderUri;
		} else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
			// Use workspace root
			targetFolder = vscode.workspace.workspaceFolders[0].uri;
		} else {
			// No workspace - fall back to untitled approach
			vscode.window.showWarningMessage('Open a folder first to create a notebook file.');
			return;
		}

		// Generate a unique filename
		const baseName = 'query';
		const extension = '.kozani';
		let counter = 1;
		let fileUri: vscode.Uri;

		// Find a unique filename
		while (true) {
			const fileName = counter === 1 ? `${baseName}${extension}` : `${baseName}-${counter}${extension}`;
			fileUri = vscode.Uri.joinPath(targetFolder, fileName);
			try {
				await vscode.workspace.fs.stat(fileUri);
				// File exists, try next number
				counter++;
			} catch {
				// File doesn't exist, we can use this name
				break;
			}
		}

		// Create empty notebook content (matches KozaniNotebookSerializer format)
		const notebookContent = JSON.stringify({
			version: 1,
			cells: [
				{
					kind: 'sql',
					value: '-- Write your SQL query here\n'
				}
			]
		}, null, 2);

		// Write the file directly
		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(notebookContent, 'utf8'));

		// Open the created file
		const doc = await vscode.workspace.openNotebookDocument(fileUri);
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
		newNotebookCommand,
		newQueryFromTableCommand
	);

	debug('Extension activated');
}

export function deactivate() {
	debug('Extension deactivated');
}
