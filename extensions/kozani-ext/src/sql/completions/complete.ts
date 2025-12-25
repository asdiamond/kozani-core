/**
 * Complete - Main entry point for SQL completions.
 *
 * Combines the SqlContext, filtering, and scoring to generate relevant completions.
 * Works with Kozani's local schema data from .kozani/ YAML files.
 */

import * as vscode from 'vscode';
import { createSqlContext } from '../parser/SqlContext';
import { treeSitterParser } from '../parser/TreeSitterParser';
import { isRelevant, CompletionRelevanceData, resetFilterDebug } from './filtering';
import { calculateScore, ScoredCompletionItem, resetScoringDebug } from './scoring';
import type { ConnectionSchema, TableInfo, ColumnInfo } from '../types';
import { debug } from '../../debug';

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
];

/**
 * Common PostgreSQL functions for completions.
 */
const PG_FUNCTIONS = [
	{ name: 'COUNT', signature: 'COUNT(expression)', isAggregate: true },
	{ name: 'SUM', signature: 'SUM(expression)', isAggregate: true },
	{ name: 'AVG', signature: 'AVG(expression)', isAggregate: true },
	{ name: 'MIN', signature: 'MIN(expression)', isAggregate: true },
	{ name: 'MAX', signature: 'MAX(expression)', isAggregate: true },
	{ name: 'COALESCE', signature: 'COALESCE(value1, value2, ...)', isAggregate: false },
	{ name: 'NULLIF', signature: 'NULLIF(value1, value2)', isAggregate: false },
	{ name: 'CAST', signature: 'CAST(expression AS type)', isAggregate: false },
	{ name: 'NOW', signature: 'NOW()', isAggregate: false },
	{ name: 'CURRENT_DATE', signature: 'CURRENT_DATE', isAggregate: false },
	{ name: 'CURRENT_TIMESTAMP', signature: 'CURRENT_TIMESTAMP', isAggregate: false },
	{ name: 'DATE_TRUNC', signature: "DATE_TRUNC('precision', timestamp)", isAggregate: false },
	{ name: 'EXTRACT', signature: 'EXTRACT(field FROM timestamp)', isAggregate: false },
	{ name: 'TO_CHAR', signature: "TO_CHAR(timestamp, 'format')", isAggregate: false },
	{ name: 'TO_DATE', signature: "TO_DATE(text, 'format')", isAggregate: false },
	{ name: 'LENGTH', signature: 'LENGTH(string)', isAggregate: false },
	{ name: 'LOWER', signature: 'LOWER(string)', isAggregate: false },
	{ name: 'UPPER', signature: 'UPPER(string)', isAggregate: false },
	{ name: 'TRIM', signature: 'TRIM(string)', isAggregate: false },
	{ name: 'CONCAT', signature: 'CONCAT(str1, str2, ...)', isAggregate: false },
	{ name: 'SUBSTRING', signature: 'SUBSTRING(string FROM start FOR length)', isAggregate: false },
	{ name: 'REPLACE', signature: 'REPLACE(string, from, to)', isAggregate: false },
	{ name: 'SPLIT_PART', signature: 'SPLIT_PART(string, delimiter, position)', isAggregate: false },
	{ name: 'ARRAY_AGG', signature: 'ARRAY_AGG(expression)', isAggregate: true },
	{ name: 'STRING_AGG', signature: 'STRING_AGG(expression, delimiter)', isAggregate: true },
	{ name: 'JSON_AGG', signature: 'JSON_AGG(expression)', isAggregate: true },
	{ name: 'JSONB_AGG', signature: 'JSONB_AGG(expression)', isAggregate: true },
	{ name: 'ROW_NUMBER', signature: 'ROW_NUMBER() OVER (...)', isAggregate: false },
	{ name: 'RANK', signature: 'RANK() OVER (...)', isAggregate: false },
	{ name: 'DENSE_RANK', signature: 'DENSE_RANK() OVER (...)', isAggregate: false },
	{ name: 'LAG', signature: 'LAG(expression, offset, default) OVER (...)', isAggregate: false },
	{ name: 'LEAD', signature: 'LEAD(expression, offset, default) OVER (...)', isAggregate: false },
	{ name: 'FIRST_VALUE', signature: 'FIRST_VALUE(expression) OVER (...)', isAggregate: false },
	{ name: 'LAST_VALUE', signature: 'LAST_VALUE(expression) OVER (...)', isAggregate: false },
	{ name: 'GENERATE_SERIES', signature: 'GENERATE_SERIES(start, stop, step)', isAggregate: false },
];

/**
 * Internal completion item with scoring data.
 */
