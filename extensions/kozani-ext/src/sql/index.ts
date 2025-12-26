/**
 * SQL Language Service - Provides language features for SQL in Kozani notebooks.
 *
 * Features:
 * - Hover: Shows table/column info from .kozani/ schema files
 * - Completions: Table/column/keyword suggestions (tree-sitter based)
 * - Go to Definition: Jump to schema YAML definitions
 * - Tree-sitter based parsing for accurate context detection
 * - Diagnostics: Syntax errors via libpg_query (red squiggles)
 * - (Future) Code Actions: Quick fixes
 */

import * as vscode from 'vscode';
import { SqlLanguageService } from './SqlLanguageService';
import { SqlHoverProvider } from './providers/HoverProvider';
import { SqlDefinitionProvider } from './providers/DefinitionProvider';
import { SqlCompletionProvider } from './providers/CompletionProvider';
import { SqlDiagnosticsProvider } from './providers/DiagnosticsProvider';
import { debug } from '../debug';

// Export types for external use
export * from './types';
export { SqlLanguageService } from './SqlLanguageService';

// Export parser module
export * from './parser';

// Export completions module
export * from './completions';

// Export validator module
export * from './validator';

/**
 * Register all SQL language features for Kozani notebooks.
 *
 * @param context - Extension context for registering disposables
 * @returns The SqlLanguageService instance for use elsewhere (e.g., LLM context)
 */
export function registerSqlLanguageFeatures(
	context: vscode.ExtensionContext
): SqlLanguageService {
	debug('SQL Language Service: Registering features...');

	const service = new SqlLanguageService();

	// Document selector for PostgreSQL cells in Kozani notebooks
	const selector: vscode.DocumentSelector = {
		language: 'pgsql',
		scheme: 'vscode-notebook-cell',
	};

	debug(`SQL Language Service: Using selector language=${selector.language}, scheme=${selector.scheme}`);

	// Register hover provider
	const hoverProvider = vscode.languages.registerHoverProvider(
		selector,
		new SqlHoverProvider(service)
	);

	// Register definition provider (Go to Definition / Cmd+Click)
	const definitionProvider = vscode.languages.registerDefinitionProvider(
		selector,
		new SqlDefinitionProvider(service)
	);

	// Register completion provider
	const completionProvider = vscode.languages.registerCompletionItemProvider(
		selector,
		new SqlCompletionProvider(service),
		'.', // Trigger on dot for table.column completions
	);

	// Register diagnostics provider (syntax errors / red squiggles)
	const diagnosticsProvider = new SqlDiagnosticsProvider();

	// Add to subscriptions for cleanup
	context.subscriptions.push(hoverProvider);
	context.subscriptions.push(definitionProvider);
	context.subscriptions.push(completionProvider);
	context.subscriptions.push(diagnosticsProvider);
	context.subscriptions.push({
		dispose: () => service.dispose(),
	});

	debug('SQL Language Service: Registered hover, definition, completion, and diagnostics providers for pgsql/vscode-notebook-cell');

	return service;
}

