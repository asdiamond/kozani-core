import * as vscode from 'vscode';
import { ConnectionManager, FullConnection } from '../database/connectionManager';
import { query } from '../database/pgClient';
import { debug, warn } from '../debug';

/**
 * Notebook controller that executes SQL cells against Postgres.
 */
export class KozaniNotebookController {
	readonly controllerId = 'kozani-sql-controller';
	readonly notebookType = 'kozani-notebook';
	readonly label = 'Kozani SQL';
	readonly supportedLanguages = ['pgsql'];

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
		const connectionName = notebook.metadata?.connectionName;
		debug('NotebookController.getConnection: metadata =', notebook.metadata);
		debug('NotebookController.getConnection: connectionName =', connectionName);

		if (connectionName) {
			// Fetch full connection with credentials from secret storage
			const fullConn = await this.connectionManager.getFullConnection(connectionName);
			if (fullConn?.credentials) {
				debug('NotebookController.getConnection: Found existing connection', connectionName);
				return fullConn;
			}
			// Connection name was set but credentials not found - fall through to picker
			warn('NotebookController.getConnection: Connection name set but no credentials found:', connectionName);
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
		const fullConn = await this.connectionManager.getFullConnection(picked.connection.name);
		if (!fullConn?.credentials) {
			vscode.window.showErrorMessage(`No credentials found for connection "${picked.connection.name}". Try removing and re-adding the connection.`);
			return undefined;
		}

		// Save the selected connection to the notebook metadata
		debug('NotebookController.getConnection: Saving connection to notebook metadata:', picked.connection.name);
		await this.saveConnectionToNotebook(notebook, picked.connection.name);

		return fullConn;
	}

	/**
	 * Save the connection name to the notebook's metadata.
	 * This persists the connection so it doesn't need to be selected again.
	 */
	private async saveConnectionToNotebook(notebook: vscode.NotebookDocument, connectionName: string): Promise<void> {
		try {
			const edit = new vscode.WorkspaceEdit();

			// Create updated metadata
			const newMetadata = {
				...notebook.metadata,
				connectionName,
			};

			// Use NotebookEdit to update metadata
			const notebookEdit = vscode.NotebookEdit.updateNotebookMetadata(newMetadata);
			edit.set(notebook.uri, [notebookEdit]);

			const success = await vscode.workspace.applyEdit(edit);
			if (success) {
				debug('NotebookController: Saved connection to notebook metadata:', connectionName);
			} else {
				warn('NotebookController: Failed to save connection to notebook metadata');
			}
		} catch (err) {
			warn('NotebookController: Error saving connection to notebook:', err);
		}
	}

