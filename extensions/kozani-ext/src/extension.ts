import * as vscode from 'vscode';
import { getGitHubSession } from './auth';
import { registerLanguageModelProvider, registerChatParticipant } from './chat';
import { ConnectionManager, ConnectionTreeProvider, ConnectionTreeItem, showConnectionForm, syncAllSchemasInBackground } from './database';

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

	context.subscriptions.push(
		signInCommand,
		addConnectionCommand,
		removeConnectionCommand,
		refreshConnectionsCommand
	);

	console.log('[Kozani] Extension activated');
}

export function deactivate() {
	console.log('[Kozani] Extension deactivated');
}
