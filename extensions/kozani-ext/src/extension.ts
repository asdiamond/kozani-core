/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getGitHubSession } from './auth';
import { registerLanguageModelProvider, registerChatParticipant } from './chat';

// Log immediately when module loads (helps debug import issues)
console.log('[Kozani] Extension module loaded');

export async function activate(context: vscode.ExtensionContext) {
	console.log('[Kozani] Extension activating...');

	// Register chat providers
	registerLanguageModelProvider(context);
	registerChatParticipant(context);

	// Register sign-in command
	const signInCommand = vscode.commands.registerCommand('kozani-ext.signIn', async () => {
		const session = await getGitHubSession(true);
		if (session) {
			vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
		}
	});
	context.subscriptions.push(signInCommand);

	console.log('[Kozani] Extension activated');
}

export function deactivate() {
	console.log('[Kozani] Extension deactivated');
}
