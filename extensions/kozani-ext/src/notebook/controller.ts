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

		const columns = Object.keys(rows[0]);

		// Use VSCode's built-in text/html renderer - no custom renderer needed
		return [
			new vscode.NotebookCellOutput([
				vscode.NotebookCellOutputItem.text(this.renderHtmlTable(columns, rows, duration), 'text/html'),
			])
		];
	}

	private renderHtmlTable(columns: string[], rows: Record<string, unknown>[], duration: number): string {
		const maxRows = 500;
		const displayRows = rows.slice(0, maxRows);
		const hasMore = rows.length > maxRows;

		const escapeHtml = (str: string) => str
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');

		const formatValue = (value: unknown): string => {
			if (value === null || value === undefined) return '<span style="color: #808080; font-style: italic;">NULL</span>';
			if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
			return escapeHtml(String(value));
		};

		const headerCells = columns.map(col => `<th>${escapeHtml(col)}</th>`).join('');
		const bodyRows = displayRows.map(row => {
			const cells = columns.map(col => `<td>${formatValue(row[col])}</td>`).join('');
			return `<tr>${cells}</tr>`;
		}).join('');

		const statusText = hasMore
			? `Showing ${maxRows.toLocaleString()} of ${rows.length.toLocaleString()} rows (${duration}ms)`
			: `${rows.length.toLocaleString()} row${rows.length !== 1 ? 's' : ''} (${duration}ms)`;

		return `
			<style>
				.kozani-table {
					border-collapse: collapse;
					font-family: var(--vscode-editor-font-family, monospace);
					font-size: 13px;
					width: 100%;
				}
				.kozani-table th, .kozani-table td {
					border: 1px solid var(--vscode-panel-border, #454545);
					padding: 6px 12px;
					text-align: left;
					white-space: nowrap;
					max-width: 400px;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.kozani-table th {
					background: var(--vscode-editor-selectionBackground, #264f78);
					font-weight: 600;
					position: sticky;
					top: 0;
				}
				.kozani-table tr:nth-child(even) { background: var(--vscode-list-hoverBackground, #2a2d2e); }
				.kozani-table tr:hover { background: var(--vscode-list-activeSelectionBackground, #094771); }
				.kozani-status { margin-top: 8px; color: var(--vscode-descriptionForeground, #808080); font-size: 12px; }
			</style>
			<div style="overflow-x: auto;">
				<table class="kozani-table">
					<thead><tr>${headerCells}</tr></thead>
					<tbody>${bodyRows}</tbody>
				</table>
				<div class="kozani-status">${statusText}</div>
			</div>
		`;
	}
}
