/**
 * SqlContext - Context detection for SQL queries using tree-sitter.
 *
 * Ported from postgres-language-server's TreesitterContext (Rust).
 * Analyzes the AST to determine what clause the cursor is in, what tables
 * are referenced, and what qualifiers are present.
 */

import { SyntaxNode, Tree, treeSitterParser } from './TreeSitterParser';

/**
 * SQL clause types - determines what kind of completions are valid.
 */
export type WrappingClause =
	| 'select'
	| 'from'
	| 'where'
	| 'join'
	| 'update'
	| 'delete'
	| 'insert'
	| 'groupBy'
	| 'orderBy'
	| 'having'
	| 'alterTable'
	| 'dropTable'
	| 'dropColumn'
	| 'alterColumn'
	| 'renameColumn'
	| 'setStatement'
	| 'alterRole'
	| 'dropRole'
	| 'revokeStatement'
	| 'grantStatement'
	| 'createPolicy'
	| 'alterPolicy'
	| 'dropPolicy'
	| 'checkOrUsingClause'
	| 'columnDefinitions';

/**
 * Node kinds that give us context about what type of identifier we're completing.
 */
export type WrappingNodeKind =
	| 'relation'
	| 'binaryExpression'
	| 'assignment'
	| 'list';

/**
 * A column mentioned in the query.
 */
export interface MentionedColumn {
	column: string;
	alias?: string;
}

/**
 * A relation (table/view) mentioned in the query.
 */
export interface MentionedRelation {
	schema?: string;
	table: string;
}

/**
 * A table alias mapping.
 */
export interface TableAlias {
	alias: string;
	table: string;
	schema?: string;
}

/**
 * Join context - whether we're before or after the ON keyword.
 */
export interface JoinContext {
	onNodeStart?: number; // Character offset where ON keyword starts
}

/**
 * Context for SQL completions at a given cursor position.
 */
export class SqlContext {
	/** The deepest AST node at the cursor position */
	readonly nodeUnderCursor: SyntaxNode;

	/** The SQL text being analyzed */
	readonly text: string;

	/** The cursor position (character offset) */
	readonly position: number;

	/** The parsed syntax tree */
	readonly tree: Tree;

	/**
	 * Qualifiers for the identifier under cursor.
	 * - (undefined, undefined) = unqualified: `column`
	 * - (undefined, "table") = one qualifier: `table.column`
	 * - ("schema", "table") = two qualifiers: `schema.table.column`
	 */
	readonly identifierQualifiers: [string | undefined, string | undefined];

	/** What SQL clause the cursor is in */
	readonly wrappingClause: WrappingClause | undefined;

	/** The node kind that wraps the identifier (relation, binary_expression, etc) */
	readonly wrappingNodeKind: WrappingNodeKind | undefined;

	/** Whether the cursor is inside a function invocation */
	readonly isInvocation: boolean;

	/** Range of the containing statement (for scoping queries) */
	readonly statementRange: { startIndex: number; endIndex: number } | undefined;

	/** Join context if in a JOIN clause */
	readonly joinContext: JoinContext | undefined;

	/** Tables/views mentioned in FROM/JOIN clauses, keyed by schema (undefined for no schema) */
	private mentionedRelations: Map<string | undefined, Set<string>>;

	/** Alias to table mapping */
	private mentionedTableAliases: Map<string, TableAlias>;

	/** Columns mentioned in each clause */
	private mentionedColumns: Map<WrappingClause | undefined, Set<MentionedColumn>>;

