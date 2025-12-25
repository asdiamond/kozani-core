/**
 * TreeSitterParser - Wrapper for web-tree-sitter to parse PostgreSQL SQL.
 *
 * Provides a singleton parser that lazily initializes and caches the grammar.
 * Handles async initialization of WASM modules.
 */

import * as path from 'path';
import Parser from 'web-tree-sitter';

// Re-export types for convenience
export type SyntaxNode = Parser.SyntaxNode;
export type Tree = Parser.Tree;
export type Point = Parser.Point;
export type Query = Parser.Query;
export type QueryCapture = Parser.QueryCapture;
export type QueryMatch = Parser.QueryMatch;

/**
 * Singleton wrapper for the tree-sitter parser with PostgreSQL grammar.
 */
class TreeSitterParserInstance {
	private parser: Parser | null = null;
	private language: Parser.Language | null = null;
	private initPromise: Promise<void> | null = null;
	private initialized = false;

	/**
	 * Initialize the parser. Safe to call multiple times - will only init once.
	 */
	async init(): Promise<void> {
		if (this.initialized) {
			return;
		}

		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = this.doInit();
		await this.initPromise;
	}

	private async doInit(): Promise<void> {
		try {
			// Initialize tree-sitter WASM runtime
			// Locate the tree-sitter.wasm file from web-tree-sitter package
			const treeSitterWasmPath = path.join(
				__dirname,
				'..',
				'..',
				'..',
				'node_modules',
				'web-tree-sitter',
				'tree-sitter.wasm'
			);

			await Parser.init({
				locateFile: (scriptName: string) => {
					if (scriptName === 'tree-sitter.wasm') {
						return treeSitterWasmPath;
					}
					return scriptName;
				}
			});

			// Create parser instance
			this.parser = new Parser();

			// Load the PostgreSQL grammar
			const grammarPath = path.join(__dirname, '..', 'wasm', 'tree-sitter-pgls.wasm');
			this.language = await Parser.Language.load(grammarPath);
			this.parser.setLanguage(this.language);

			this.initialized = true;
		} catch (error) {
			this.initPromise = null;
			throw error;
		}
	}

	/**
	 * Check if the parser is initialized.
	 */
	isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * Parse SQL text into a syntax tree.
	 *
	 * @param sql - The SQL text to parse
	 * @param oldTree - Optional previous tree for incremental parsing
	 * @returns The parsed syntax tree
	 */
	parse(sql: string, oldTree?: Tree): Tree {
		if (!this.parser || !this.initialized) {
			throw new Error('TreeSitterParser not initialized. Call init() first.');
		}
		return this.parser.parse(sql, oldTree);
	}

	/**
	 * Parse SQL text asynchronously, initializing if needed.
	 *
	 * @param sql - The SQL text to parse
	 * @returns The parsed syntax tree
	 */
	async parseAsync(sql: string): Promise<Tree> {
		await this.init();
		return this.parse(sql);
	}

	/**
	 * Create a query from a tree-sitter query pattern.
	 *
	 * @param pattern - The tree-sitter query pattern
	 * @returns The compiled query
	 */
	createQuery(pattern: string): Query {
		if (!this.language || !this.initialized) {
			throw new Error('TreeSitterParser not initialized. Call init() first.');
		}
		return this.language.query(pattern);
	}

	/**
	 * Get the language instance for direct access to language features.
	 */
	getLanguage(): Parser.Language {
		if (!this.language || !this.initialized) {
			throw new Error('TreeSitterParser not initialized. Call init() first.');
		}
		return this.language;
	}

	/**
	 * Get the node at a specific offset in the tree.
	 *
	 * @param tree - The syntax tree
	 * @param offset - The character offset (0-based)
	 * @returns The deepest node containing the offset
	 */
	getNodeAtOffset(tree: Tree, offset: number): SyntaxNode {
		return tree.rootNode.descendantForIndex(offset);
	}

	/**
	 * Get the named node at a specific offset in the tree.
	 *
	 * @param tree - The syntax tree
	 * @param offset - The character offset (0-based)
	 * @returns The deepest named node containing the offset
	 */
	getNamedNodeAtOffset(tree: Tree, offset: number): SyntaxNode {
		return tree.rootNode.namedDescendantForIndex(offset);
	}

	/**
	 * Get the node at a specific position in the tree.
	 *
	 * @param tree - The syntax tree
	 * @param row - The row (0-based line number)
	 * @param column - The column (0-based character offset in line)
	 * @returns The deepest node containing the position
	 */
	getNodeAtPosition(tree: Tree, row: number, column: number): SyntaxNode {
		return tree.rootNode.descendantForPosition({ row, column });
	}

	/**
	 * Clean up resources.
	 */
	dispose(): void {
		if (this.parser) {
			this.parser.delete();
			this.parser = null;
		}
		this.language = null;
		this.initialized = false;
		this.initPromise = null;
	}
}

// Export singleton instance
export const treeSitterParser = new TreeSitterParserInstance();

/**
 * Convenience function to parse SQL.
 * Initializes the parser if needed.
 */
export async function parseSQL(sql: string): Promise<Tree> {
	return treeSitterParser.parseAsync(sql);
}

/**
 * Helper to convert an offset to a Point (row, column).
 *
 * @param text - The full text
 * @param offset - The character offset
 * @returns The Point with row and column
 */
export function offsetToPoint(text: string, offset: number): Point {
	let row = 0;
	let lastNewline = -1;

	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === '\n') {
			row++;
			lastNewline = i;
		}
	}

	const column = offset - lastNewline - 1;
	return { row, column };
}

/**
 * Helper to convert a Point to an offset.
 *
 * @param text - The full text
 * @param point - The Point with row and column
 * @returns The character offset
 */
export function pointToOffset(text: string, point: Point): number {
	const lines = text.split('\n');
	let offset = 0;

	for (let i = 0; i < point.row && i < lines.length; i++) {
		offset += lines[i].length + 1; // +1 for newline
	}

	offset += point.column;
	return offset;
}

