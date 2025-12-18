/**
 * Table renderer for SQL query results in notebooks.
 * This runs in the notebook webview context (browser, not Node.js).
 */

const activate = (context) => ({
	renderOutputItem(outputItem, element) {
		const data = outputItem.json();
		element.innerHTML = renderTable(data);
	}
});

function renderTable(data) {
	const { columns, rows, rowCount, duration } = data;

	// Limit displayed rows for performance
	const maxRows = 500;
	const displayRows = rows.slice(0, maxRows);
	const hasMore = rows.length > maxRows;

	const styles = `
		<style>
			.kozani-table-container {
				font-family: var(--vscode-editor-font-family, monospace);
				font-size: var(--vscode-editor-font-size, 13px);
				overflow-x: auto;
				padding: 8px 0;
			}
			.kozani-table {
				border-collapse: collapse;
				width: 100%;
				min-width: max-content;
			}
			.kozani-table th,
			.kozani-table td {
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
				color: var(--vscode-editor-foreground, #cccccc);
				font-weight: 600;
				position: sticky;
				top: 0;
			}
			.kozani-table tr:nth-child(even) {
				background: var(--vscode-list-hoverBackground, #2a2d2e);
			}
			.kozani-table tr:hover {
				background: var(--vscode-list-activeSelectionBackground, #094771);
			}
			.kozani-table td.null-value {
				color: var(--vscode-descriptionForeground, #808080);
				font-style: italic;
			}
			.kozani-table td.number-value {
				text-align: right;
				font-variant-numeric: tabular-nums;
			}
			.kozani-status {
				margin-top: 8px;
				color: var(--vscode-descriptionForeground, #808080);
				font-size: 12px;
			}
		</style>
	`;

	const headerCells = columns.map(col => `<th title="${escapeHtml(col)}">${escapeHtml(col)}</th>`).join('');

	const bodyRows = displayRows.map(row => {
		const cells = row.map((value, i) => {
			const formatted = formatValue(value);
			const classes = [];
			if (value === null || value === undefined) {
				classes.push('null-value');
			} else if (typeof value === 'number') {
				classes.push('number-value');
			}
			return `<td class="${classes.join(' ')}" title="${escapeHtml(String(value))}">${formatted}</td>`;
		}).join('');
		return `<tr>${cells}</tr>`;
	}).join('');

	const statusText = hasMore
		? `Showing ${maxRows.toLocaleString()} of ${rowCount.toLocaleString()} rows (${duration}ms)`
		: `${rowCount.toLocaleString()} row${rowCount !== 1 ? 's' : ''} (${duration}ms)`;

	return `
		${styles}
		<div class="kozani-table-container">
			<table class="kozani-table">
				<thead><tr>${headerCells}</tr></thead>
				<tbody>${bodyRows}</tbody>
			</table>
			<div class="kozani-status">${statusText}</div>
		</div>
	`;
}

function formatValue(value) {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	if (typeof value === 'object') {
		return escapeHtml(JSON.stringify(value));
	}
	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}
	return escapeHtml(String(value));
}

function escapeHtml(str) {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

// VSCode notebook renderer API export
export { activate };