	constructor(tree: Tree, position: number, text: string) {
		this.tree = tree;
		this.text = text;
		this.position = this.adjustPosition(position);

		this.mentionedRelations = new Map();
		this.mentionedTableAliases = new Map();
		this.mentionedColumns = new Map();

		// Initialize with defaults
		this.identifierQualifiers = [undefined, undefined];
		this.wrappingClause = undefined;
		this.wrappingNodeKind = undefined;
		this.isInvocation = false;
		this.statementRange = undefined;
		this.joinContext = undefined;
		this.nodeUnderCursor = tree.rootNode;

		// Gather context by walking the tree
		const result = this.gatherTreeContext();
		this.nodeUnderCursor = result.nodeUnderCursor;
		(this as { identifierQualifiers: [string | undefined, string | undefined] }).identifierQualifiers = result.identifierQualifiers;
		(this as { wrappingClause: WrappingClause | undefined }).wrappingClause = result.wrappingClause;
		(this as { wrappingNodeKind: WrappingNodeKind | undefined }).wrappingNodeKind = result.wrappingNodeKind;
		(this as { isInvocation: boolean }).isInvocation = result.isInvocation;
		(this as { statementRange: { startIndex: number; endIndex: number } | undefined }).statementRange = result.statementRange;
		(this as { joinContext: JoinContext | undefined }).joinContext = result.joinContext;

		// Run tree-sitter queries to extract tables, aliases, columns
		this.gatherInfoFromQueries();
	}

