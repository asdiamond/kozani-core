/**
 * Completion Scoring - Ranks completion items by relevance.
 *
 * Ported from postgres-language-server's scoring.rs (Rust).
 * Uses the SqlContext to calculate a score for each completion item based on:
 * - Fuzzy match quality with current input
 * - Clause type appropriateness
 * - Whether the item's table is mentioned in the query
 * - Schema preferences (user-defined vs system)
 * - Invocation context (functions vs other)
 */

import { SqlContext, WrappingClause } from '../parser/SqlContext';
import { debug } from '../../debug';

// Enable verbose scoring debug (set to true to debug scores)
const DEBUG_SCORING = true;
let debuggedItems = 0;
const MAX_DEBUG_ITEMS = 10;

export function resetScoringDebug(): void {
	debuggedItems = 0;
}

/**
 * Completion item with scoring data.
 */
export interface ScoredCompletionItem {
	/** Name of the item (used for fuzzy matching) */
	name: string;
	/** Type of completion */
	type: 'table' | 'column' | 'function' | 'schema' | 'keyword';
	/** Schema name */
	schema?: string;
	/** Table name (for columns) */
	tableName?: string;
	/** Whether this is a primary key (for columns) */
	isPrimaryKey?: boolean;
	/** Whether this is an aggregate function */
	isAggregate?: boolean;
	/** The calculated score */
	score?: number;
}

/**
 * System schemas that should be ranked lower.
 */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

/**
 * Calculate a relevance score for a completion item.
 *
 * @param item - The completion item to score
 * @param ctx - The SQL context at cursor position
 * @returns The calculated score (higher = more relevant)
 */
export function calculateScore(item: ScoredCompletionItem, ctx: SqlContext): number {
	let score = 0;
	const shouldLog = DEBUG_SCORING && debuggedItems < MAX_DEBUG_ITEMS && item.type === 'column';

	// 1. User-defined vs system objects
	const userDefinedScore = scoreUserDefined(item);
	score += userDefinedScore;

	// 2. Schema match bonus
	const schemaMatchScore = scoreSchemaMatch(item, ctx);
	score += schemaMatchScore;

	// 3. Fuzzy match with current input
	const fuzzyResult = scoreFuzzyMatch(item, ctx);
	score += fuzzyResult.score;
	if (fuzzyResult.skip) {
		if (shouldLog) {
			debug(`  SCORE SKIP ${item.type}:${item.name} - fuzzy skip`);
			debuggedItems++;
		}
		return -1000; // Mark for exclusion
	}

	// 4. Invocation context
	const invocationScore = scoreInvocationContext(item, ctx);
	score += invocationScore;

	// 5. Clause type appropriateness
	const clauseScore = scoreClauseType(item, ctx);
	score += clauseScore;

	// 6. Empty input bonus
	const withoutContentScore = scoreWithoutContent(item, ctx);
	score += withoutContentScore;

	// 7. Mentioned relations bonus
	const mentionedRelScore = scoreMentionedRelations(item, ctx);
	score += mentionedRelScore;

	// 8. Already mentioned columns penalty
	const mentionedColScore = scoreMentionedColumns(item, ctx);
	score += mentionedColScore;

	// 9. Known migration tables penalty
	const migrationScore = scoreMigrationPenalty(item);
	score += migrationScore;

	if (shouldLog) {
		debug(`  SCORE ${item.type}:${item.tableName}.${item.name} = ${score} (userDef=${userDefinedScore}, schema=${schemaMatchScore}, fuzzy=${fuzzyResult.score}, invocation=${invocationScore}, clause=${clauseScore}, withoutContent=${withoutContentScore}, mentionedRel=${mentionedRelScore}, mentionedCol=${mentionedColScore}, migration=${migrationScore})`);
		debuggedItems++;
	}

	return score;
}

/**
 * Prefer user-defined objects over system objects.
 */
function scoreUserDefined(item: ScoredCompletionItem): number {
	if (!item.schema) {
		return 0;
	}

	if (SYSTEM_SCHEMAS.includes(item.schema)) {
		return -20;
	}

	// Slight preference for public schema
	if (item.schema === 'public') {
		return item.type === 'schema' ? -2 : 2;
	}

	return 0;
}

/**
 * Bonus when schema qualifier matches item's schema.
 */
function scoreSchemaMatch(item: ScoredCompletionItem, ctx: SqlContext): number {
	let schemaFromQualifier: string | undefined;

	if (item.type === 'table' || item.type === 'function') {
		schemaFromQualifier = ctx.getTailQualifier();
	} else if (item.type === 'column') {
		schemaFromQualifier = ctx.getHeadQualifier();
	}

	if (!schemaFromQualifier || !item.schema) {
		return 0;
	}

	if (schemaFromQualifier === item.schema) {
		return 25;
	} else {
		return -10;
	}
}

/**
 * Simple fuzzy match scoring.
 * Returns score and whether to skip (no match at all).
 */