interface InternalCompletionItem extends ScoredCompletionItem {
	label: string;
	detail?: string;
	documentation?: string;
	kind: vscode.CompletionItemKind;
	insertText?: string;
	sortText?: string;
}

/**
 * Generate completions for a SQL document at the given position.
 *
 * @param sql - The full SQL text
 * @param offset - The cursor offset (character position)
 * @param schema - The database schema from .kozani/ YAML files
 * @returns Array of completion items
 */
export async function complete(
	sql: string,
	offset: number,
	schema: ConnectionSchema | undefined
): Promise<vscode.CompletionItem[]> {
	// Reset debug counters
	resetFilterDebug();
	resetScoringDebug();

	debug(`complete: sql=${JSON.stringify(sql)}, offset=${offset}`);

	// Debug: print tree structure
	const tree = await treeSitterParser.parseAsync(sql);
	debug(`complete: tree structure for debugging:`);
	function printNode(node: any, indent: string = ''): void {
		const range = `[${node.startIndex}-${node.endIndex}]`;
		const text = node.text.length > 20 ? node.text.substring(0, 20) + '...' : node.text;
		debug(`${indent}${node.type} ${range} "${text}"`);
		for (let i = 0; i < node.childCount && i < 10; i++) {
			printNode(node.child(i), indent + '  ');
		}
	}
	printNode(tree.rootNode);

	// Parse and analyze context
	const ctx = await createSqlContext(sql, offset);

	debug(`complete: context created`);
	debug(`  nodeUnderCursor: ${ctx.nodeUnderCursor.type} = "${ctx.nodeUnderCursor.text}"`);
	debug(`  wrappingClause: ${ctx.wrappingClause}`);
	debug(`  wrappingNodeKind: ${ctx.wrappingNodeKind}`);
	debug(`  isInvocation: ${ctx.isInvocation}`);
	debug(`  qualifiers: [${ctx.getHeadQualifier()}, ${ctx.getTailQualifier()}]`);
	debug(`  mentionedRelations: ${JSON.stringify(ctx.getAllMentionedRelations())}`);
	debug(`  tableAliases: ${JSON.stringify(ctx.getAllTableAliases())}`);

	// Collect all potential completions
	const candidates: InternalCompletionItem[] = [];

	// Add schema-based completions if available
	if (schema) {
		// Tables
		for (const table of schema.tablesByFullName.values()) {
			candidates.push(createTableItem(table));
		}

		// Columns from tables in the query
		const mentionedRelations = ctx.getAllMentionedRelations();
		const tableAliases = ctx.getAllTableAliases();

		if (mentionedRelations.length > 0 || tableAliases.length > 0) {
			// Add columns from mentioned tables
			for (const relation of mentionedRelations) {
				const tables = findTables(relation, schema);
				for (const table of tables) {
					for (const column of table.columns) {
						candidates.push(createColumnItem(column, table));
					}
				}
			}

			// Add columns from aliased tables
			for (const alias of tableAliases) {
				const tables = findTables({ schema: alias.schema, table: alias.table }, schema);
				for (const table of tables) {
					for (const column of table.columns) {
						candidates.push(createColumnItem(column, table));
					}
				}
			}
		} else {
			// No tables mentioned yet - add all columns (less ideal but still useful)
			for (const table of schema.tablesByFullName.values()) {
				for (const column of table.columns) {
					candidates.push(createColumnItem(column, table));
				}
			}
		}
	}

	// Add functions
	for (const func of PG_FUNCTIONS) {
		candidates.push(createFunctionItem(func));
	}

	// Add keywords
	for (const keyword of SQL_KEYWORDS) {
		candidates.push(createKeywordItem(keyword));
	}

	debug(`complete: generated ${candidates.length} candidates`);
	debug(`  tables: ${candidates.filter(c => c.type === 'table').length}`);
	debug(`  columns: ${candidates.filter(c => c.type === 'column').length}`);
	debug(`  functions: ${candidates.filter(c => c.type === 'function').length}`);
	debug(`  keywords: ${candidates.filter(c => c.type === 'keyword').length}`);

	// Filter and score
	let filterStats = { passed: 0, failed: 0, failedReasons: new Map<string, number>() };
	const relevantItems = candidates.filter(item => {
		const relevanceData: CompletionRelevanceData = {
			type: item.type,
			schema: item.schema,
			tableName: item.tableName,
			isAggregate: item.isAggregate,
		};
		const result = isRelevant(relevanceData, ctx);
		if (result) {
			filterStats.passed++;
		} else {
			filterStats.failed++;
		}
		return result;
	});

	debug(`complete: filtering result - passed: ${filterStats.passed}, failed: ${filterStats.failed}`);

	// Calculate scores and sort
	const scoredItems = relevantItems.map(item => ({
		...item,
		score: calculateScore(item, ctx),
	}));

	// Filter out very low scores and sort
	const sortedItems = scoredItems
		.filter(item => (item.score ?? 0) > -500)
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	// Debug: show score distribution (after sorting)
	const lowScoreCount = scoredItems.filter(item => (item.score ?? 0) <= -500).length;
	debug(`complete: scoring - passed: ${sortedItems.length}, filtered (fuzzy skip): ${lowScoreCount}`);
	if (sortedItems.length > 0) {
		// Show by type breakdown
		const byType = new Map<string, number>();
		for (const item of sortedItems) {
			byType.set(item.type, (byType.get(item.type) || 0) + 1);
		}
		debug(`  breakdown: ${Array.from(byType.entries()).map(([k, v]) => `${k}=${v}`).join(', ')}`);

		// Show top 5 (sorted by score)
		const top5 = sortedItems.slice(0, 5).map(i => `${i.type}:${i.label}(${i.score})`);
		debug(`  top 5 (sorted): ${top5.join(', ')}`);
	}

	// Convert to VS Code completion items
	return sortedItems.map((item, index) => createVSCodeItem(item, index));
}