	private createOutputs(rows: Record<string, unknown>[], duration: number, _sql: string): vscode.NotebookCellOutput[] {
		const RESULT_MIME = 'application/vnd.kozani.query-result+json';

		if (rows.length === 0) {
			const metadata = { rowCount: 0, duration };
			const rawJson = JSON.stringify({ rows: [], metadata });
			return [
				new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text(`Query executed successfully. No rows returned. (${duration}ms)`),
					// Use .text() not .json() so VS Code doesn't try to render it
					vscode.NotebookCellOutputItem.text(rawJson, RESULT_MIME),
				])
			];
		}

		const columns = Object.keys(rows[0]);

		// Store both: HTML for display, JSON for raw data (LLM context, export, etc.)
		const maxRawRows = 100;
		const rawData = {
			rows: rows.slice(0, maxRawRows),
			metadata: {
				columns,
				rowCount: rows.length,
				truncated: rows.length > maxRawRows,
				duration,
			}
		};
		const rawJson = JSON.stringify(rawData);

		return [
			new vscode.NotebookCellOutput([
				// HTML goes first - VS Code renders this
				vscode.NotebookCellOutputItem.text(this.renderHtmlTable(columns, rows, duration), 'text/html'),
				// Raw data stored as text with custom MIME - not rendered, just stored for programmatic access
				vscode.NotebookCellOutputItem.text(rawJson, RESULT_MIME),
			])
		];
	}

	private renderHtmlTable(columns: string[], rows: Record<string, unknown>[], duration: number): string {
		const maxRows = 500;
		const displayRows = rows.slice(0, maxRows);
		const hasMore = rows.length > maxRows;
		const pageSize = 10;

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
		const bodyRows = displayRows.map((row, idx) => {
			const cells = columns.map(col => `<td>${formatValue(row[col])}</td>`).join('');
			return `<tr data-row-idx="${idx}">${cells}</tr>`;
		}).join('');

		const totalRows = displayRows.length;
		const totalPages = Math.ceil(totalRows / pageSize);
		const tableId = `kozani-table-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

		const statusText = hasMore
			? `${rows.length.toLocaleString()} rows total (showing max ${maxRows.toLocaleString()}) • ${duration}ms`
			: `${rows.length.toLocaleString()} row${rows.length !== 1 ? 's' : ''} • ${duration}ms`;

		return `
			<style>
				.kozani-container {
					font-family: var(--vscode-editor-font-family, monospace);
					font-size: 13px;
				}
				.kozani-table {
					border-collapse: collapse;
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
					z-index: 1;
				}
				.kozani-table tr:nth-child(even) { background: var(--vscode-list-hoverBackground, #2a2d2e); }
				.kozani-table tr:hover { background: var(--vscode-list-activeSelectionBackground, #094771); }
				.kozani-pagination {
					display: flex;
					align-items: center;
					gap: 8px;
					margin-top: 8px;
					color: var(--vscode-descriptionForeground, #808080);
					font-size: 12px;
				}
				.kozani-pagination button {
					background: var(--vscode-button-secondaryBackground, #3a3d3e);
					color: var(--vscode-button-secondaryForeground, #cccccc);
					border: none;
					padding: 4px 10px;
					border-radius: 3px;
					cursor: pointer;
					font-size: 12px;
				}
				.kozani-pagination button:hover:not(:disabled) {
					background: var(--vscode-button-secondaryHoverBackground, #45494a);
				}
				.kozani-pagination button:disabled {
					opacity: 0.5;
					cursor: not-allowed;
				}
				.kozani-page-info {
					min-width: 120px;
					text-align: center;
				}
				.kozani-status {
					color: var(--vscode-descriptionForeground, #808080);
					margin-left: auto;
				}
			</style>
			<div class="kozani-container" id="${tableId}">
				<div style="overflow-x: auto;">
					<table class="kozani-table">
						<thead><tr>${headerCells}</tr></thead>
						<tbody>${bodyRows}</tbody>
					</table>
				</div>
				<div class="kozani-pagination">
					<button class="kozani-prev" ${totalPages <= 1 ? 'disabled' : ''}>← Prev</button>
					<span class="kozani-page-info">Page <span class="kozani-current-page">1</span> of ${totalPages}</span>
					<button class="kozani-next" ${totalPages <= 1 ? 'disabled' : ''}>Next →</button>
					<span class="kozani-status">${statusText}</span>
				</div>
			</div>
			<script>
				(function() {
					const container = document.getElementById('${tableId}');
					if (!container) return;

					const tbody = container.querySelector('tbody');
					const rows = Array.from(tbody.querySelectorAll('tr'));
					const pageSize = ${pageSize};
					const totalPages = ${totalPages};
					let currentPage = 1;

					const prevBtn = container.querySelector('.kozani-prev');
					const nextBtn = container.querySelector('.kozani-next');
					const pageInfo = container.querySelector('.kozani-current-page');

					function showPage(page) {
						currentPage = Math.max(1, Math.min(page, totalPages));
						const start = (currentPage - 1) * pageSize;
						const end = start + pageSize;

						rows.forEach((row, idx) => {
							row.style.display = (idx >= start && idx < end) ? '' : 'none';
						});

						pageInfo.textContent = currentPage;
						prevBtn.disabled = currentPage === 1;
						nextBtn.disabled = currentPage === totalPages;
					}

					prevBtn.addEventListener('click', () => showPage(currentPage - 1));
					nextBtn.addEventListener('click', () => showPage(currentPage + 1));

					showPage(1);
				})();
			</script>
		`;
	}
}
