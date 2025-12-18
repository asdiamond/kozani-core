import * as vscode from 'vscode';

/**
 * Notebook serializer for .kozani and .sqlbook files.
 *
 * File format is JSON with cells and their outputs (like Jupyter .ipynb):
 * {
 *   "version": 1,
 *   "connectionId": "uuid-of-connection",
 *   "database": "database-name",
 *   "cells": [
 *     {
 *       "kind": "sql",
 *       "value": "SELECT * FROM users",
 *       "outputs": [{ "mime": "text/html", "data": "<table>..." }]
 *     }
 *   ]
 * }
 */

interface SerializedOutput {
	mime: string;
	data: string; // text content or base64 for binary
}

interface SerializedCell {
	kind: 'sql' | 'markdown';
	value: string;
	outputs?: SerializedOutput[];
}

interface NotebookFile {
	version: number;
	connectionId?: string;
	database?: string;
	cells: SerializedCell[];
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

			const cellData = new vscode.NotebookCellData(kind, cell.value, language);

			// Restore outputs if present
			if (cell.outputs && cell.outputs.length > 0) {
				cellData.outputs = cell.outputs.map(output => {
					const item = output.mime.startsWith('text/')
						? vscode.NotebookCellOutputItem.text(output.data, output.mime)
						: vscode.NotebookCellOutputItem.text(output.data, output.mime); // For now, treat all as text
					return new vscode.NotebookCellOutput([item]);
				});
			}

			return cellData;
		});

		const notebookData = new vscode.NotebookData(cells);

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
		const cells: SerializedCell[] = data.cells.map(cell => {
			const serializedCell: SerializedCell = {
				kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'sql',
				value: cell.value,
			};

			// Serialize outputs
			if (cell.outputs && cell.outputs.length > 0) {
				serializedCell.outputs = [];
				for (const output of cell.outputs) {
					for (const item of output.items) {
						// Convert Uint8Array to string
						const text = new TextDecoder().decode(item.data);
						serializedCell.outputs.push({
							mime: item.mime,
							data: text,
						});
					}
				}
			}

			return serializedCell;
		});

		const file: NotebookFile = {
			version: 1,
			connectionId: data.metadata?.connectionId,
			database: data.metadata?.database,
			cells,
		};

		return new TextEncoder().encode(JSON.stringify(file, null, 2));
	}
}
