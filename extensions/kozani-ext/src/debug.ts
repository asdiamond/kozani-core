import * as vscode from 'vscode';

let isDevelopment = false;

/**
 * Initialize the debug module with the extension context.
 * Call this once during extension activation.
 */
export function initDebug(context: vscode.ExtensionContext): void {
	// For VS Code forks with built-in extensions, extensionMode might not be Development
	// even when running from source. Check multiple indicators:
	const mode = context.extensionMode;
	const extensionPath = context.extensionPath;
	const isDevByMode = mode === vscode.ExtensionMode.Development;
	const isDevByPath = extensionPath.includes('/kozani-core/') || extensionPath.includes('\\kozani-core\\');

	isDevelopment = isDevByMode || isDevByPath;

	// Always log the init status so we know what mode we're in
	console.log('[Kozani] Debug init:', {
		extensionMode: mode,
		extensionModeName: vscode.ExtensionMode[mode],
		extensionPath,
		isDevByMode,
		isDevByPath,
		isDevelopment
	});
}

/**
 * Log a debug message. Only outputs in development mode.
 */
export function debug(...args: unknown[]): void {
	if (isDevelopment) {
		console.log('[Kozani]', ...args);
	}
}

/**
 * Log a warning. Always outputs.
 */
export function warn(...args: unknown[]): void {
	console.warn('[Kozani]', ...args);
}

/**
 * Log an error. Always outputs.
 */
export function error(...args: unknown[]): void {
	console.error('[Kozani]', ...args);
}

