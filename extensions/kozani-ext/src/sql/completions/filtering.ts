/**
 * Completion Filtering - Determines which completions are relevant in a given context.
 *
 * Ported from postgres-language-server's filtering.rs (Rust).
 * Uses the SqlContext to filter out irrelevant completions based on:
 * - Cursor position (not on keywords, ERROR nodes, etc.)
 * - SQL clause (tables in FROM, columns in SELECT/WHERE, etc.)
 * - Qualifier matching (schema.table prefix)
 * - Invocation context (no tables inside function calls)
 */

import { SqlContext, WrappingClause } from '../parser/SqlContext';
import { debug } from '../../debug';

// Set this to true to enable verbose filtering logs
const VERBOSE_FILTER_DEBUG = true;

/**
 * Types of completion items we can suggest.
 */
export type CompletionItemType =
	| 'table'
	| 'column'
	| 'function'
	| 'schema'
	| 'keyword';

/**
 * Data about a completion item for filtering decisions.
 */
export interface CompletionRelevanceData {
	type: CompletionItemType;
	/** Schema name for tables/columns/functions */
	schema?: string;
	/** Table name for columns */
	tableName?: string;
	/** Whether this is an aggregate function */
	isAggregate?: boolean;
}

// Track first few filtering decisions for debug
let debugLogCount = 0;
const MAX_DEBUG_LOGS = 5;

/**
 * Check if a completion item is relevant in the given SQL context.
 *
 * @param item - The completion item data
 * @param ctx - The SQL context at cursor position
 * @returns true if the item should be shown, false to filter it out
 */
export function isRelevant(item: CompletionRelevanceData, ctx: SqlContext): boolean {
	const shouldLog = VERBOSE_FILTER_DEBUG && debugLogCount < MAX_DEBUG_LOGS;

	// 1. Check if we're in a completable context
	if (!isCompletableContext(item, ctx)) {
		if (shouldLog) {
			debug(`isRelevant: REJECT ${item.type} - not completable context`);
			debugLogCount++;
		}
		return false;
	}

	// 2. Check node type or clause type
	if (!checkNodeTypeOrClause(item, ctx)) {
		if (shouldLog) {
			debug(`isRelevant: REJECT ${item.type} - checkNodeTypeOrClause failed`);
			debugLogCount++;
		}
		return false;
	}

	// 3. Check invocation context (no tables/columns inside function calls)
	if (!checkInvocationContext(item, ctx)) {
		if (shouldLog) {
			debug(`isRelevant: REJECT ${item.type} - checkInvocationContext failed`);
			debugLogCount++;
		}
		return false;
	}

	// 4. Check qualifier matching (schema.table prefix)
	if (!checkQualifierMatch(item, ctx)) {
		if (shouldLog) {
			debug(`isRelevant: REJECT ${item.type} - checkQualifierMatch failed`);
			debugLogCount++;
		}
		return false;
	}

	if (shouldLog) {
		debug(`isRelevant: ACCEPT ${item.type}`);
	}
	return true;
}

/** Reset debug log count (call at start of each completion request) */
export function resetFilterDebug(): void {
	debugLogCount = 0;
}

/**
 * Check if we're in a context where completions make sense.
 */
