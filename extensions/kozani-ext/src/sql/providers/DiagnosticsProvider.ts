/**
 * SqlDiagnosticsProvider - Provides real-time SQL syntax validation (red squiggles).
 *
 * Uses libpg_query (via pgsql-parser) to validate SQL statements. Only validates
 * statements that appear complete to avoid noisy errors while typing.
 */

import * as vscode from 'vscode';
import {
	validateSql,
	positionToLineColumn,
	isLikelyCompleteStatement,
} from '../validator';
import { debug } from '../../debug';

/** Debounce delay in milliseconds before validating after a change */
const VALIDATION_DELAY_MS = 500;

/**
 * Provides SQL diagnostics (syntax errors) for notebook cells.
 */
export class SqlDiagnosticsProvider implements vscode.Disposable {
	private diagnosticCollection: vscode.DiagnosticCollection;
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private disposables: vscode.Disposable[] = [];

	constructor() {
		this.diagnosticCollection = vscode.languages.createDiagnosticCollection('pgsql');

		// Listen for document changes
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChanged(e))
		);

		// Listen for document opens
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument(doc => this.validateDocument(doc))
		);

		// Listen for document closes (clear diagnostics)
		this.disposables.push(
			vscode.workspace.onDidCloseTextDocument(doc => {
				this.diagnosticCollection.delete(doc.uri);
				this.clearTimer(doc.uri.toString());
			})
		);

		// Validate all currently open pgsql documents
		for (const doc of vscode.workspace.textDocuments) {
			if (this.isPgsqlDocument(doc)) {
				this.validateDocument(doc);
			}
		}

		debug('SqlDiagnosticsProvider: Initialized');
	}

	/**
	 * Check if a document is a pgsql document we should validate.
	 */
	private isPgsqlDocument(document: vscode.TextDocument): boolean {
		return document.languageId === 'pgsql';
	}

	/**
	 * Handle document changes with debouncing.
	 */
	private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		const document = event.document;

		if (!this.isPgsqlDocument(document)) {
			return;
		}

		debug(`SqlDiagnosticsProvider: Document changed: ${document.uri.toString().substring(0, 50)}...`);

		// Clear existing timer
		const key = document.uri.toString();
		this.clearTimer(key);

		// Set new debounced timer
		const timer = setTimeout(() => {
			debug('SqlDiagnosticsProvider: Debounce timer fired, validating...');
			this.validateDocument(document);
			this.debounceTimers.delete(key);
		}, VALIDATION_DELAY_MS);

		this.debounceTimers.set(key, timer);
	}

	/**
	 * Clear a debounce timer.
	 */
	private clearTimer(key: string): void {
		const existing = this.debounceTimers.get(key);
		if (existing) {
			clearTimeout(existing);
			this.debounceTimers.delete(key);
		}
	}

	/**
	 * Validate a document and update diagnostics.
	 */
	private async validateDocument(document: vscode.TextDocument): Promise<void> {
		debug(`SqlDiagnosticsProvider.validateDocument: languageId=${document.languageId}, uri=${document.uri.scheme}`);

		if (!this.isPgsqlDocument(document)) {
			debug('SqlDiagnosticsProvider: Not a pgsql document, skipping');
			return;
		}

		const sql = document.getText();
		debug(`SqlDiagnosticsProvider: SQL (${sql.length} chars): "${sql.substring(0, 50)}..."`);

		// Skip validation if the statement doesn't look complete
		if (!isLikelyCompleteStatement(sql)) {
			debug('SqlDiagnosticsProvider: Statement not complete, skipping validation');
			// Clear any existing errors - user is still typing
			this.diagnosticCollection.delete(document.uri);
			return;
		}

		debug('SqlDiagnosticsProvider: Statement looks complete, validating...');

		try {
			const result = await validateSql(sql);

			debug(`SqlDiagnosticsProvider: Validation result: isValid=${result.isValid}, errors=${result.errors.length}`);

			if (result.isValid) {
				// Clear diagnostics
				debug('SqlDiagnosticsProvider: SQL is valid, clearing diagnostics');
				this.diagnosticCollection.delete(document.uri);
			} else {
				// Convert errors to VS Code diagnostics
				const diagnostics: vscode.Diagnostic[] = [];

				for (const error of result.errors) {
					debug(`SqlDiagnosticsProvider: Error: ${error.message} at position ${error.cursorPosition}`);
					const diagnostic = this.createDiagnostic(document, sql, error);
					diagnostics.push(diagnostic);
				}

				debug(`SqlDiagnosticsProvider: Setting ${diagnostics.length} diagnostics on ${document.uri.toString()}`);
				this.diagnosticCollection.set(document.uri, diagnostics);
			}
		} catch (err) {
			// Log but don't crash - validation is best-effort
			debug('SqlDiagnosticsProvider: Validation exception:', err);
		}
	}

	/**
	 * Create a VS Code diagnostic from a validation error.
	 */
	private createDiagnostic(
		document: vscode.TextDocument,
		sql: string,
		error: { message: string; cursorPosition?: number; context?: string }
	): vscode.Diagnostic {
		let range: vscode.Range;

		if (error.cursorPosition && error.cursorPosition > 0) {
			// We have a position - create a range at that location
			const pos = positionToLineColumn(sql, error.cursorPosition);
			const startPos = new vscode.Position(pos.line, pos.character);

			// Try to extend the range to cover the problematic token
			// For now, just highlight from the error position to end of line
			const endOfLine = document.lineAt(pos.line).range.end;
			range = new vscode.Range(startPos, endOfLine);

			// If the range is empty or very small, highlight the whole line
			if (range.isEmpty || range.end.character - range.start.character < 2) {
				range = document.lineAt(pos.line).range;
			}
		} else {
			// No position info - highlight the first line or whole document
			if (document.lineCount > 0) {
				range = document.lineAt(0).range;
			} else {
				range = new vscode.Range(0, 0, 0, 1);
			}
		}

		// Format the error message
		let message = error.message;
		if (error.context) {
			message += `\n${error.context}`;
		}

		const diagnostic = new vscode.Diagnostic(
			range,
			message,
			vscode.DiagnosticSeverity.Error
		);

		diagnostic.source = 'PostgreSQL';

		return diagnostic;
	}

	/**
	 * Dispose of resources.
	 */
	dispose(): void {
		// Clear all timers
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		// Dispose diagnostic collection
		this.diagnosticCollection.dispose();

		// Dispose subscriptions
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

