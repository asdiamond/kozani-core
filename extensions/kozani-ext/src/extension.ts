import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('kozani-ext.helloWorld', () => {
    vscode.window.showInformationMessage('Hello from Kozani Extension!');
  });
  context.subscriptions.push(disposable);
}

export function deactivate() {}
