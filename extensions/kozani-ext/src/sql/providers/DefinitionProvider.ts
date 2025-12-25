/**
 * SqlDefinitionProvider - Provides "Go to Definition" for tables in SQL.
 *
 * Jumps to the table definition in the .kozani/ schema YAML files.
 */

import * as vscode from 'vscode';
import type { SqlLanguageService } from '../SqlLanguageService';
import { debug } from '../../debug';

export class SqlDefinitionProvider implements vscode.DefinitionProvider {
	constructor(private service: SqlLanguageService) {
		debug('SqlDefinitionProvider: Initialized');
	}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken
	): Promise<vscode.Location | undefined> {
		debug(`SqlDefinitionProvider: provideDefinition called at ${position.line}:${position.character}`);

		const location = await this.service.getDefinition(document, position);

		if (!location) {
			debug('SqlDefinitionProvider: No definition found');
			return undefined;
		}

		debug(`SqlDefinitionProvider: Returning definition at ${location.uri.fsPath}:${location.range.start.line}`);
		return location;
	}
}

