/**
 * SqlLanguageService - Main service for SQL language features.
 *
 * Provides hover, completions, diagnostics, etc. by combining:
 * - Schema data from .kozani/ YAML files (via SchemaLoader)
 * - Connection context from notebook metadata
 */

import * as vscode from 'vscode';
import { SchemaLoader } from './schema/SchemaLoader';
import type { ConnectionSchema, TableInfo, ColumnInfo } from './types';
import { debug } from '../debug';

/**
 * Result of hover lookup.
 */
export interface HoverResult {
	/** Markdown content to display */
	contents: vscode.MarkdownString;
	/** Range of the word being hovered */
	range?: vscode.Range;
}

export class SqlLanguageService {
	private schemaLoader: SchemaLoader;

	constructor() {
		this.schemaLoader = new SchemaLoader();
	}

	/**
	 * Get schema for the connection associated with a document.
	 */
	async getSchemaForDocument(document: vscode.TextDocument): Promise<ConnectionSchema | undefined> {
		const connectionName = this.getConnectionForDocument(document);
		if (!connectionName) {
			debug('SqlLanguageService: No connection found for document');
			return undefined;
		}

		return this.schemaLoader.getSchema(connectionName);
	}

	/**
	 * Get connection name from the notebook that contains this document.
	 * For notebook cells, reads from notebook metadata.
	 */
	getConnectionForDocument(document: vscode.TextDocument): string | undefined {
		debug(`SqlLanguageService.getConnectionForDocument: scheme=${document.uri.scheme}`);

		// Only handle notebook cells
		if (document.uri.scheme !== 'vscode-notebook-cell') {
			debug('SqlLanguageService: Not a notebook cell, skipping');
			return undefined;
		}

		// Find the notebook that contains this cell
		debug(`SqlLanguageService: Looking for notebook containing cell ${document.uri.toString()}`);
		debug(`SqlLanguageService: Total notebooks open: ${vscode.workspace.notebookDocuments.length}`);

		const notebook = vscode.workspace.notebookDocuments.find(nb => {
			const cells = nb.getCells();
			debug(`SqlLanguageService: Checking notebook ${nb.uri.toString()} with ${cells.length} cells`);
			return cells.some(cell => cell.document.uri.toString() === document.uri.toString());
		});

		if (!notebook) {
			debug('SqlLanguageService: Could not find notebook for cell');
			return undefined;
		}

		debug(`SqlLanguageService: Found notebook ${notebook.uri.toString()}`);
		debug(`SqlLanguageService: Notebook metadata: ${JSON.stringify(notebook.metadata)}`);

		const connectionName = notebook.metadata?.connectionName as string | undefined;
		if (!connectionName) {
			debug('SqlLanguageService: Notebook has no connectionName in metadata');
		} else {
			debug(`SqlLanguageService: Connection name is "${connectionName}"`);
		}

		return connectionName;
	}

	/**
	 * Get hover information for a position in the document.
	 */
	async getHover(document: vscode.TextDocument, position: vscode.Position): Promise<HoverResult | undefined> {
		debug('SqlLanguageService.getHover: Starting');

		const schema = await this.getSchemaForDocument(document);
		if (!schema) {
			debug('SqlLanguageService.getHover: No schema available');
			return undefined;
		}

		debug(`SqlLanguageService.getHover: Got schema with ${schema.tablesByFullName.size} tables`);

		// Get the word at the cursor position (including dots for qualified names)
		const wordRange = document.getWordRangeAtPosition(position, /[\w.]+/);
		if (!wordRange) {
			debug('SqlLanguageService.getHover: No word at position');
			return undefined;
		}

		const word = document.getText(wordRange);
		debug(`SqlLanguageService.getHover: Word at position is "${word}"`);

		// Try to match against schema
		const hover = this.buildHover(word, schema);
		if (hover) {
			debug('SqlLanguageService.getHover: Built hover content');
			return { contents: hover, range: wordRange };
		}

		debug('SqlLanguageService.getHover: No match found in schema');
		return undefined;
	}