function isCompletableContext(item: CompletionRelevanceData, ctx: SqlContext): boolean {
	// Must have some wrapping context
	if (!ctx.wrappingClause && !ctx.wrappingNodeKind) {
		if (VERBOSE_FILTER_DEBUG && debugLogCount < MAX_DEBUG_LOGS) {
			debug(`isCompletableContext: FAIL - no wrappingClause (${ctx.wrappingClause}) and no wrappingNodeKind (${ctx.wrappingNodeKind})`);
		}
		return false;
	}

	const nodeKind = ctx.nodeUnderCursor.type;

	// Don't complete on keywords, operators, or ERROR nodes
	if (nodeKind.startsWith('keyword_') ||
		nodeKind === '=' ||
		nodeKind === ',' ||
		nodeKind === 'ERROR') {
		return false;
	}

	// Check previous sibling for ERROR (common in incomplete statements)
	const prevSibling = ctx.nodeUnderCursor.previousSibling;
	if (prevSibling && prevSibling.type === 'ERROR') {
		return false;
	}

	// Handle literal nodes (quoted identifiers like "email")
	if (nodeKind === 'literal') {
		if (item.type === 'column') {
			const allowedClauses: WrappingClause[] = [
				'select', 'where', 'join', 'update', 'delete', 'insert',
				'dropColumn', 'alterColumn', 'renameColumn'
			];
			if (!ctx.wrappingClause || !allowedClauses.includes(ctx.wrappingClause)) {
				return false;
			}
		} else {
			return false;
		}
	}

	// Don't complete on alias definitions
	if (nodeKind === 'any_identifier') {
		// Check if this is an alias definition (after a table reference)
		const parent = ctx.nodeUnderCursor.parent;
		if (parent && parent.type === 'alias') {
			return false;
		}
	}

	// No completions if there are two identifiers without a separator
	if (prevSibling &&
		(prevSibling.type === 'any_identifier' || prevSibling.type === 'object_reference') &&
		nodeKind === 'any_identifier') {
		return false;
	}

	// No completions right after asterisk (SELECT * |)
	if (prevSibling && prevSibling.type === 'all_fields' && nodeKind === 'any_identifier') {
		return false;
	}

	return true;
}

/**
 * Check if the item type is valid for the specific node type or clause.
 */
function checkNodeTypeOrClause(item: CompletionRelevanceData, ctx: SqlContext): boolean {
	// First try specific node type check
	if (checkSpecificNodeType(item, ctx)) {
		return true;
	}

	// Fall back to clause-based check
	return checkClause(item, ctx);
}

/**
 * Check based on specific node types (column_identifier, table_identifier, etc.)
 */
function checkSpecificNodeType(item: CompletionRelevanceData, ctx: SqlContext): boolean {
	const nodeKind = ctx.nodeUnderCursor.type;

	switch (nodeKind) {
		case 'column_identifier':
			return item.type === 'column';

		case 'table_identifier':
			return item.type === 'table';

		case 'schema_identifier':
			return item.type === 'schema';

		case 'function_identifier':
			return item.type === 'function';

		case 'any_identifier':
			// any_identifier can be many things - check context
			return checkAnyIdentifierContext(item, ctx);

		default:
			return false;
	}
}

/**
 * Check what types are valid for an any_identifier node.
 */
function checkAnyIdentifierContext(item: CompletionRelevanceData, ctx: SqlContext): boolean {
	switch (item.type) {
		case 'column':
			// Columns are valid in object_reference and column_reference
			return ctx.isWithinNodeType('object_reference', 'column_reference');

		case 'table':
			// Tables are valid in object_reference, table_reference, column_reference
			return ctx.isWithinNodeType('object_reference', 'table_reference', 'column_reference');

		case 'schema':
			// Schemas are valid as the first part of any reference
			return ctx.isWithinNodeType(
				'object_reference', 'table_reference', 'column_reference',
				'type_reference', 'function_reference'
			) && !ctx.hasAnyQualifier();

		case 'function':
			// Functions are valid in object_reference and function_reference
			return ctx.isWithinNodeType('object_reference', 'function_reference');

		case 'keyword':
			return true;

		default:
			return false;
	}
}

/**
 * Check if the item is valid based on the wrapping clause.
 */
function checkClause(item: CompletionRelevanceData, ctx: SqlContext): boolean {
	if (!ctx.wrappingClause) {
		return item.type === 'keyword';
	}

	switch (item.type) {
		case 'table':
			return checkTableInClause(ctx);

		case 'column':
			return checkColumnInClause(ctx);

		case 'function':
			return checkFunctionInClause(ctx);

		case 'schema':
			return checkSchemaInClause(ctx);

		case 'keyword':
			return true;

		default:
			return false;
	}
}

/**
 * Check if tables are valid in the current clause.
 */
function checkTableInClause(ctx: SqlContext): boolean {
	switch (ctx.wrappingClause) {
		case 'from':
			return true;

		case 'update':
			// Not valid in assignment context (SET col = val)
			return ctx.wrappingNodeKind !== 'assignment';

		case 'join':
			// Tables are valid before the ON keyword
			return !ctx.isAfterJoinOn();

		case 'insert':
			// Valid after INSERT INTO, not in column list
			return ctx.wrappingNodeKind !== 'list';

		case 'dropTable':
		case 'alterTable':
			return true;

		case 'createPolicy':
		case 'alterPolicy':
		case 'dropPolicy':
			return true;

		default:
			return false;
	}
}

