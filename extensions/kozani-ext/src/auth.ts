import * as vscode from 'vscode';

const GITHUB_AUTH_SCOPES = ['read:user', 'user:email'];

export async function getGitHubSession(createIfNone: boolean = true): Promise<vscode.AuthenticationSession | undefined> {
	try {
		const session = await vscode.authentication.getSession('github', GITHUB_AUTH_SCOPES, { createIfNone });
		return session;
	} catch (error) {
		console.error('Failed to get GitHub session:', error);
		return undefined;
	}
}
