import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';
import { ConnectionManager, FullConnection } from '../database/connectionManager';
import { debug, warn, error } from '../debug';

let client: LanguageClient | null = null;
let currentConnectionName: string | null = null;
let configFilePath: string | null = null;
let outputChannel: vscode.OutputChannel | null = null;

/**
 * Get the path to the postgres-language-server binary.
 * Bundled in resources/darwin/bin/ for macOS.
 */
function getLspBinaryPath(): string | null {
	// In a packaged app, vscode.env.appRoot points to the app installation
	const appRoot = vscode.env.appRoot;

	if (process.platform !== 'darwin') {
		warn('Postgres LSP: Only macOS is currently supported');
		return null;
	}

	// Determine architecture
	const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
	const binaryName = `postgres_lsp-${arch}`;

	// Try multiple possible locations
	const possiblePaths = [
		// Development: relative to extension
		path.join(appRoot, 'resources', 'darwin', 'bin', binaryName),
		// Production: in app bundle
		path.join(appRoot, '..', 'Resources', 'app', 'resources', 'darwin', 'bin', binaryName),
		// Direct path for development
		path.join(__dirname, '..', '..', '..', '..', '..', 'resources', 'darwin', 'bin', binaryName),
	];

	for (const binPath of possiblePaths) {
		if (fs.existsSync(binPath)) {
			debug('Postgres LSP: Found binary at', binPath);
			return binPath;
		}
	}

	warn('Postgres LSP: Binary not found. Searched:', possiblePaths);
	return null;
}

/**
 * Create a temporary config file for the LSP with database credentials.
 * The postgres-language-server expects a postgres-language-server.jsonc file.
 */
function createConfigFile(conn: FullConnection): string {
	const configDir = path.join(os.tmpdir(), 'kozani-lsp');

	// Ensure directory exists
	if (!fs.existsSync(configDir)) {
		fs.mkdirSync(configDir, { recursive: true });
	}

	// The LSP expects either a directory containing postgres-language-server.jsonc
	// or a direct path to the config file
	const configPath = path.join(configDir, 'postgres-language-server.jsonc');

	// Build connection string
	const password = encodeURIComponent(conn.credentials?.password || '');
	const database = conn.default_database || 'postgres';
	const ssl = conn.credentials?.ssl ? '?sslmode=require' : '';
	const connectionString = `postgresql://${conn.user}:${password}@${conn.host}:${conn.port}/${database}${ssl}`;

	const config = {
		db: {
			connectionString,
		},
		// Disable linting rules that might be noisy
		// Can be adjusted based on user preferences
	};

	fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
	debug('Postgres LSP: Created config file at', configPath);

	return configPath;
}

/**
 * Clean up the config file (contains credentials).
 */
function cleanupConfigFile(): void {
	if (configFilePath && fs.existsSync(configFilePath)) {
		try {
			fs.unlinkSync(configFilePath);
			debug('Postgres LSP: Cleaned up config file');
		} catch (err) {
			warn('Postgres LSP: Failed to cleanup config file:', err);
		}
		configFilePath = null;
	}
}

/**
 * Start the Postgres Language Server for a specific connection.
 */