function scoreFuzzyMatch(
	item: ScoredCompletionItem,
	ctx: SqlContext
): { score: number; skip: boolean } {
	const content = ctx.getNodeUnderCursorText();
	const nodeType = ctx.nodeUnderCursor.type;

	// Skip fuzzy matching if cursor is on a keyword, token, or structural node
	// These nodes don't represent user-typed identifiers
	if (!content ||
		nodeType.startsWith('keyword_') ||
		nodeType === 'select' ||
		nodeType === 'from' ||
		nodeType === 'where' ||
		nodeType === 'join' ||
		nodeType === 'statement' ||
		nodeType === 'program' ||
		content === ',' || content === '=' || content === '(') {
		// No content to match against - accept all
		return { score: 0, skip: false };
	}

	// If content looks like SQL syntax rather than an identifier, don't filter
	if (content.includes(' ') || content.includes('*')) {
		return { score: 0, skip: false };
	}

	// Clean up content
	const cleanContent = content.replace(/"/g, '').toLowerCase();
	if (cleanContent.length === 0) {
		return { score: 0, skip: false };
	}

	const itemName = item.name.toLowerCase();

	// Determine what to match against based on qualifiers
	let checkAgainst = itemName;

	const tailQualifier = ctx.getTailQualifier();
	const headQualifier = ctx.getHeadQualifier();

	if (headQualifier && tailQualifier) {
		// Both qualifiers present - match against name only
		checkAgainst = itemName;
	} else if (tailQualifier) {
		// One qualifier - check if it's schema, table, or alias
		if (item.schema === tailQualifier) {
			// Schema matched - check table.name or just name
			checkAgainst = item.tableName ? `${item.tableName}.${itemName}` : itemName;
		} else if (item.tableName === tailQualifier) {
			// Table matched - check name
			checkAgainst = itemName;
		} else {
			// Check if qualifier is an alias
			const tableAlias = ctx.getTableForAlias(tailQualifier);
			if (tableAlias && item.tableName === tableAlias.table) {
				checkAgainst = itemName;
			} else {
				// Qualifier doesn't match - skip unless typing
				if (cleanContent.length > 0) {
					return { score: 0, skip: true };
				}
			}
		}
	} else {
		// No qualifier - include alias prefix for columns
		if (item.type === 'column' && item.tableName) {
			const alias = ctx.getAliasForTable(item.tableName);
			if (alias) {
				checkAgainst = `${alias}.${itemName}`;
			}
		}
	}

	// Simple prefix/substring matching
	const checkAgainstLower = checkAgainst.toLowerCase();

	if (checkAgainstLower.startsWith(cleanContent)) {
		// Prefix match - high score
		return { score: 20 + Math.min(cleanContent.length * 3, 30), skip: false };
	}

	if (checkAgainstLower.includes(cleanContent)) {
		// Substring match - medium score
		return { score: 10 + Math.min(cleanContent.length * 2, 20), skip: false };
	}

	// No match - check if we should skip
	if (cleanContent.length >= 2) {
		// Character-by-character fuzzy match
		let matchScore = 0;
		let lastMatchIndex = -1;
		for (const char of cleanContent) {
			const index = checkAgainstLower.indexOf(char, lastMatchIndex + 1);
			if (index === -1) {
				return { score: 0, skip: true };
			}
			matchScore += index === lastMatchIndex + 1 ? 3 : 1;
			lastMatchIndex = index;
		}
		return { score: matchScore, skip: false };
	}

	return { score: 0, skip: true };
}

/**
 * Score based on invocation context (function calls).
 */
function scoreInvocationContext(item: ScoredCompletionItem, ctx: SqlContext): number {
	if (ctx.isInvocation) {
		if (item.type === 'function') {
			return 30;
		}
		return -10;
	} else {
		if (item.type === 'function') {
			return -10;
		}
	}
	return 0;
}

/**
 * Score based on clause type appropriateness.
 */
function scoreClauseType(item: ScoredCompletionItem, ctx: SqlContext): number {
	if (!ctx.wrappingClause) {
		return 0;
	}

	const hasMentionedTables = ctx.hasAnyMentionedRelations();
	const hasQualifier = ctx.hasAnyQualifier();

	switch (item.type) {
		case 'table':
			return scoreTableInClause(ctx.wrappingClause, ctx);

		case 'function':
			return scoreFunctionInClause(ctx.wrappingClause, hasMentionedTables);

		case 'column':
			return scoreColumnInClause(ctx.wrappingClause, hasMentionedTables, item, ctx);

		case 'schema':
			return scoreSchemaInClause(ctx.wrappingClause, hasQualifier);

		default:
			return 0;
	}
}

function scoreTableInClause(clause: WrappingClause, ctx: SqlContext): number {
	switch (clause) {
		case 'update':
		case 'delete':
			return 10;
		case 'from':
			return 5;
		case 'join':
			return ctx.isAfterJoinOn() ? -50 : 5;
		default:
			return -50;
	}
}

function scoreFunctionInClause(clause: WrappingClause, hasMentionedTables: boolean): number {
	switch (clause) {
		case 'select':
			return hasMentionedTables ? 0 : 15;
		case 'from':
		case 'checkOrUsingClause':
			return 0;
		default:
			return -50;
	}
}

function scoreColumnInClause(
	clause: WrappingClause,
	hasMentionedTables: boolean,
	item: ScoredCompletionItem,
	ctx: SqlContext
): number {
	switch (clause) {
		case 'select':
			return hasMentionedTables ? 10 : 0;
		case 'where':
		case 'checkOrUsingClause':
			return 10;
		case 'join':
			if (!ctx.isAfterJoinOn()) {
				return -50;
			}
			// Prefer primary keys for join conditions
			return item.isPrimaryKey ? 20 : 10;
		default:
			return -15;
	}
}

function scoreSchemaInClause(clause: WrappingClause, hasQualifier: boolean): number {
	if (hasQualifier) {
		return -50;
	}

	switch (clause) {
		case 'from':
		case 'join':
		case 'update':
		case 'delete':
		case 'alterPolicy':
		case 'dropPolicy':
		case 'createPolicy':
			return 15;
		default:
			return -50;
	}
}

/**
 * Score when there's no content typed yet.
 */
function scoreWithoutContent(item: ScoredCompletionItem, ctx: SqlContext): number {
	const content = ctx.getNodeUnderCursorText();
	if (content && content.length > 0 &&
		!content.startsWith('keyword_') && content !== ',') {
		return 0;
	}

	const nodeKind = ctx.nodeUnderCursor.type;

	switch (nodeKind) {
		case 'function_identifier':
		case 'table_identifier':
			if (item.schema === 'public') {
				return 10;
			}
			break;

		case 'schema_identifier':
			if (item.schema && item.schema !== 'public') {
				return 10;
			}
			break;

		case 'any_identifier':
			if (item.type === 'table' && item.schema === 'public') {
				return 20;
			}
			if (item.type === 'schema' && item.schema !== 'public') {
				return 10;
			}
			if (item.type === 'schema' && item.schema === 'public') {
				return -20;
			}
			break;
	}

	return 0;
}

/**
 * Bonus when item's table is mentioned in the query.
 */
function scoreMentionedRelations(item: ScoredCompletionItem, ctx: SqlContext): number {
	// Only applies to columns
	if (item.type === 'table' || item.type === 'function') {
		return 0;
	}

	if (!item.tableName) {
		return 0;
	}

	// Check if table is mentioned with schema
	if (item.schema) {
		const tablesInSchema = ctx.getMentionedRelations(item.schema);
		if (tablesInSchema?.has(item.tableName)) {
			return 45;
		}
	}

	// Check if table is mentioned without schema
	const tablesWithoutSchema = ctx.getMentionedRelations(undefined);
	if (tablesWithoutSchema?.has(item.tableName)) {
		return 30;
	}

	return 0;
}

/**
 * Penalty for columns already mentioned in the current clause.
 */
function scoreMentionedColumns(item: ScoredCompletionItem, ctx: SqlContext): number {
	if (item.type !== 'column') {
		return 0;
	}

	const mentionedColumns = ctx.getMentionedColumns(ctx.wrappingClause);
	if (!mentionedColumns) {
		return 0;
	}

	for (const mentioned of mentionedColumns) {
		const columnMatch = mentioned.column.replace(/"/g, '') === item.name;

		if (mentioned.alias) {
			// Check if alias matches the table
			const aliasTable = ctx.getTableForAlias(mentioned.alias);
			if (columnMatch && (!aliasTable || aliasTable.table === item.tableName)) {
				return -10;
			}
		} else if (columnMatch) {
			return -10;
		}
	}

	return 0;
}

/**
 * Penalty for migration-related tables.
 * Port of Rust's check_is_user_defined migration part + check_is_not_wellknown_migration
 */
function scoreMigrationPenalty(item: ScoredCompletionItem): number {
	let penalty = 0;

	// From check_is_user_defined: ONE -15 if any migration match
	const itemName = item.name;
	const tableName = item.tableName;
	const schemaName = item.schema;

	if (itemName.includes('migrations') ||
		(tableName && tableName.includes('migrations')) ||
		(schemaName && schemaName.includes('migrations'))) {
		penalty -= 15;
	}

	// From check_is_not_wellknown_migration: additional -10 for specific names
	if (tableName === '_sqlx_migrations') {
		penalty -= 10;
	}
	if (schemaName === 'supabase_migrations') {
		penalty -= 10;
	}

	return penalty;
}

/**
 * Sort completion items by score (highest first).
 */
export function sortByScore<T extends ScoredCompletionItem>(
	items: T[],
	ctx: SqlContext
): T[] {
	return items
		.map(item => ({
			...item,
			score: calculateScore(item, ctx)
		}))
		.filter(item => (item.score ?? 0) > -500) // Filter out very low scores
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

