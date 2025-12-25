/**
 * SQL Language Service - Provides language features for SQL in Kozani notebooks.
 *
 * Features:
 * - Hover: Shows table/column info from .kozani/ schema files
 * - (Future) Completions: Table/column suggestions
 * - (Future) Diagnostics: Syntax and semantic errors
 * - (Future) Code Actions: Quick fixes
 */

import * as vscode from 'vscode';
import { SqlLanguageService } from './SqlLanguageService';
import { SqlHoverProvider } from './providers/HoverProvider';
import { debug } from '../debug';

// Export types for external use
export * from './types';
export { SqlLanguageService } from './SqlLanguageService';

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

	// Add to subscriptions for cleanup
	context.subscriptions.push(hoverProvider);
	context.subscriptions.push({
		dispose: () => service.dispose(),
	});

	debug('SQL Language Service: Registered hover provider for pgsql/vscode-notebook-cell');

	return service;
}

