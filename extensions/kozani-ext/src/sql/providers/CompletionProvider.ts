/**
 * SqlCompletionProvider - Provides auto-completions for SQL in notebook cells.
 *
 * Suggests table names, column names, and SQL keywords based on
 * the connection's schema and cursor context.
 */

import * as vscode from 'vscode';
import type { SqlLanguageService } from '../SqlLanguageService';
import { debug } from '../../debug';

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private service: SqlLanguageService) {
		debug('SqlCompletionProvider: Initialized');
	}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		_context: vscode.CompletionContext
	): Promise<vscode.CompletionItem[] | undefined> {
		debug(`SqlCompletionProvider: provideCompletionItems called at ${position.line}:${position.character}`);

		const items = await this.service.getCompletions(document, position);

		if (!items || items.length === 0) {
			debug('SqlCompletionProvider: No completion items');
			return undefined;
		}

		debug(`SqlCompletionProvider: Returning ${items.length} completion items`);
		return items;
	}
}

