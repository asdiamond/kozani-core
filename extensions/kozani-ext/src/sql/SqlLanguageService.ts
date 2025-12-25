/**
 * SqlLanguageService - Main service for SQL language features.
 *
 * Provides hover, completions, diagnostics, etc. by combining:
 * - Schema data from .kozani/ YAML files (via SchemaLoader)
 * - Connection context from notebook metadata
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { SchemaLoader } from './schema/SchemaLoader';
import { getSchemaYamlPath } from '../database/kozaniFolder';
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

/**
 * SQL keywords for completions.
 */
const SQL_KEYWORDS = [
	'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'ILIKE',
	'IS', 'NULL', 'TRUE', 'FALSE', 'AS', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER',
	'OUTER', 'FULL', 'CROSS', 'NATURAL', 'USING', 'GROUP', 'BY', 'HAVING', 'ORDER',
	'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'LIMIT', 'OFFSET', 'DISTINCT',
	'ALL', 'UNION', 'INTERSECT', 'EXCEPT', 'WITH', 'RECURSIVE', 'CASE', 'WHEN',
	'THEN', 'ELSE', 'END', 'CAST', 'COALESCE', 'NULLIF', 'GREATEST', 'LEAST',
	'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'RETURNING',
	'CREATE', 'TABLE', 'VIEW', 'INDEX', 'DROP', 'ALTER', 'ADD', 'COLUMN',
	'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE', 'CHECK', 'DEFAULT',
	'CONSTRAINT', 'CASCADE', 'RESTRICT', 'EXISTS', 'ANY', 'SOME',
	'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ARRAY_AGG', 'STRING_AGG', 'JSON_AGG',
	'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'OVER', 'PARTITION', 'FILTER',
];

/**
 * Common PostgreSQL functions for completions.
 */
