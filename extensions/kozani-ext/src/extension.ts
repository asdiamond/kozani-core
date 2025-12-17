import * as vscode from 'vscode';
import { getGitHubSession } from './auth';
import { registerLanguageModelProvider, registerChatParticipant } from './chat';

console.log('[Kozani] Extension module loaded');

export async function activate(context: vscode.ExtensionContext) {
	console.log('[Kozani] Extension activating...');

	registerLanguageModelProvider(context);
	registerChatParticipant(context);

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