	/**
	 * Build hover content for a word, matching against schema.
	 */
	private buildHover(word: string, schema: ConnectionSchema): vscode.MarkdownString | undefined {
		// Check if it's a qualified name like "public.users"
		if (word.includes('.')) {
			const table = schema.tablesByFullName.get(word);
			if (table) {
				return this.buildTableHover(table);
			}

			// Could be schema.table.column - try to parse
			const parts = word.split('.');
			if (parts.length === 3) {
				const [schemaName, tableName, columnName] = parts;
				const tableInfo = schema.tablesByFullName.get(`${schemaName}.${tableName}`);
				if (tableInfo) {
					const column = tableInfo.columns.find(c => c.name === columnName);
					if (column) {
						return this.buildColumnHover(column, tableInfo);
					}
				}
			}

			// Could be table.column (without schema)
			if (parts.length === 2) {
				const [tablePart, columnPart] = parts;

				// First try as schema.table
				const tableAsQualified = schema.tablesByFullName.get(word);
				if (tableAsQualified) {
					return this.buildTableHover(tableAsQualified);
				}

				// Then try as table.column
				const tables = schema.tablesByName.get(tablePart);
				if (tables && tables.length > 0) {
					// Look for the column in matching tables
					for (const table of tables) {
						const column = table.columns.find(c => c.name === columnPart);
						if (column) {
							return this.buildColumnHover(column, table);
						}
					}
				}
			}

			return undefined;
		}

		// Unqualified name - could be table or column
		// First check tables
		const tables = schema.tablesByName.get(word);
		if (tables && tables.length > 0) {
			// If only one match, show it
			if (tables.length === 1) {
				return this.buildTableHover(tables[0]);
			}
			// Multiple matches - show all
			return this.buildMultipleTablesHover(tables);
		}

		// Check columns
		const columns = schema.columnsByName.get(word);
		if (columns && columns.length > 0) {
			// If only one match, show it
			if (columns.length === 1) {
				const col = columns[0];
				const table = schema.tablesByFullName.get(col.tableName);
				return this.buildColumnHover(col, table);
			}
			// Multiple matches - show all
			return this.buildMultipleColumnsHover(columns, schema);
		}

		return undefined;
	}

	/**
	 * Build hover content for a table.
	 */
	private buildTableHover(table: TableInfo): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.isTrusted = true;

		// allow-any-unicode-next-line
		const icon = table.isView ? '👁️' : '📋';
		const type = table.isView ? 'view' : 'table';
		md.appendMarkdown(`### ${icon} ${table.fullName}\n\n`);

		if (table.description) {
			md.appendMarkdown(`${table.description}\n\n`);
		}

		md.appendMarkdown(`**Type:** ${type}  \n`);
		md.appendMarkdown(`**Schema:** ${table.schema}  \n`);
		md.appendMarkdown(`**Columns:** ${table.columns.length}\n\n`);

		// Show column list
		if (table.columns.length > 0) {
			md.appendMarkdown('---\n\n');
			md.appendMarkdown('| Column | Type | Nullable |\n');
			md.appendMarkdown('|--------|------|----------|\n');

			for (const col of table.columns.slice(0, 15)) { // Limit to 15 columns
				// allow-any-unicode-next-line
				const nullable = col.nullable ? '✓' : '✗';
				// allow-any-unicode-next-line
				const pk = col.primaryKey ? ' 🔑' : '';
				md.appendMarkdown(`| ${col.name}${pk} | \`${col.type}\` | ${nullable} |\n`);
			}

			if (table.columns.length > 15) {
				md.appendMarkdown(`\n*... and ${table.columns.length - 15} more columns*\n`);
			}
		}

		return md;
	}

	/**
	 * Build hover content for a column.
	 */
	private buildColumnHover(column: ColumnInfo, _table?: TableInfo): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.isTrusted = true;

		// allow-any-unicode-next-line
		const pk = column.primaryKey ? ' 🔑' : '';
		// allow-any-unicode-next-line
		md.appendMarkdown(`### 📊 ${column.name}${pk}\n\n`);

		if (column.description) {
			md.appendMarkdown(`${column.description}\n\n`);
		}

		md.appendMarkdown(`**Type:** \`${column.type}\`  \n`);
		md.appendMarkdown(`**Nullable:** ${column.nullable ? 'Yes' : 'No'}  \n`);
		md.appendMarkdown(`**Table:** ${column.tableName}\n`);

		if (column.primaryKey) {
			md.appendMarkdown(`**Primary Key:** Yes\n`);
		}

		return md;
	}

	/**
	 * Build hover content when multiple tables match.
	 */
	private buildMultipleTablesHover(tables: TableInfo[]): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.isTrusted = true;

		// allow-any-unicode-next-line
		md.appendMarkdown(`### 📋 ${tables[0].name}\n\n`);
		md.appendMarkdown(`*Found in ${tables.length} schemas:*\n\n`);

		for (const table of tables) {
			// allow-any-unicode-next-line
			const icon = table.isView ? '👁️' : '📋';
			md.appendMarkdown(`- ${icon} **${table.fullName}** (${table.columns.length} columns)\n`);
		}

		return md;
	}

	/**
	 * Build hover content when multiple columns match.
	 */
	private buildMultipleColumnsHover(columns: ColumnInfo[], _schema: ConnectionSchema): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.isTrusted = true;

		// allow-any-unicode-next-line
		md.appendMarkdown(`### 📊 ${columns[0].name}\n\n`);
		md.appendMarkdown(`*Found in ${columns.length} tables:*\n\n`);

		for (const col of columns.slice(0, 10)) { // Limit to 10
			md.appendMarkdown(`- **${col.tableName}**.${col.name} - \`${col.type}\`\n`);
		}

		if (columns.length > 10) {
			md.appendMarkdown(`\n*... and ${columns.length - 10} more*\n`);
		}

		return md;
	}

	/**
	 * Invalidate schema cache.
	 */
	invalidateCache(connectionName?: string): void {
		this.schemaLoader.invalidate(connectionName);
	}

	/**
	 * Dispose of resources.
	 */
	dispose(): void {
		this.schemaLoader.dispose();
	}
}