	/**
	 * Adjust cursor position to handle whitespace and special chars.
	 * When cursor is on whitespace or punctuation, move it back to the previous token.
	 */
	private adjustPosition(position: number): number {
		if (position === 0 || position > this.text.length) {
			return Math.min(position, Math.max(0, this.text.length - 1));
		}

		const charAtCursor = this.text[position];
		if (charAtCursor && /[\s;),(\[]/.test(charAtCursor)) {
			return Math.min(position - 1, Math.max(0, this.text.length - 1));
		}

		return Math.min(position, this.text.length - 1);
	}

	/**
	 * Walk the tree from root to cursor, gathering context along the way.
	 * This matches the Rust implementation's recursive approach.
	 */
	private gatherTreeContext(): {
		nodeUnderCursor: SyntaxNode;
		identifierQualifiers: [string | undefined, string | undefined];
		wrappingClause: WrappingClause | undefined;
		wrappingNodeKind: WrappingNodeKind | undefined;
		isInvocation: boolean;
		statementRange: { startIndex: number; endIndex: number } | undefined;
		joinContext: JoinContext | undefined;
	} {
		// State we accumulate while walking
		const state = {
			nodeUnderCursor: this.tree.rootNode as SyntaxNode,
			identifierQualifiers: [undefined, undefined] as [string | undefined, string | undefined],
			wrappingClause: undefined as WrappingClause | undefined,
			wrappingNodeKind: undefined as WrappingNodeKind | undefined,
			isInvocation: false,
			statementRange: undefined as { startIndex: number; endIndex: number } | undefined,
			joinContext: undefined as JoinContext | undefined,
		};

		// Find the first child that contains our position
		const firstChild = this.findChildContainingPosition(this.tree.rootNode, this.position);
		if (firstChild) {
			this.gatherContextRecursive(firstChild, this.tree.rootNode, state);
		}

		return state;
	}

	/**
	 * Find the child node that contains the given position.
	 * A node "contains" a position if: startIndex <= position < endIndex OR position == endIndex for the last char
	 */
	private findChildContainingPosition(parent: SyntaxNode, position: number): SyntaxNode | null {
		for (let i = 0; i < parent.childCount; i++) {
			const child = parent.child(i);
			if (!child) continue;

			// Check if this child's range contains our position
			// Use endIndex > position for most cases, but also handle position at endIndex
			if (child.startIndex <= position && child.endIndex > position) {
				return child;
			}
			// Handle edge case: position is exactly at the end
			if (child.endIndex === position && position > 0) {
				// Check if there's a next sibling that starts at this position
				const nextChild = parent.child(i + 1);
				if (!nextChild || nextChild.startIndex > position) {
					return child;
				}
			}
		}
		return null;
	}

	/**
	 * Recursively gather context from a node, similar to Rust's gather_context_from_node.
	 */
	private gatherContextRecursive(
		currentNode: SyntaxNode,
		parentNode: SyntaxNode,
		state: {
			nodeUnderCursor: SyntaxNode;
			identifierQualifiers: [string | undefined, string | undefined];
			wrappingClause: WrappingClause | undefined;
			wrappingNodeKind: WrappingNodeKind | undefined;
			isInvocation: boolean;
			statementRange: { startIndex: number; endIndex: number } | undefined;
			joinContext: JoinContext | undefined;
		}
	): void {
		const nodeKind = currentNode.type;
		const parentKind = parentNode.type;

		// Prevent infinite recursion on ERROR nodes
		if (nodeKind === parentKind && (parentKind === 'ERROR' || parentKind === 'program')) {
			state.nodeUnderCursor = currentNode;
			return;
		}

		// Track statement range
		if (nodeKind === 'statement' || nodeKind === 'subquery') {
			state.statementRange = {
				startIndex: currentNode.startIndex,
				endIndex: currentNode.endIndex,
			};
		}

		// Extract qualifiers from reference nodes
		if (nodeKind === 'object_reference' || nodeKind === 'column_reference') {
			state.identifierQualifiers = this.extractQualifiers(currentNode);
		} else if (nodeKind === 'table_reference' || nodeKind === 'type_reference' || nodeKind === 'function_reference') {
			const quals = this.extractQualifiers(currentNode);
			state.identifierQualifiers = [undefined, quals[1]];
		}

		// Track wrapping node kind
		if (nodeKind === 'relation' || nodeKind === 'binary_expression' || nodeKind === 'assignment') {
			state.wrappingNodeKind = this.nodeKindToWrappingNodeKind(nodeKind);
		} else if (nodeKind === 'list') {
			const prevSibling = currentNode.previousSibling;
			if (!prevSibling || prevSibling.type !== 'keyword_values') {
				state.wrappingNodeKind = 'list';
			}
		} else if (nodeKind === 'insert_columns') {
			state.wrappingNodeKind = 'list';
		}

		// Track invocation
		if (nodeKind === 'invocation') {
			state.isInvocation = true;
		}

		// Track wrapping clause
		const clause = this.getWrappingClauseFromNode(currentNode);
		if (clause) {
			state.wrappingClause = clause.clause;
			if (clause.joinContext) {
				state.joinContext = clause.joinContext;
			}
		}

		// Check if we've reached a leaf node
		if (currentNode.childCount === 0) {
			state.nodeUnderCursor = currentNode;
			return;
		}

		// Find child that contains our position
		const childAtPosition = this.findChildContainingPosition(currentNode, this.position);
		if (!childAtPosition) {
			state.nodeUnderCursor = currentNode;
			return;
		}

		// Recurse into the child
		this.gatherContextRecursive(childAtPosition, currentNode, state);
	}

	/**
	 * Extract schema/table qualifiers from a reference node.
	 * Returns [head, tail] where:
	 * - schema.table.column -> [schema, table]
	 * - table.column -> [undefined, table]
	 * - column -> [undefined, undefined]
	 */
	private extractQualifiers(node: SyntaxNode): [string | undefined, string | undefined] {
		const children = node.namedChildren;

		if (children.length === 0) {
			return [undefined, undefined];
		}

		if (children.length === 1) {
			return [undefined, undefined];
		}

		if (children.length === 2) {
			const tail = children[0].text;
			return [undefined, tail];
		}

		if (children.length >= 3) {
			const head = children[0].text;
			const tail = children[1].text;
			return [head, tail];
		}

		return [undefined, undefined];
	}

	/**
	 * Convert node type to WrappingNodeKind.
	 */
	private nodeKindToWrappingNodeKind(kind: string): WrappingNodeKind | undefined {
		switch (kind) {
			case 'relation': return 'relation';
			case 'binary_expression': return 'binaryExpression';
			case 'assignment': return 'assignment';
			case 'list': return 'list';
			default: return undefined;
		}
	}

	/**
	 * Get the wrapping clause from a node.
	 */
	private getWrappingClauseFromNode(node: SyntaxNode): { clause: WrappingClause; joinContext?: JoinContext } | undefined {
		switch (node.type) {
			case 'where': return { clause: 'where' };
			case 'update': return { clause: 'update' };
			case 'select': return { clause: 'select' };
			case 'delete': return { clause: 'delete' };
			case 'from': return { clause: 'from' };
			case 'insert': return { clause: 'insert' };
			case 'drop_table': return { clause: 'dropTable' };
			case 'alter_role': return { clause: 'alterRole' };
			case 'drop_role': return { clause: 'dropRole' };
			case 'drop_column': return { clause: 'dropColumn' };
			case 'alter_column': return { clause: 'alterColumn' };
			case 'rename_column': return { clause: 'renameColumn' };
			case 'alter_table': return { clause: 'alterTable' };
			case 'set_statement': return { clause: 'setStatement' };
			case 'revoke_statement': return { clause: 'revokeStatement' };
			case 'grant_statement': return { clause: 'grantStatement' };
			case 'column_definitions': return { clause: 'columnDefinitions' };
			case 'create_policy': return { clause: 'createPolicy' };
			case 'alter_policy': return { clause: 'alterPolicy' };
			case 'drop_policy': return { clause: 'dropPolicy' };
			case 'check_or_using_clause': return { clause: 'checkOrUsingClause' };
			case 'join': {
				// Find the ON keyword node
				let onNodeStart: number | undefined;
				for (const child of node.children) {
					if (child.type === 'keyword_on') {
						onNodeStart = child.startIndex;
						break;
					}
				}
				return { clause: 'join', joinContext: { onNodeStart } };
			}
			default: return undefined;
		}
	}

	/**
	 * Run tree-sitter queries to extract tables, aliases, and columns.
	 */
	private gatherInfoFromQueries(): void {
		// Query for table references (relations)
		this.extractRelations();

		// Query for table aliases
		this.extractTableAliases();

		// Query for columns in SELECT
		this.extractSelectColumns();

		// Query for columns in WHERE
		this.extractWhereColumns();
	}

	/**
	 * Extract table references from FROM/JOIN clauses.
	 */
	private extractRelations(): void {
		try {
			const query = treeSitterParser.createQuery('(table_reference) @ref');
			const captures = query.captures(this.tree.rootNode);

			for (const capture of captures) {
				// Check if within statement range
				if (this.statementRange && !this.isWithinRange(capture.node)) {
					continue;
				}

				const relation = this.parseTableReference(capture.node);
				if (relation) {
					const schemaKey = relation.schema;
					if (!this.mentionedRelations.has(schemaKey)) {
						this.mentionedRelations.set(schemaKey, new Set());
					}
					this.mentionedRelations.get(schemaKey)!.add(relation.table);
				}
			}
		} catch (e) {
			// Query might fail if parser not initialized
		}
	}

	/**
	 * Extract table aliases.
	 */
	private extractTableAliases(): void {
		try {
			const queryStr = `
				(relation
					(table_reference) @ref
					(alias
						(keyword_as)?
						(any_identifier) @alias
					)?
				)
			`;
			const query = treeSitterParser.createQuery(queryStr);
			const matches = query.matches(this.tree.rootNode);

			for (const match of matches) {
				// Check if within statement range
				const firstCapture = match.captures[0];
				if (this.statementRange && firstCapture && !this.isWithinRange(firstCapture.node)) {
					continue;
				}

				if (match.captures.length === 2) {
					const refNode = match.captures[0].node;
					const aliasNode = match.captures[1].node;

					const relation = this.parseTableReference(refNode);
					if (relation) {
						const aliasText = aliasNode.text;
						this.mentionedTableAliases.set(aliasText, {
							alias: aliasText,
							table: relation.table,
							schema: relation.schema,
						});
					}
				}
			}
		} catch (e) {
			// Query might fail
		}
	}

	/**
	 * Extract columns mentioned in SELECT clause.
	 */
	private extractSelectColumns(): void {
		try {
			const queryStr = `
				(select_expression
					(term
						(object_reference) @ref
					)
					","?
				)
			`;
			const query = treeSitterParser.createQuery(queryStr);
			const captures = query.captures(this.tree.rootNode);

			for (const capture of captures) {
				if (this.statementRange && !this.isWithinRange(capture.node)) {
					continue;
				}

				const col = this.parseColumnReference(capture.node);
				if (col) {
					if (!this.mentionedColumns.has('select')) {
						this.mentionedColumns.set('select', new Set());
					}
					this.mentionedColumns.get('select')!.add(col);
				}
			}
		} catch (e) {
			// Query might fail
		}
	}

	/**
	 * Extract columns mentioned in WHERE clause.
	 */
	private extractWhereColumns(): void {
		try {
			const queryStr = `
				(where
					(binary_expression
						(object_reference) @ref
					)
				)
			`;
			const query = treeSitterParser.createQuery(queryStr);
			const captures = query.captures(this.tree.rootNode);

			for (const capture of captures) {
				if (this.statementRange && !this.isWithinRange(capture.node)) {
					continue;
				}

				const col = this.parseColumnReference(capture.node);
				if (col) {
					if (!this.mentionedColumns.has('where')) {
						this.mentionedColumns.set('where', new Set());
					}
					this.mentionedColumns.get('where')!.add(col);
				}
			}
		} catch (e) {
			// Query might fail
		}
	}

	/**
	 * Check if a node is within the current statement range.
	 */
	private isWithinRange(node: SyntaxNode): boolean {
		if (!this.statementRange) return true;
		return node.startIndex >= this.statementRange.startIndex &&
			node.endIndex <= this.statementRange.endIndex;
	}

	/**
	 * Parse a table_reference node to extract schema and table.
	 */
	private parseTableReference(node: SyntaxNode): MentionedRelation | undefined {
		const children = node.namedChildren;
		if (children.length === 0) return undefined;

		if (children.length === 1) {
			return { table: children[0].text };
		}

		if (children.length >= 2) {
			return {
				schema: children[0].text,
				table: children[1].text,
			};
		}

		return undefined;
	}

	/**
	 * Parse an object_reference node to extract alias and column.
	 */
	private parseColumnReference(node: SyntaxNode): MentionedColumn | undefined {
		const children = node.namedChildren;
		if (children.length === 0) return undefined;

		if (children.length === 1) {
			return { column: children[0].text };
		}

		if (children.length === 2) {
			return {
				alias: children[0].text,
				column: children[1].text,
			};
		}

		if (children.length >= 3) {
			return {
				alias: children[1].text,
				column: children[2].text,
			};
		}

		return undefined;
	}

	// === Public API ===

	/**
	 * Get the text of the node under cursor.
	 */
	getNodeUnderCursorText(): string {
		return this.nodeUnderCursor.text;
	}

	/**
	 * Get relations (tables) mentioned in the query, optionally filtered by schema.
	 */
	getMentionedRelations(schema?: string): Set<string> | undefined {
		const sanitizedKey = schema?.replace(/"/g, '');
		return this.mentionedRelations.get(sanitizedKey) ||
			this.mentionedRelations.get(`"${sanitizedKey}"`);
	}

	/**
	 * Get all mentioned relations regardless of schema.
	 */
	getAllMentionedRelations(): MentionedRelation[] {
		const relations: MentionedRelation[] = [];
		for (const [schema, tables] of this.mentionedRelations) {
			for (const table of tables) {
				relations.push({ schema, table });
			}
		}
		return relations;
	}

	/**
	 * Get the table name for an alias.
	 */
	getTableForAlias(alias: string): TableAlias | undefined {
		const sanitizedKey = alias.replace(/"/g, '');
		return this.mentionedTableAliases.get(sanitizedKey) ||
			this.mentionedTableAliases.get(`"${sanitizedKey}"`);
	}

	/**
	 * Get the alias used for a table, if any.
	 */
	getAliasForTable(tableName: string): string | undefined {
		for (const [alias, tableAlias] of this.mentionedTableAliases) {
			if (tableAlias.table === tableName) {
				return alias;
			}
		}
		return undefined;
	}

	/**
	 * Get all table aliases.
	 */
	getAllTableAliases(): TableAlias[] {
		return Array.from(this.mentionedTableAliases.values());
	}

	/**
	 * Get columns mentioned in a specific clause.
	 */
	getMentionedColumns(clause?: WrappingClause): Set<MentionedColumn> | undefined {
		return this.mentionedColumns.get(clause);
	}

	/**
	 * Check if any relations have been mentioned.
	 */
	hasAnyMentionedRelations(): boolean {
		return this.mentionedRelations.size > 0;
	}

	/**
	 * Check if any table aliases have been defined.
	 */
	hasTableAliases(): boolean {
		return this.mentionedTableAliases.size > 0;
	}

	/**
	 * Check if any columns have been mentioned.
	 */
	hasAnyMentionedColumns(): boolean {
		return this.mentionedColumns.size > 0;
	}

	/**
	 * Get the head qualifier (schema) if present, with quotes removed.
	 * For `schema.table.column` returns "schema"
	 */
	getHeadQualifier(): string | undefined {
		return this.identifierQualifiers[0]?.replace(/"/g, '');
	}

	/**
	 * Get the tail qualifier (table/alias) if present, with quotes removed.
	 * For `table.column` returns "table"
	 * For `schema.table.column` returns "table"
	 */
	getTailQualifier(): string | undefined {
		return this.identifierQualifiers[1]?.replace(/"/g, '');
	}

	/**
	 * Check if there's any qualifier present.
	 */
	hasAnyQualifier(): boolean {
		return this.identifierQualifiers[0] !== undefined ||
			this.identifierQualifiers[1] !== undefined;
	}

	/**
	 * Check if cursor is after the JOIN ON keyword.
	 * In JOIN clauses, columns are only valid after ON.
	 */
	isAfterJoinOn(): boolean {
		if (this.wrappingClause !== 'join' || !this.joinContext) {
			return false;
		}
		return this.joinContext.onNodeStart !== undefined &&
			this.position > this.joinContext.onNodeStart;
	}

	/**
	 * Check if the node under cursor is a specific type.
	 */
	nodeUnderCursorIs(...types: string[]): boolean {
		return types.includes(this.nodeUnderCursor.type);
	}

	/**
	 * Check if the node under cursor or any ancestor matches.
	 */
	isWithinNodeType(...types: string[]): boolean {
		let node: SyntaxNode | null = this.nodeUnderCursor;
		while (node) {
			if (types.includes(node.type)) {
				return true;
			}
			node = node.parent;
		}
		return false;
	}

	/**
	 * Check if cursor is at a position where we should show completions.
	 * Returns false for positions like on keywords, ERROR nodes in certain states, etc.
	 */
	isCompletablePosition(): boolean {
		// Don't complete on certain node types
		const nonCompletableTypes = [
			'keyword_select', 'keyword_from', 'keyword_where', 'keyword_and', 'keyword_or',
			'keyword_join', 'keyword_left', 'keyword_right', 'keyword_inner', 'keyword_outer',
			'keyword_on', 'keyword_as', 'keyword_order', 'keyword_by', 'keyword_group',
			'keyword_having', 'keyword_limit', 'keyword_offset', 'keyword_insert', 'keyword_into',
			'keyword_values', 'keyword_update', 'keyword_set', 'keyword_delete',
			'operator', '(', ')', ',', ';', '.'
		];

		// Allow completion on identifier-like nodes even if they start with keywords
		const completableTypes = [
			'any_identifier', 'identifier', 'column_identifier', 'table_identifier',
			'schema_identifier', 'function_identifier', 'object_reference', 'column_reference',
			'table_reference', 'function_reference', 'type_reference', 'ERROR'
		];

		if (completableTypes.includes(this.nodeUnderCursor.type)) {
			return true;
		}

		if (nonCompletableTypes.includes(this.nodeUnderCursor.type)) {
			return false;
		}

		return true;
	}
}

/**
 * Create a SqlContext from SQL text and cursor position.
 * Initializes the parser if needed.
 */
export async function createSqlContext(sql: string, position: number): Promise<SqlContext> {
	const tree = await treeSitterParser.parseAsync(sql);
	return new SqlContext(tree, position, sql);
}

