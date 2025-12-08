/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

class KozaniSecondaryViewProvider implements vscode.WebviewViewProvider {
	constructor(private readonly extensionUri: vscode.Uri) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
		webviewView.webview.options = {
			enableScripts: true
		};
		webviewView.webview.html = this.getHtml();
	}

	private getHtml(): string {
		return /* html */ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1.0" />
					<style>
						body {
							font-family: var(--vscode-font-family);
							color: var(--vscode-foreground);
							background: var(--vscode-editor-background);
							padding: 12px;
						}
					</style>
				</head>
				<body>
					<h3>Hello from Kozani Secondary Sidebar</h3>
					<p>This view is wired to open by default on the right.</p>
				</body>
			</html>
		`;
	}
}

export async function activate(context: vscode.ExtensionContext) {
	const provider = new KozaniSecondaryViewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('kozaniSecondaryView', provider)
	);

	const helloCommand = vscode.commands.registerCommand('kozani-ext.helloWorld', () => {
		vscode.window.showInformationMessage('Hello from Kozani Extension!');
	});
	context.subscriptions.push(helloCommand);

	// Ensure the secondary sidebar is visible and show our view there.
	await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
	// Reveal via the container command; this exists once the container is registered.
	await vscode.commands.executeCommand('workbench.view.extension.kozaniSecondary');
}

export function deactivate() { }