const PG_FUNCTIONS = [
	{ name: 'COUNT', signature: 'COUNT(expression)' },
	{ name: 'SUM', signature: 'SUM(expression)' },
	{ name: 'AVG', signature: 'AVG(expression)' },
	{ name: 'MIN', signature: 'MIN(expression)' },
	{ name: 'MAX', signature: 'MAX(expression)' },
	{ name: 'COALESCE', signature: 'COALESCE(value1, value2, ...)' },
	{ name: 'NULLIF', signature: 'NULLIF(value1, value2)' },
	{ name: 'CAST', signature: 'CAST(expression AS type)' },
	{ name: 'NOW', signature: 'NOW()' },
	{ name: 'CURRENT_DATE', signature: 'CURRENT_DATE' },
	{ name: 'CURRENT_TIMESTAMP', signature: 'CURRENT_TIMESTAMP' },
	{ name: 'DATE_TRUNC', signature: "DATE_TRUNC('precision', timestamp)" },
	{ name: 'EXTRACT', signature: 'EXTRACT(field FROM timestamp)' },
	{ name: 'TO_CHAR', signature: "TO_CHAR(timestamp, 'format')" },
	{ name: 'TO_DATE', signature: "TO_DATE(text, 'format')" },
	{ name: 'LENGTH', signature: 'LENGTH(string)' },
	{ name: 'LOWER', signature: 'LOWER(string)' },
	{ name: 'UPPER', signature: 'UPPER(string)' },
	{ name: 'TRIM', signature: 'TRIM(string)' },
	{ name: 'CONCAT', signature: 'CONCAT(str1, str2, ...)' },
	{ name: 'SUBSTRING', signature: 'SUBSTRING(string FROM start FOR length)' },
	{ name: 'REPLACE', signature: 'REPLACE(string, from, to)' },
	{ name: 'SPLIT_PART', signature: "SPLIT_PART(string, delimiter, position)" },
	{ name: 'ARRAY_AGG', signature: 'ARRAY_AGG(expression)' },
	{ name: 'STRING_AGG', signature: "STRING_AGG(expression, delimiter)" },
	{ name: 'JSON_AGG', signature: 'JSON_AGG(expression)' },
	{ name: 'JSONB_AGG', signature: 'JSONB_AGG(expression)' },
	{ name: 'ROW_NUMBER', signature: 'ROW_NUMBER() OVER (...)' },
	{ name: 'RANK', signature: 'RANK() OVER (...)' },
	{ name: 'DENSE_RANK', signature: 'DENSE_RANK() OVER (...)' },
	{ name: 'LAG', signature: 'LAG(expression, offset, default) OVER (...)' },
	{ name: 'LEAD', signature: 'LEAD(expression, offset, default) OVER (...)' },
	{ name: 'FIRST_VALUE', signature: 'FIRST_VALUE(expression) OVER (...)' },
	{ name: 'LAST_VALUE', signature: 'LAST_VALUE(expression) OVER (...)' },
	{ name: 'GENERATE_SERIES', signature: 'GENERATE_SERIES(start, stop, step)' },
];

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
	 * Completion context types for context-aware suggestions.
	 */
	private getCompletionContext(textBeforeCursor: string): 'from' | 'join' | 'columns' | 'general' {

		// Check for FROM/JOIN context (suggest tables)
		if (/\b(FROM|JOIN)\s+[\w.]*$/i.test(textBeforeCursor)) {
			return 'from';
		}

		// Check for column context (SELECT list, WHERE, ORDER BY, GROUP BY, HAVING, ON, SET, etc.)
		// These are places where column names make sense
		if (/\bSELECT\s+(DISTINCT\s+)?([\w.,\s*()]+,\s*)?[\w]*$/i.test(textBeforeCursor)) {
			return 'columns';
		}
		if (/\b(WHERE|AND|OR|ON|HAVING)\s+[\w]*$/i.test(textBeforeCursor)) {
			return 'columns';
		}
		if (/\b(ORDER\s+BY|GROUP\s+BY)\s+([\w.,\s]+,\s*)?[\w]*$/i.test(textBeforeCursor)) {
			return 'columns';
		}
		if (/\bSET\s+([\w]+=[\w'",\s]+,\s*)?[\w]*$/i.test(textBeforeCursor)) {
			return 'columns';
		}
		// After comparison operators or IN (
		if (/[=<>!]+\s*[\w]*$/i.test(textBeforeCursor)) {
			return 'columns';
		}

		return 'general';
	}

	/**
	 * Extract table names from FROM and JOIN clauses in the SQL.
	 * Returns both the table name and any alias.
	 */
	private extractTablesFromSql(sql: string): Array<{ name: string; alias?: string }> {
		const tables: Array<{ name: string; alias?: string }> = [];

		// Match: FROM table_name [AS] [alias], table2 [AS] [alias2]
		// Match: JOIN table_name [AS] [alias]
		const fromJoinRegex = /\b(?:FROM|JOIN)\s+([\w.]+)(?:\s+(?:AS\s+)?(\w+))?/gi;

		let match;
		while ((match = fromJoinRegex.exec(sql)) !== null) {
			const tableName = match[1];
			const alias = match[2];

			// Skip if the "table" is actually a keyword (like JOIN types)
			if (/^(INNER|LEFT|RIGHT|FULL|CROSS|OUTER|NATURAL|ON|WHERE)$/i.test(tableName)) {
				continue;
			}

			tables.push({ name: tableName, alias });
		}

		debug(`SqlLanguageService.extractTablesFromSql: Found tables: ${JSON.stringify(tables)}`);
		return tables;
	}

	/**
	 * Get completion items for a position in the document.
	 */
	async getCompletions(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
		debug('SqlLanguageService.getCompletions: Starting');

		const schema = await this.getSchemaForDocument(document);
		const items: vscode.CompletionItem[] = [];

		// Get text before cursor (full document up to cursor position for context)
		const offsetAtCursor = document.offsetAt(position);
		const textBeforeCursor = document.getText().substring(0, offsetAtCursor);
		const lineText = document.lineAt(position.line).text;
		const lineTextBeforeCursor = lineText.substring(0, position.character);

		// Check if we're completing after a dot (table.column or schema.table)
		const dotMatch = lineTextBeforeCursor.match(/(\w+)\.(\w*)$/);
		if (dotMatch) {
			const [, prefix, partial] = dotMatch;
			debug(`SqlLanguageService.getCompletions: Dot context - prefix="${prefix}", partial="${partial}"`);

			if (schema) {
				// Try prefix as table name -> suggest columns
				const tables = schema.tablesByName.get(prefix);
				if (tables && tables.length > 0) {
					for (const table of tables) {
						for (const col of table.columns) {
							if (!partial || col.name.toLowerCase().startsWith(partial.toLowerCase())) {
								items.push(this.buildColumnCompletion(col, table));
							}
						}
					}
				}

				// Also check if prefix is an alias from the query
				const tablesInQuery = this.extractTablesFromSql(textBeforeCursor);
				for (const tableRef of tablesInQuery) {
					if (tableRef.alias?.toLowerCase() === prefix.toLowerCase()) {
						// Find the actual table and suggest its columns
						const actualTables = schema.tablesByName.get(tableRef.name) ||
							(schema.tablesByFullName.has(tableRef.name) ? [schema.tablesByFullName.get(tableRef.name)!] : []);
						for (const table of actualTables) {
							for (const col of table.columns) {
								if (!partial || col.name.toLowerCase().startsWith(partial.toLowerCase())) {
									items.push(this.buildColumnCompletion(col, table));
								}
							}
						}
					}
				}

				// Try prefix as schema name -> suggest tables in that schema
				for (const table of schema.tablesByFullName.values()) {
					if (table.schema === prefix) {
						if (!partial || table.name.toLowerCase().startsWith(partial.toLowerCase())) {
							items.push(this.buildTableCompletion(table, false)); // Don't include schema prefix
						}
					}
				}
			}

			// If we found column/table completions after dot, return just those
			if (items.length > 0) {
				debug(`SqlLanguageService.getCompletions: Returning ${items.length} dot-context items`);
				return items;
			}
		}

		// Determine completion context
		const context = this.getCompletionContext(textBeforeCursor);
		debug(`SqlLanguageService.getCompletions: Context="${context}"`);

		// Get the current word being typed
		const wordMatch = lineTextBeforeCursor.match(/(\w+)$/);
		const currentWord = wordMatch ? wordMatch[1].toLowerCase() : '';
		debug(`SqlLanguageService.getCompletions: Current word="${currentWord}"`);

		// For FROM/JOIN context, prioritize tables
		if (context === 'from') {
			if (schema) {
				for (const table of schema.tablesByFullName.values()) {
					if (!currentWord || table.name.toLowerCase().startsWith(currentWord) ||
						table.fullName.toLowerCase().startsWith(currentWord)) {
						items.push(this.buildTableCompletion(table, true));
					}
				}
			}
			debug(`SqlLanguageService.getCompletions: FROM context - returning ${items.length} tables`);
			return items;
		}

		// For column contexts (WHERE, SELECT, ORDER BY, etc.), suggest columns from in-scope tables
		if (context === 'columns' && schema) {
			const tablesInQuery = this.extractTablesFromSql(textBeforeCursor);
			const addedColumns = new Set<string>(); // Track to avoid duplicates

			if (tablesInQuery.length > 0) {
				// Suggest columns from tables that are in the query
				for (const tableRef of tablesInQuery) {
					// Try to find the table by name or full name
					let matchedTables: TableInfo[] = [];

					const byShortName = schema.tablesByName.get(tableRef.name);
					if (byShortName) {
						matchedTables = byShortName;
					} else {
						const byFullName = schema.tablesByFullName.get(tableRef.name);
						if (byFullName) {
							matchedTables = [byFullName];
						}
					}

					for (const table of matchedTables) {
						for (const col of table.columns) {
							if (!currentWord || col.name.toLowerCase().startsWith(currentWord)) {
								const key = `${table.fullName}.${col.name}`;
								if (!addedColumns.has(key)) {
									addedColumns.add(key);
									items.push(this.buildColumnCompletion(col, table));
								}
							}
						}
					}
				}
			} else {
				// No tables found in query yet - suggest all columns (less ideal but still useful)
				for (const columns of schema.columnsByName.values()) {
					for (const col of columns) {
						if (!currentWord || col.name.toLowerCase().startsWith(currentWord)) {
							const key = `${col.tableName}.${col.name}`;
							if (!addedColumns.has(key)) {
								addedColumns.add(key);
								const table = schema.tablesByFullName.get(col.tableName);
								if (table) {
									items.push(this.buildColumnCompletion(col, table));
								}
							}
						}
					}
				}
			}

			// Also add functions for column contexts (common in SELECT, WHERE)
			for (const func of PG_FUNCTIONS) {
				if (!currentWord || func.name.toLowerCase().startsWith(currentWord)) {
					items.push(this.buildFunctionCompletion(func));
				}
			}

			debug(`SqlLanguageService.getCompletions: Column context - returning ${items.length} items`);
			return items;
		}

		// General context - show everything
		if (schema) {
			for (const table of schema.tablesByFullName.values()) {
				if (!currentWord || table.name.toLowerCase().startsWith(currentWord) ||
					table.fullName.toLowerCase().startsWith(currentWord)) {
					items.push(this.buildTableCompletion(table, true));
				}
			}
		}

		// Add SQL keyword completions
		for (const keyword of SQL_KEYWORDS) {
			if (!currentWord || keyword.toLowerCase().startsWith(currentWord)) {
				items.push(this.buildKeywordCompletion(keyword));
			}
		}

		// Add function completions
		for (const func of PG_FUNCTIONS) {
			if (!currentWord || func.name.toLowerCase().startsWith(currentWord)) {
				items.push(this.buildFunctionCompletion(func));
			}
		}

		debug(`SqlLanguageService.getCompletions: Returning ${items.length} items`);
		return items;
	}

	/**
	 * Build a completion item for a table.
	 */
	private buildTableCompletion(table: TableInfo, includeSchema: boolean): vscode.CompletionItem {
		const label = includeSchema ? table.fullName : table.name;
		const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Class);

		// allow-any-unicode-next-line
		const icon = table.isView ? '👁️' : '📋';
		item.detail = `${icon} ${table.isView ? 'View' : 'Table'} (${table.columns.length} columns)`;

		if (table.description) {
			item.documentation = new vscode.MarkdownString(table.description);
		}

		// Sort tables before keywords
		item.sortText = `0_${label}`;

		return item;
	}

	/**
	 * Build a completion item for a column.
	 */
	private buildColumnCompletion(column: ColumnInfo, table: TableInfo): vscode.CompletionItem {
		const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);

		// allow-any-unicode-next-line
		const pk = column.primaryKey ? ' 🔑' : '';
		item.detail = `${column.type}${pk}`;

		const doc = new vscode.MarkdownString();
		doc.appendMarkdown(`**Column** in \`${table.fullName}\`\n\n`);
		doc.appendMarkdown(`**Type:** \`${column.type}\`  \n`);
		doc.appendMarkdown(`**Nullable:** ${column.nullable ? 'Yes' : 'No'}`);
		if (column.description) {
			doc.appendMarkdown(`\n\n${column.description}`);
		}
		item.documentation = doc;

		// Columns sorted first when in dot-context
		item.sortText = `0_${column.name}`;

		return item;
	}

	/**
	 * Build a completion item for an SQL keyword.
	 */
	private buildKeywordCompletion(keyword: string): vscode.CompletionItem {
		const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
		item.detail = 'SQL keyword';

		// Sort keywords after tables
		item.sortText = `1_${keyword}`;

		return item;
	}

	/**
	 * Build a completion item for a PostgreSQL function.
	 */
	private buildFunctionCompletion(func: { name: string; signature: string }): vscode.CompletionItem {
		const item = new vscode.CompletionItem(func.name, vscode.CompletionItemKind.Function);
		item.detail = func.signature;

		// Sort functions with keywords
		item.sortText = `1_${func.name}`;

		return item;
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