/**
 * Find tables matching a relation reference.
 */
function findTables(
	relation: { schema?: string; table: string },
	schema: ConnectionSchema
): TableInfo[] {
	if (relation.schema) {
		const fullName = `${relation.schema}.${relation.table}`;
		const table = schema.tablesByFullName.get(fullName);
		return table ? [table] : [];
	}

	// No schema - look up by short name
	return schema.tablesByName.get(relation.table) || [];
}

/**
 * Create an internal completion item for a table.
 */
function createTableItem(table: TableInfo): InternalCompletionItem {
	// allow-any-unicode-next-line
	const icon = table.isView ? '👁️' : '📋';
	return {
		name: table.name,
		label: table.fullName,
		type: 'table',
		schema: table.schema,
		tableName: table.name,
		kind: vscode.CompletionItemKind.Class,
		detail: `${icon} ${table.isView ? 'View' : 'Table'} (${table.columns.length} columns)`,
		documentation: table.description,
	};
}

/**
 * Create an internal completion item for a column.
 */
function createColumnItem(column: ColumnInfo, table: TableInfo): InternalCompletionItem {
	// allow-any-unicode-next-line
	const pk = column.primaryKey ? ' 🔑' : '';
	return {
		name: column.name,
		label: column.name,
		type: 'column',
		schema: table.schema,
		tableName: table.name,
		isPrimaryKey: column.primaryKey,
		kind: vscode.CompletionItemKind.Field,
		detail: `${column.type}${pk}`,
		documentation: column.description
			? `**${table.fullName}.${column.name}**\n\n${column.description}`
			: `Column in \`${table.fullName}\`\n\n**Type:** \`${column.type}\`\n**Nullable:** ${column.nullable ? 'Yes' : 'No'}`,
	};
}

/**
 * Create an internal completion item for a function.
 */
function createFunctionItem(func: { name: string; signature: string; isAggregate: boolean }): InternalCompletionItem {
	return {
		name: func.name,
		label: func.name,
		type: 'function',
		schema: 'pg_catalog',
		isAggregate: func.isAggregate,
		kind: vscode.CompletionItemKind.Function,
		detail: func.signature,
		insertText: func.name + '($0)',
	};
}

/**
 * Create an internal completion item for a keyword.
 */
function createKeywordItem(keyword: string): InternalCompletionItem {
	return {
		name: keyword,
		label: keyword,
		type: 'keyword',
		kind: vscode.CompletionItemKind.Keyword,
		detail: 'SQL keyword',
	};
}

/**
 * Convert an internal completion item to a VS Code completion item.
 */
function createVSCodeItem(item: InternalCompletionItem, index: number): vscode.CompletionItem {
	const completionItem = new vscode.CompletionItem(item.label, item.kind);

	if (item.detail) {
		completionItem.detail = item.detail;
	}

	if (item.documentation) {
		completionItem.documentation = new vscode.MarkdownString(item.documentation);
	}

	if (item.insertText) {
		completionItem.insertText = new vscode.SnippetString(item.insertText);
	}

	// Use score for sorting (pad index to maintain stable sort)
	const scorePart = Math.max(0, 1000 - (item.score ?? 0)).toString().padStart(4, '0');
	const indexPart = index.toString().padStart(4, '0');
	completionItem.sortText = `${scorePart}_${indexPart}_${item.label}`;

	// Preselect highest scoring item
	if (index === 0 && (item.score ?? 0) > 0) {
		completionItem.preselect = true;
	}

	return completionItem;
}