export async function startLspForConnection(conn: FullConnection): Promise<boolean> {
	// If already running for this connection, do nothing
	if (client && currentConnectionName === conn.name) {
		debug('Postgres LSP: Already running for', conn.name);
		return true;
	}

	// Stop existing client if running
	await stopLsp();

	const binaryPath = getLspBinaryPath();
	if (!binaryPath) {
		error('Postgres LSP: Binary not found, autocomplete unavailable');
		return false;
	}

	if (!conn.credentials?.password) {
		warn('Postgres LSP: No credentials for connection', conn.name);
		return false;
	}

	try {
		// Create config file with credentials
		configFilePath = createConfigFile(conn);

		// Create log directory for LSP
		const logDir = path.join(os.tmpdir(), 'kozani-lsp-logs');
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
		}

		const serverOptions: ServerOptions = {
			command: binaryPath,
			args: [
				'lsp-proxy',
				'--config-path', configFilePath,
				'--log-path', logDir,
			],
		};

		debug('Postgres LSP: Log directory:', logDir);

		// Create output channel for LSP logging
		if (!outputChannel) {
			outputChannel = vscode.window.createOutputChannel('Postgres Language Server');
			outputChannel.appendLine('=== Postgres Language Server Output ===');
			outputChannel.appendLine(`Starting LSP for connection: ${conn.name}`);
			outputChannel.appendLine(`Binary: ${binaryPath}`);
			outputChannel.appendLine(`Config: ${configFilePath}`);
			outputChannel.appendLine(`Log dir: ${logDir}`);
			outputChannel.show(true); // Show the output channel
		}

		const clientOptions: LanguageClientOptions = {
			// Target SQL language in notebook cells and regular files
			documentSelector: [
				{ language: 'sql', scheme: 'vscode-notebook-cell' },
				{ language: 'sql', scheme: 'file' },
				{ language: 'sql', scheme: 'untitled' },
			],
			synchronize: {
				// Don't watch any files - we manage config ourselves
			},
			outputChannel,
			traceOutputChannel: outputChannel,
		};

		client = new LanguageClient(
			'postgres-language-server',
			'Postgres Language Server',
			serverOptions,
			clientOptions
		);

		await client.start();
		currentConnectionName = conn.name;

		debug('Postgres LSP: Started for connection', conn.name);
		outputChannel?.appendLine(`LSP client started successfully for ${conn.name}`);
		outputChannel?.appendLine(`Client state: running`);
		return true;

	} catch (err) {
		error('Postgres LSP: Failed to start:', err);
		outputChannel?.appendLine(`ERROR: Failed to start LSP: ${err}`);
		cleanupConfigFile();
		return false;
	}
}

/**
 * Stop the Postgres Language Server.
 */
export async function stopLsp(): Promise<void> {
	if (client) {
		try {
			await client.stop();
			debug('Postgres LSP: Stopped');
		} catch (err) {
			warn('Postgres LSP: Error stopping client:', err);
		}
		client = null;
		currentConnectionName = null;
	}
	cleanupConfigFile();
}

/**
 * Get the current connection name the LSP is running for.
 */
export function getCurrentLspConnection(): string | null {
	return currentConnectionName;
}

/**
 * Check if the LSP is currently running.
 */
export function isLspRunning(): boolean {
	return client !== null;
}

/**
 * Initialize LSP integration - sets up listeners for notebook changes.
 */
export function initializeLspIntegration(
	context: vscode.ExtensionContext,
	connectionManager: ConnectionManager
): void {
	debug('Postgres LSP: Initializing integration');

	// Start LSP when a notebook becomes active
	const onNotebookChange = vscode.window.onDidChangeActiveNotebookEditor(async (editor) => {
		if (!editor) {
			return;
		}

		const connectionName = editor.notebook.metadata?.connectionName as string | undefined;
		if (!connectionName) {
			debug('Postgres LSP: Notebook has no connection, skipping');
			return;
		}

		// Skip if already running for this connection
		if (currentConnectionName === connectionName) {
			return;
		}

		debug('Postgres LSP: Notebook connection changed to', connectionName);

		const conn = await connectionManager.getFullConnection(connectionName);
		if (conn?.credentials) {
			await startLspForConnection(conn);
		} else {
			warn('Postgres LSP: Could not get credentials for', connectionName);
		}
	});

	// Also check the current notebook on activation
	const currentEditor = vscode.window.activeNotebookEditor;
	if (currentEditor) {
		const connectionName = currentEditor.notebook.metadata?.connectionName as string | undefined;
		if (connectionName) {
			connectionManager.getFullConnection(connectionName).then(conn => {
				if (conn?.credentials) {
					startLspForConnection(conn);
				}
			});
		}
	}

	// Clean up on deactivation
	context.subscriptions.push(onNotebookChange);
	context.subscriptions.push({
		dispose: () => {
			stopLsp();
		}
	});

	debug('Postgres LSP: Integration initialized');
}

