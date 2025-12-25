/**
 * SqlLanguageService - Main service for SQL language features.
 *
 * Provides hover, completions, diagnostics, etc. by combining:
 * - Schema data from .kozani/ YAML files (via SchemaLoader)
 * - Connection context from notebook metadata
 * - Tree-sitter based SQL parsing for accurate context detection
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { SchemaLoader } from './schema/SchemaLoader';
import { getSchemaYamlPath } from '../database/kozaniFolder';
import type { ConnectionSchema, TableInfo, ColumnInfo } from './types';
import { debug } from '../debug';
import { complete as treeSitterComplete } from './completions';
import { treeSitterParser } from './parser';

/**
 * Result of hover lookup.
 */
export interface HoverResult {
	/** Markdown content to display */
	contents: vscode.MarkdownString;
	/** Range of the word being hovered */
	range?: vscode.Range;
}

/** Whether to use tree-sitter based completions (new) or regex-based (legacy) */
const USE_TREE_SITTER_COMPLETIONS = true;

/** If true, never fall back to regex completions even if tree-sitter returns 0 items */
const DISABLE_REGEX_FALLBACK = true;

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
	 * Get definition location for a table or column name.
	 * Jumps to the definition in the schema YAML file.
	 */
	async getDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location | undefined> {
		debug('SqlLanguageService.getDefinition: Starting');

		const connectionName = this.getConnectionForDocument(document);
		if (!connectionName) {
			debug('SqlLanguageService.getDefinition: No connection for document');
			return undefined;
		}

		const schema = await this.schemaLoader.getSchema(connectionName);
		if (!schema) {
			debug('SqlLanguageService.getDefinition: No schema available');
			return undefined;
		}

		// Get the word at cursor
		const wordRange = document.getWordRangeAtPosition(position, /[\w.]+/);
		if (!wordRange) {
			debug('SqlLanguageService.getDefinition: No word at position');
			return undefined;
		}

		const word = document.getText(wordRange);
		debug(`SqlLanguageService.getDefinition: Word is "${word}"`);

		// Try to find as table.column first
		const columnMatch = this.findColumnForWord(word, schema);
		if (columnMatch) {
			debug(`SqlLanguageService.getDefinition: Found column ${columnMatch.column.name} in table ${columnMatch.table.fullName}`);
			const location = await this.findColumnLocationInYaml(connectionName, columnMatch.table, columnMatch.column.name);
			if (location) {
				debug(`SqlLanguageService.getDefinition: Returning column location`);
				return location;
			}
		}

		// Fall back to table lookup
		const table = this.findTableForWord(word, schema);
		if (!table) {
			debug('SqlLanguageService.getDefinition: No table found for word');
			return undefined;
		}

		debug(`SqlLanguageService.getDefinition: Found table ${table.fullName}`);

		// Find the location in the YAML file
		const location = await this.findTableLocationInYaml(connectionName, table);
		if (!location) {
			debug('SqlLanguageService.getDefinition: Could not find location in YAML');
			return undefined;
		}

		debug(`SqlLanguageService.getDefinition: Returning location ${location.uri.fsPath}:${location.range.start.line}`);
		return location;
	}

	/**
	 * Get completion items for a position in the document.
	 * Uses tree-sitter based context detection for accurate completions.
	 */
	async getCompletions(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
		debug('SqlLanguageService.getCompletions: Starting');

		const schema = await this.getSchemaForDocument(document);
		const sql = document.getText();
		const offset = document.offsetAt(position);

		if (USE_TREE_SITTER_COMPLETIONS) {
			try {
				// Initialize tree-sitter parser if needed
				await treeSitterParser.init();

				// Use tree-sitter based completions
				const items = await treeSitterComplete(sql, offset, schema);
				debug(`SqlLanguageService.getCompletions: Tree-sitter returned ${items.length} items`);

				// If tree-sitter returns results, use them
				if (items.length > 0) {
					// Add a label so user knows these are from tree-sitter
					for (const item of items) {
						item.detail = `[TS] ${item.detail || ''}`;
					}
					return items;
				}

				// Tree-sitter returned 0 items
				if (DISABLE_REGEX_FALLBACK) {
					debug('SqlLanguageService.getCompletions: Tree-sitter returned 0, fallback DISABLED');
					return [];
				}

				debug('SqlLanguageService.getCompletions: Tree-sitter returned 0, using fallback');
				return this.getFallbackCompletions(document, position, schema);
			} catch (error) {
				// Fall back to basic completions if tree-sitter fails
				debug(`SqlLanguageService.getCompletions: Tree-sitter error, using fallback: ${error}`);
				if (DISABLE_REGEX_FALLBACK) {
					debug('SqlLanguageService.getCompletions: Fallback DISABLED, returning empty');
					return [];
				}
				return this.getFallbackCompletions(document, position, schema);
			}
		}

		// Legacy path (for comparison/fallback)
		return this.getFallbackCompletions(document, position, schema);
	}

	/**
	 * Fallback completions using simple heuristics.
	 * Used when tree-sitter is disabled or fails.
	 */
	private getFallbackCompletions(
		document: vscode.TextDocument,
		position: vscode.Position,
		schema: ConnectionSchema | undefined
	): vscode.CompletionItem[] {
		const items: vscode.CompletionItem[] = [];
		const lineText = document.lineAt(position.line).text;
		const lineTextBeforeCursor = lineText.substring(0, position.character);
		const wordMatch = lineTextBeforeCursor.match(/(\w+)$/);
		const currentWord = wordMatch ? wordMatch[1].toLowerCase() : '';

		// Add tables
		if (schema) {
			for (const table of schema.tablesByFullName.values()) {
				if (!currentWord || table.name.toLowerCase().startsWith(currentWord)) {
					const item = new vscode.CompletionItem(table.fullName, vscode.CompletionItemKind.Class);
					// allow-any-unicode-next-line
					item.detail = `${table.isView ? '👁️ View' : '📋 Table'} (${table.columns.length} columns)`;
					item.sortText = `0_${table.fullName}`;
					items.push(item);
				}
			}

			// Add columns
			for (const table of schema.tablesByFullName.values()) {
				for (const col of table.columns) {
					if (!currentWord || col.name.toLowerCase().startsWith(currentWord)) {
						const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
						item.detail = col.type;
						item.sortText = `1_${col.name}`;
						items.push(item);
					}
				}
			}
		}

		// Add basic keywords
		const keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'ON', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT'];
		for (const keyword of keywords) {
			if (!currentWord || keyword.toLowerCase().startsWith(currentWord)) {
				const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
				item.sortText = `2_${keyword}`;
				items.push(item);
			}
		}

		return items;
	}

	/**
	 * Find the table that matches a word (handles qualified and unqualified names).
	 */
	private findTableForWord(word: string, schema: ConnectionSchema): TableInfo | undefined {
		// Check if it's a qualified name like "public.users" or "table.column"
		if (word.includes('.')) {
			const parts = word.split('.');

			// Try as schema.table first
			const asQualified = schema.tablesByFullName.get(word);
			if (asQualified) {
				return asQualified;
			}

			// Try first part as table name (e.g., "users.id" -> "users")
			if (parts.length >= 1) {
				const tables = schema.tablesByName.get(parts[0]);
				if (tables && tables.length > 0) {
					return tables[0]; // Return first match
				}
			}

			// Try as schema.table (first two parts)
			if (parts.length >= 2) {
				const fullName = `${parts[0]}.${parts[1]}`;
				const table = schema.tablesByFullName.get(fullName);
				if (table) {
					return table;
				}
			}
		}

		// Unqualified name - look up by short name
		const tables = schema.tablesByName.get(word);
		if (tables && tables.length > 0) {
			return tables[0]; // Return first match
		}

		return undefined;
	}

	/**
	 * Find a column for a word like "table.column" or "schema.table.column".
	 * Returns the table and column if found.
	 */
	private findColumnForWord(word: string, schema: ConnectionSchema): { table: TableInfo; column: ColumnInfo } | undefined {
		if (!word.includes('.')) {
			// Unqualified column name - try to find in schema
			const columns = schema.columnsByName.get(word);
			if (columns && columns.length === 1) {
				// Only return if unambiguous (single match)
				const col = columns[0];
				const table = schema.tablesByFullName.get(col.tableName);
				if (table) {
					return { table, column: col };
				}
			}
			return undefined;
		}

		const parts = word.split('.');

		// table.column format (e.g., "messages.id")
		if (parts.length === 2) {
			const [tablePart, columnPart] = parts;

			// First check if it's schema.table (not table.column)
			const asSchemaTable = schema.tablesByFullName.get(word);
			if (asSchemaTable) {
				// It's a table, not a column reference
				return undefined;
			}

			// Try as table.column
			const tables = schema.tablesByName.get(tablePart);
			if (tables) {
				for (const table of tables) {
					const column = table.columns.find(c => c.name === columnPart);
					if (column) {
						return { table, column };
					}
				}
			}
		}

		// schema.table.column format (e.g., "public.messages.id")
		if (parts.length === 3) {
			const [schemaName, tableName, columnName] = parts;
			const fullTableName = `${schemaName}.${tableName}`;
			const table = schema.tablesByFullName.get(fullTableName);
			if (table) {
				const column = table.columns.find(c => c.name === columnName);
				if (column) {
					return { table, column };
				}
			}
		}

		return undefined;
	}

	/**
	 * Find the line number of a table in its schema YAML file.
	 */
	private async findTableLocationInYaml(connectionName: string, table: TableInfo): Promise<vscode.Location | undefined> {
		const yamlPath = getSchemaYamlPath(connectionName, table.schema);
		if (!yamlPath) {
			debug('SqlLanguageService.findTableLocationInYaml: Could not get YAML path');
			return undefined;
		}

		try {
			const content = await fs.promises.readFile(yamlPath, 'utf8');
			const lines = content.split('\n');

			// Find the line with the table name (2-space indent for table keys under "tables:")
			const tablePattern = new RegExp(`^  ${table.name}:`);
			const lineIndex = lines.findIndex(line => tablePattern.test(line));

			if (lineIndex === -1) {
				debug(`SqlLanguageService.findTableLocationInYaml: Table "${table.name}" not found in ${yamlPath}`);
				return undefined;
			}

			const uri = vscode.Uri.file(yamlPath);
			const position = new vscode.Position(lineIndex, 2); // Start at the table name
			return new vscode.Location(uri, position);
		} catch (err) {
			debug('SqlLanguageService.findTableLocationInYaml: Error reading file:', err);
			return undefined;
		}
	}

	/**
	 * Find the line number of a column within a table in its schema YAML file.
	 */
	private async findColumnLocationInYaml(connectionName: string, table: TableInfo, columnName: string): Promise<vscode.Location | undefined> {
		const yamlPath = getSchemaYamlPath(connectionName, table.schema);
		if (!yamlPath) {
			debug('SqlLanguageService.findColumnLocationInYaml: Could not get YAML path');
			return undefined;
		}

		try {
			const content = await fs.promises.readFile(yamlPath, 'utf8');
			const lines = content.split('\n');

			// Find the table first
			const tablePattern = new RegExp(`^  ${table.name}:`);
			const tableLineIndex = lines.findIndex(line => tablePattern.test(line));

			if (tableLineIndex === -1) {
				debug(`SqlLanguageService.findColumnLocationInYaml: Table "${table.name}" not found`);
				return undefined;
			}

			// Search for the column within this table's section
			// Stop when we hit the next table (another 2-space indented key)
			const columnPattern = new RegExp(`^\\s+- name: ${columnName}\\s*$`);
			const nextTablePattern = /^  \w+:/;

			for (let i = tableLineIndex + 1; i < lines.length; i++) {
				const line = lines[i];

				// Stop if we hit the next table
				if (i > tableLineIndex && nextTablePattern.test(line)) {
					break;
				}

				// Check if this is our column
				if (columnPattern.test(line)) {
					const uri = vscode.Uri.file(yamlPath);
					const position = new vscode.Position(i, line.indexOf('- name:'));
					return new vscode.Location(uri, position);
				}
			}

			debug(`SqlLanguageService.findColumnLocationInYaml: Column "${columnName}" not found in table "${table.name}"`);
			return undefined;
		} catch (err) {
			debug('SqlLanguageService.findColumnLocationInYaml: Error reading file:', err);
			return undefined;
		}
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

