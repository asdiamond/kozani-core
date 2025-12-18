import * as vscode from 'vscode';

/**
 * Notebook serializer for .kozani and .sqlbook files.
 *
 * File format is simple JSON:
 * {
 *   "version": 1,
 *   "connectionId": "uuid-of-connection",
 *   "database": "database-name",
 *   "cells": [
 *     { "kind": "sql", "value": "SELECT * FROM users" },
 *     { "kind": "markdown", "value": "# Notes\nThis query fetches all users" }
 *   ]
 * }
 */

interface NotebookFile {
	version: number;
	connectionId?: string;
	database?: string;
	cells: Array<{
		kind: 'sql' | 'markdown';
		value: string;
	}>;
}

export class KozaniNotebookSerializer implements vscode.NotebookSerializer {
	async deserializeNotebook(
		content: Uint8Array,
		_token: vscode.CancellationToken
	): Promise<vscode.NotebookData> {
		const text = new TextDecoder().decode(content);

		let data: NotebookFile;
		try {
			data = text.trim() ? JSON.parse(text) : { version: 1, cells: [] };
		} catch {
			// If parsing fails, treat as a single SQL cell
			data = {
				version: 1,
				cells: text.trim() ? [{ kind: 'sql', value: text }] : []
			};
		}

		const cells = data.cells.map(cell => {
			const kind = cell.kind === 'markdown'
				? vscode.NotebookCellKind.Markup
				: vscode.NotebookCellKind.Code;
			const language = cell.kind === 'markdown' ? 'markdown' : 'sql';
			return new vscode.NotebookCellData(kind, cell.value, language);
		});

		const notebookData = new vscode.NotebookData(cells);

		// Store connection metadata in notebook metadata
		notebookData.metadata = {
			connectionId: data.connectionId,
			database: data.database,
		};

		return notebookData;
	}

	async serializeNotebook(
		data: vscode.NotebookData,
		_token: vscode.CancellationToken
	): Promise<Uint8Array> {
		const cells = data.cells.map(cell => ({
			kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' as const : 'sql' as const,
			value: cell.value,
		}));

		const file: NotebookFile = {
			version: 1,
			connectionId: data.metadata?.connectionId,
			database: data.metadata?.database,
			cells,
		};

		return new TextEncoder().encode(JSON.stringify(file, null, 2));
	}
}
