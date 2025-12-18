import * as vscode from 'vscode';
import { ConnectionManager, FullConnection } from '../database/connectionManager';
import { query } from '../database/pgClient';

/**
 * Notebook controller that executes SQL cells against Postgres.
 */
export class KozaniNotebookController {
	readonly controllerId = 'kozani-sql-controller';
	readonly notebookType = 'kozani-notebook';
	readonly label = 'Kozani SQL';
	readonly supportedLanguages = ['sql'];

	private readonly controller: vscode.NotebookController;
	private executionOrder = 0;

	constructor(private connectionManager: ConnectionManager) {
		this.controller = vscode.notebooks.createNotebookController(
			this.controllerId,
			this.notebookType,
			this.label
		);

		this.controller.supportedLanguages = this.supportedLanguages;
		this.controller.supportsExecutionOrder = true;
		this.controller.executeHandler = this.execute.bind(this);
	}

	dispose(): void {
		this.controller.dispose();
	}

	private async execute(
		cells: vscode.NotebookCell[],
		notebook: vscode.NotebookDocument,
		_controller: vscode.NotebookController
	): Promise<void> {
		for (const cell of cells) {
			await this.executeCell(cell, notebook);
		}
	}

	private async executeCell(
		cell: vscode.NotebookCell,
		notebook: vscode.NotebookDocument
	): Promise<void> {
		const execution = this.controller.createNotebookCellExecution(cell);
		execution.executionOrder = ++this.executionOrder;
		execution.start(Date.now());

		const sql = cell.document.getText().trim();
		if (!sql) {
			execution.end(true, Date.now());
			return;
		}

		try {
			// Get connection from notebook metadata or prompt user
			const connection = await this.getConnection(notebook);
			if (!connection) {
				execution.replaceOutput([
					new vscode.NotebookCellOutput([
						vscode.NotebookCellOutputItem.error(new Error('No database connection selected. Use the "Set Connection" command.'))
					])
				]);
				execution.end(false, Date.now());
				return;
			}

			const database = notebook.metadata?.database || connection.default_database || 'postgres';
			const startTime = Date.now();

			// Execute the query
			const rows = await query(connection, sql, [], database);
			const duration = Date.now() - startTime;

			// Create rich output
			const outputs = this.createOutputs(rows, duration, sql);
			execution.replaceOutput(outputs);
			execution.end(true, Date.now());

		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			execution.replaceOutput([
				new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.error({
						name: 'QueryError',
						message: message,
					} as Error)
				])
			]);
			execution.end(false, Date.now());
		}
	}

	private async getConnection(notebook: vscode.NotebookDocument): Promise<FullConnection | undefined> {
		const connectionId = notebook.metadata?.connectionId;

		if (connectionId) {
			// Fetch full connection with credentials from secret storage
			const fullConn = await this.connectionManager.getFullConnection(connectionId);
			if (fullConn?.credentials) {
				return fullConn;
			}
			// Connection ID was set but credentials not found - fall through to picker
		}

		// No connection set or credentials missing - prompt user to select one
		const connections = this.connectionManager.getConnections();
		if (connections.length === 0) {
			vscode.window.showErrorMessage('No database connections configured. Add a connection first.');
			return undefined;
		}

		// Let user pick a connection
		const picked = await vscode.window.showQuickPick(
			connections.map(c => ({
				label: c.name,
				description: `${c.host}:${c.port}`,
				connection: c
			})),
			{ placeHolder: 'Select a database connection' }
		);

		if (!picked) {
			return undefined;
		}

		// Fetch full connection with credentials
		const fullConn = await this.connectionManager.getFullConnection(picked.connection.id);
		if (!fullConn?.credentials) {
			vscode.window.showErrorMessage(`No credentials found for connection "${picked.connection.name}". Try removing and re-adding the connection.`);
			return undefined;
		}

		return fullConn;
	}

	private createOutputs(rows: Record<string, unknown>[], duration: number, _sql: string): vscode.NotebookCellOutput[] {
		if (rows.length === 0) {
			return [
				new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text(`Query executed successfully. No rows returned. (${duration}ms)`)
				])
			];
		}

		// Get columns from first row
		const columns = Object.keys(rows[0]);

		// Create table data for our custom renderer
		const tableData = {
			columns,
			rows: rows.map(row => columns.map(col => row[col])),
			rowCount: rows.length,
			duration,
		};

		// Return multiple output types - VSCode will pick the best renderer
		return [
			new vscode.NotebookCellOutput([
				// Custom table renderer (richest)
				vscode.NotebookCellOutputItem.json(tableData, 'application/x-kozani-table'),
				// JSON fallback
				vscode.NotebookCellOutputItem.json(rows, 'application/json'),
				// Plain text fallback
				vscode.NotebookCellOutputItem.text(this.formatAsText(columns, rows, duration)),
			])
		];
	}

	private formatAsText(columns: string[], rows: Record<string, unknown>[], duration: number): string {
		// Simple ASCII table for text fallback
		const header = columns.join(' | ');
		const separator = columns.map(c => '-'.repeat(c.length)).join('-+-');
		const dataRows = rows.slice(0, 100).map(row =>
			columns.map(col => String(row[col] ?? 'NULL')).join(' | ')
		);

		let result = `${header}\n${separator}\n${dataRows.join('\n')}`;
		if (rows.length > 100) {
			result += `\n... and ${rows.length - 100} more rows`;
		}
		result += `\n\n${rows.length} rows (${duration}ms)`;
		return result;
	}
}