/**
 * Check if columns are valid in the current clause.
 */
function checkColumnInClause(ctx: SqlContext): boolean {
	switch (ctx.wrappingClause) {
		case 'select':
		case 'update':
		case 'delete':
		case 'dropColumn':
		case 'groupBy':
		case 'orderBy':
		case 'having':
			return true;

		case 'renameColumn':
		case 'alterColumn':
			return true;

		case 'join':
			// Columns are valid only after the ON keyword
			return ctx.isAfterJoinOn();

		case 'insert':
			// Valid in column list
			return ctx.wrappingNodeKind === 'list';

		case 'where':
			return true;

		case 'checkOrUsingClause':
			return true;

		default:
			return false;
	}
}

/**
 * Check if functions are valid in the current clause.
 */
function checkFunctionInClause(ctx: SqlContext): boolean {
	switch (ctx.wrappingClause) {
		case 'from':
		case 'select':
		case 'where':
		case 'join':
		case 'groupBy':
		case 'orderBy':
		case 'having':
			return true;

		case 'checkOrUsingClause':
			// Aggregate functions not allowed in CHECK/USING
			return true; // We could check isAggregate here

		default:
			return false;
	}
}

/**
 * Check if schemas are valid in the current clause.
 */
function checkSchemaInClause(ctx: SqlContext): boolean {
	switch (ctx.wrappingClause) {
		case 'select':
		case 'from':
		case 'join':
		case 'update':
		case 'delete':
		case 'where':
			return !ctx.hasAnyQualifier(); // Only valid at start

		case 'dropTable':
		case 'alterTable':
			return !ctx.hasAnyQualifier();

		case 'insert':
			return ctx.wrappingNodeKind !== 'list' && !ctx.hasAnyQualifier();

		case 'createPolicy':
		case 'alterPolicy':
		case 'dropPolicy':
			return !ctx.hasAnyQualifier();

		default:
			return false;
	}
}

/**
 * Check invocation context - tables and columns are not valid inside function calls.
 */
function checkInvocationContext(item: CompletionRelevanceData, ctx: SqlContext): boolean {
	if (!ctx.isInvocation) {
		return true;
	}

	// Tables and columns are not valid inside function invocations
	if (item.type === 'table' || item.type === 'column') {
		return false;
	}

	return true;
}

/**
 * Check if the item's schema/table matches the qualifiers in the context.
 */
function checkQualifierMatch(item: CompletionRelevanceData, ctx: SqlContext): boolean {
	const tailQualifier = ctx.getTailQualifier();

	// No qualifier - all items pass this check
	if (!tailQualifier) {
		return true;
	}

	switch (item.type) {
		case 'table':
			// Qualifier should be the schema
			return item.schema === tailQualifier;

		case 'function':
			// Qualifier should be the schema
			return item.schema === tailQualifier;

		case 'column':
			// Qualifier could be table name or alias
			if (!item.tableName) {
				return false;
			}

			// Check if qualifier is a table alias
			const tableAlias = ctx.getTableForAlias(tailQualifier);
			const tableName = tableAlias ? tableAlias.table : tailQualifier;

			// Column's table must match
			if (item.tableName !== tableName) {
				return false;
			}

			// If there's also a head qualifier (schema), check it too
			const headQualifier = ctx.getHeadQualifier();
			if (headQualifier && item.schema !== headQualifier) {
				return false;
			}

			return true;

		case 'schema':
			// If there's already a qualifier, no more schemas
			return false;

		case 'keyword':
			return true;

		default:
			return false;
	}
}

/**
 * Filter a list of completion items based on context.
 *
 * @param items - Array of items with type and optional schema/tableName
 * @param ctx - The SQL context
 * @returns Filtered array of relevant items
 */
export function filterCompletions<T extends CompletionRelevanceData>(
	items: T[],
	ctx: SqlContext
): T[] {
	return items.filter(item => isRelevant(item, ctx));
}

