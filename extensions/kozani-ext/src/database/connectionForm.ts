import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { syncConnectionSchemaByName } from './schemaSync';

/**
 * Prompts the user to enter connection details using native VS Code quick inputs.
 * Each input stays open when VS Code loses focus (so you can switch to a password manager).
 */
export async function showConnectionForm(connectionManager: ConnectionManager): Promise<void> {
	// Step 1: Connection name
	const name = await vscode.window.showInputBox({
		title: 'New Connection (1/6)',
		prompt: 'Connection name',
		placeHolder: 'My Database',
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (!value.trim()) {
				return 'Connection name is required';
			}
			return undefined;
		}
	});
	if (name === undefined) {
		return; // cancelled
	}

	// Step 2: Host
	const host = await vscode.window.showInputBox({
		title: 'New Connection (2/6)',
		prompt: 'Host',
		placeHolder: 'localhost',
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (!value.trim()) {
				return 'Host is required';
			}
			return undefined;
		}
	});
	if (host === undefined) {
		return;
	}

	// Step 3: Port
	const portStr = await vscode.window.showInputBox({
		title: 'New Connection (3/6)',
		prompt: 'Port',
		value: '5432',
		placeHolder: '5432',
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (!value.trim()) {
				return undefined; // will use default
			}
			const num = parseInt(value, 10);
			if (isNaN(num) || num < 1 || num > 65535) {
				return 'Port must be a number between 1 and 65535';
			}
			return undefined;
		}
	});
	if (portStr === undefined) {
		return;
	}
	const port = parseInt(portStr, 10) || 5432;

	// Step 4: Database
	const database = await vscode.window.showInputBox({
		title: 'New Connection (4/6)',
		prompt: 'Default database (optional)',
		placeHolder: 'postgres',
		ignoreFocusOut: true
	});
	if (database === undefined) {
		return;
	}

	// Step 5: Username
	const username = await vscode.window.showInputBox({
		title: 'New Connection (5/6)',
		prompt: 'Username',
		placeHolder: 'postgres',
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (!value.trim()) {
				return 'Username is required';
			}
			return undefined;
		}
	});
	if (username === undefined) {
		return;
	}

	// Step 6: Password
	const password = await vscode.window.showInputBox({
		title: 'New Connection (6/6)',
		prompt: 'Password (stored in system keychain)',
		placeHolder: '••••••••',
		password: true,
		ignoreFocusOut: true
	});
	if (password === undefined) {
		return;
	}

	// Create the connection
	try {
		const connection = await connectionManager.addConnection(
			{
				name: name.trim(),
				host: host.trim(),
				port,
				default_database: database.trim() || undefined,
				user: username.trim()
			},
			password
		);

		if (connection) {
			vscode.window.showInformationMessage(`Connection "${name}" created`);

			// Sync schema in background
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Window,
					title: `Syncing schema for ${name}...`,
				},
				async () => {
					await syncConnectionSchemaByName(connectionManager, connection.name);
				}
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to create connection: ${message}`);
	}
}
