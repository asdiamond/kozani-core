/**
 * SqlValidator - Validates SQL using libpg_query (via pgsql-parser WASM bindings).
 *
 * This is the actual PostgreSQL parser, extracted from Postgres source code and
 * compiled to WASM. It provides 100% accurate syntax validation for complete SQL
 * statements.
 *
 * Note: This only works for COMPLETE statements. For incomplete SQL during typing,
 * we use tree-sitter which handles partial input gracefully.
 */

import { debug } from '../../debug';

// pgsql-parser types
interface ParseError {
	message: string;
	cursorPosition?: number;
	context?: string;
}

interface ParseResult {
	stmts: unknown[];
	error?: ParseError;
}

// The pgsql-parser module (parse is async in the WASM version)
let parser: {
	parse: (sql: string) => Promise<ParseResult>;
	parseQuery: (sql: string) => Promise<{ query: unknown }>;
} | null = null;

/**
 * Initialize the pgsql-parser module.
 * This is lazy-loaded to avoid slowing down extension startup.
 */
async function ensureParser(): Promise<typeof parser> {
	if (parser) {
		return parser;
	}

	try {
		// Dynamic import to avoid blocking extension load
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const pgsqlParser = require('pgsql-parser');
		parser = pgsqlParser;
		debug('SqlValidator: pgsql-parser loaded successfully');
		return parser;
	} catch (error) {
		debug('SqlValidator: Failed to load pgsql-parser:', error);
		throw error;
	}
}

/**
 * Represents a validation error with position information.
 */
export interface SqlValidationError {
	/** Error message from libpg_query */
	message: string;

	/**
	 * Character offset in the SQL string where the error occurred.
	 * This is 1-based (Postgres convention). Convert to 0-based for VS Code.
	 */
	cursorPosition?: number;

	/** Additional context from Postgres parser */
	context?: string;
}

/**
 * Result of validating SQL.
 */
export interface SqlValidationResult {
	/** Whether the SQL is valid */
	isValid: boolean;

	/** Errors found (empty if valid) */
	errors: SqlValidationError[];

	/** Parsed AST (only if valid) */
	ast?: unknown[];
}

/**
 * Validate a SQL statement using the actual PostgreSQL parser.
 *
 * @param sql - The SQL statement to validate
 * @returns Validation result with errors if invalid
 */
export async function validateSql(sql: string): Promise<SqlValidationResult> {
	// Skip validation for empty or whitespace-only SQL
	const trimmed = sql.trim();
	if (!trimmed) {
		return { isValid: true, errors: [] };
	}

	try {
		const p = await ensureParser();
		if (!p) {
			// Parser not available, assume valid
			return { isValid: true, errors: [] };
		}

		debug('SqlValidator: Parsing SQL:', trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : ''));

		// pgsql-parser's parse() is async (WASM-based)
		const result = await p.parse(trimmed);

		debug('SqlValidator: Parse result:', result.error ? 'error' : 'success');

		if (result.error) {
			debug('SqlValidator: Parse error:', result.error);
			return {
				isValid: false,
				errors: [{
					message: result.error.message || 'Syntax error',
					cursorPosition: result.error.cursorPosition,
					context: result.error.context,
				}],
			};
		}

		return {
			isValid: true,
			errors: [],
			ast: result.stmts,
		};
	} catch (error) {
		// pgsql-parser throws on parse errors
		const err = error as Error & { cursorPosition?: number; context?: string };

		// Extract useful error info
		let message = err.message || 'Unknown parse error';
		let cursorPosition: number | undefined;

		// pgsql-parser error messages often include position like "at or near..."
		// Try to extract the cursor position from the error
		const posMatch = message.match(/at position (\d+)/i);
		if (posMatch) {
			cursorPosition = parseInt(posMatch[1], 10);
		} else if (err.cursorPosition) {
			cursorPosition = err.cursorPosition;
		}

		// Clean up the error message (remove stack trace noise)
		const firstLine = message.split('\n')[0];
		message = firstLine.replace(/^Error:\s*/i, '');

		debug('SqlValidator: Exception during parse:', message, 'at position', cursorPosition);

		return {
			isValid: false,
			errors: [{
				message,
				cursorPosition,
				context: err.context,
			}],
		};
	}
}

/**
 * Convert a 1-based cursor position to a line and column.
 *
 * @param sql - The SQL text
 * @param cursorPosition - 1-based character position from libpg_query
 * @returns Object with 0-based line and character (VS Code compatible)
 */
export function positionToLineColumn(sql: string, cursorPosition: number): { line: number; character: number } {
	// Convert from 1-based to 0-based
	const offset = cursorPosition - 1;

	let line = 0;
	let lastNewline = -1;

	for (let i = 0; i < offset && i < sql.length; i++) {
		if (sql[i] === '\n') {
			line++;
			lastNewline = i;
		}
	}

	const character = offset - lastNewline - 1;

	return { line, character: Math.max(0, character) };
}

/**
 * Check if the SQL is likely complete enough to validate.
 *
 * The 500ms debounce already handles "still typing" - this just catches
 * obvious cases where the user is mid-clause (ends with comma, open paren, etc.)
 *
 * @param sql - The SQL text to check
 * @returns true if SQL should be validated
 */
export function isLikelyCompleteStatement(sql: string): boolean {
	const trimmed = sql.trim();

	if (!trimmed) {
		return false;
	}

	// Ends with semicolon - definitely complete
	if (trimmed.endsWith(';')) {
		return true;
	}

	// Skip validation for obvious incomplete patterns where user is mid-expression
	const incompletePatterns = [
		/,\s*$/,                  // Ends with comma (mid-list)
		/\(\s*$/,                 // Ends with open paren (mid-function/subquery)
		/=\s*$/,                  // Ends with equals (mid-assignment)
		/\.\s*$/,                 // Ends with dot (mid-qualified name)
	];

	for (const pattern of incompletePatterns) {
		if (pattern.test(trimmed)) {
			return false;
		}
	}

	// Otherwise, validate it - let the parser tell us if it's wrong
	return true;
}

