/**
 * SqlHoverProvider - Provides hover information for SQL in notebook cells.
 *
 * Shows table and column information from the connection's schema
 * when hovering over identifiers.
 */

import * as vscode from 'vscode';
import type { SqlLanguageService } from '../SqlLanguageService';
import { debug } from '../../debug';

export class SqlHoverProvider implements vscode.HoverProvider {
	constructor(private service: SqlLanguageService) {
		debug('SqlHoverProvider: Initialized');
	}

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken
	): Promise<vscode.Hover | undefined> {
		debug(`SqlHoverProvider: provideHover called at ${position.line}:${position.character}`);
		debug(`SqlHoverProvider: Document URI: ${document.uri.toString()}`);
		debug(`SqlHoverProvider: Document scheme: ${document.uri.scheme}, language: ${document.languageId}`);

		const result = await this.service.getHover(document, position);

		if (!result) {
			debug('SqlHoverProvider: No hover result');
			return undefined;
		}

		debug('SqlHoverProvider: Returning hover result');
		return new vscode.Hover(result.contents, result.range);
	}
}

