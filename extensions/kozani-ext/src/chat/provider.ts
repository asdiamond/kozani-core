import * as vscode from 'vscode';
import { getGitHubSession } from '../auth';
import { streamFromBackend, reportToolCallOutcome, KOZANI_API_URL, type SqlCell, type QueryResultData, type ChatContext } from './api';
import { debug, warn } from '../debug';

const conversationIdMap = new Map<string, string>();

function hashString(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return hash.toString();
}

const KOZANI_RESULT_MIME = 'application/vnd.kozani.query-result+json';

/**
 * Extract raw query result data from a notebook cell's outputs
 */
function extractQueryResult(outputs: readonly vscode.NotebookCellOutput[]): QueryResultData | undefined {
	for (const output of outputs) {
		for (const item of output.items) {
			if (item.mime === KOZANI_RESULT_MIME) {
				try {
					return JSON.parse(new TextDecoder().decode(item.data));
				} catch {
					// Invalid JSON, skip
				}
			}
		}
	}
	return undefined;
}

/**
 * Convert a notebook cell to SqlCell format for the API
 */
function cellToSqlCell(cell: vscode.NotebookCell): SqlCell | undefined {
	const sql = cell.document.getText().trim();
	if (!sql) return undefined;

	return {
		sql,
		result: extractQueryResult(cell.outputs)
	};
}

/**
 * Get recent executed cells from the active notebook
 */
function getRecentCells(notebook: vscode.NotebookDocument, maxCells = 5): SqlCell[] {
	const cells = notebook.getCells()
		.filter(cell => cell.kind === vscode.NotebookCellKind.Code && cell.outputs.length > 0)
		.slice(-maxCells);

	return cells.map(cellToSqlCell).filter((c): c is SqlCell => c !== undefined);
}

/**
 * Extract SQL cells from chat references (when user @mentions a cell)
 */
async function extractReferencedCells(
	references: readonly vscode.ChatPromptReference[],
	notebook: vscode.NotebookDocument | undefined
): Promise<SqlCell[]> {
	const cells: SqlCell[] = [];

	for (const ref of references) {
		// Get URI from reference
		let uri: vscode.Uri | undefined;
		if (ref.value instanceof vscode.Uri) {
			uri = ref.value;
		} else if (ref.value instanceof vscode.Location) {
			uri = ref.value.uri;
		}

		if (!uri || uri.scheme !== 'vscode-notebook-cell') {
			continue;
		}

		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			const sql = doc.getText().trim();
			if (!sql) continue;

			// Find the cell in the notebook to get its output
			let result: QueryResultData | undefined;
			if (notebook) {
				const cell = notebook.getCells().find(c => c.document.uri.toString() === uri!.toString());
				if (cell) {
					result = extractQueryResult(cell.outputs);
				}
			}

			cells.push({ sql, result });
		} catch (err) {
			warn('Failed to read notebook cell:', err);
		}
	}

	return cells;
}

/**
 * Handle tool calls from the LLM by modifying the notebook.
 * Uses the experimental chatParticipantAdditions API for diff review UI.
 */
function handleToolCall(
	id: string,
	name: string,
	args: Record<string, unknown>,
	response: vscode.ChatResponseStream
): void {
	debug('Handling tool call:', id, name, args);

	if (name === 'insert_sql_cell') {
		const sql = args.sql as string;
		const explanation = args.explanation as string | undefined;

		if (!sql) {
			warn('insert_sql_cell called without sql argument');
			return;
		}

		const notebook = vscode.window.activeNotebookEditor?.notebook;
		if (!notebook) {
			response.markdown('\n\n⚠️ No notebook is open. Please open a `.sqlbook` file first.\n');
			return;
		}

		// Show explanation if provided
		if (explanation) {
			response.markdown(`\n\n${explanation}\n\n`);
		}

		// Create the new SQL cell
		const cellData = new vscode.NotebookCellData(
			vscode.NotebookCellKind.Code,
			sql,
			'pgsql'
		);

		// Use response.notebookEdit for diff review UI (Keep/Undo buttons)
		const insertPosition = notebook.cellCount;
		const notebookEdit = vscode.NotebookEdit.insertCells(insertPosition, [cellData]);

		// Cast to extended ChatResponseStream which has notebookEdit method
		const extendedResponse = response as vscode.ChatResponseStream & {
			notebookEdit(uri: vscode.Uri, edit: vscode.NotebookEdit): void;
		};

		extendedResponse.notebookEdit(notebook.uri, notebookEdit);
		debug('Proposed SQL cell insertion at position', insertPosition, '(pending user review)');

	} else {
		warn('Unknown tool call:', name);
	}
}

export function registerLanguageModelProvider(context: vscode.ExtensionContext): void {
	const modelInfo = {
		id: 'kozani-1',
		name: 'Kozani',
		family: 'kozani',
		version: '1.0',
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		capabilities: {},
		isDefault: true,
		isUserSelectable: true
	};

	let lmConversationId: string | undefined;
	let lmSessionKey: string | undefined;

	const modelProvider: vscode.LanguageModelChatProvider = {
		provideLanguageModelChatInformation(_options, _token) {
			debug('Providing model information');
			return [modelInfo];
		},

		async provideLanguageModelChatResponse(
			_model,
			messages,
			_options,
			progress,
			token
		) {
			debug('Language model request received');

			const session = await getGitHubSession(false);
			if (!session) {
				progress.report(new vscode.LanguageModelTextPart('Please sign in with GitHub to use Kozani.'));
				return;
			}

			const lastMessage = messages[messages.length - 1];
			const formattedMessage = {
				role: lastMessage.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
				content: lastMessage.content.map(part => {
					if (part instanceof vscode.LanguageModelTextPart) {
						return part.value;
					}
					return '';
				}).join('')
			};

			const firstMessage = messages[0];
			const firstContent = firstMessage.content.map(part => {
				if (part instanceof vscode.LanguageModelTextPart) {
					return part.value;
				}
				return '';
			}).join('');
			const currentSessionKey = hashString(firstContent);

			if (lmSessionKey !== currentSessionKey) {
				lmSessionKey = currentSessionKey;
				lmConversationId = conversationIdMap.get(currentSessionKey);
			}

			try {
				const abortController = new AbortController();
				token.onCancellationRequested(() => abortController.abort());

				const returnedConversationId = await streamFromBackend(
					formattedMessage,
					session.accessToken,
					abortController.signal,
					{
						onText: (content) => {
							progress.report(new vscode.LanguageModelTextPart(content));
						},
						onToolCall: (_name, _args) => {
							// Language model provider doesn't support tool calls directly
							// Tool calls are handled by the chat participant
							debug('Tool call received in LM provider (ignored):', _name);
						}
					},
					lmConversationId
				);

				if (returnedConversationId) {
					lmConversationId = returnedConversationId;
					conversationIdMap.set(currentSessionKey, returnedConversationId);
				}
			} catch (error) {
				if (error instanceof Error && error.name !== 'AbortError') {
					// Backend not available - return a placeholder response
					debug('Backend not available, returning placeholder');
					const placeholder = `Hello! I'm Kozani. The backend at ${KOZANI_API_URL} is not available yet.\n\nTo complete setup, start your backend server.`;
					progress.report(new vscode.LanguageModelTextPart(placeholder));
				}
			}
		},

		async provideTokenCount(_model, text, _token) {
			const content = typeof text === 'string' ? text : text.content.map(p => {
				if (p instanceof vscode.LanguageModelTextPart) {
					return p.value;
				}
				return '';
			}).join('');
			return Math.ceil(content.length / 4);
		}
	};

	const modelDisposable = vscode.lm.registerLanguageModelChatProvider('kozani', modelProvider);
	context.subscriptions.push(modelDisposable);
	debug('Language model provider registered');
}

export function registerChatParticipant(context: vscode.ExtensionContext): void {
	const chatParticipant = vscode.chat.createChatParticipant('kozani.chat', async (request, chatContext, response, token) => {
		debug('Chat participant request:', request.prompt);

		const session = await getGitHubSession();

		if (!session) {
			response.markdown('⚠️ **Authentication required**\n\nPlease sign in with GitHub to use Kozani.');
			return { metadata: { title: 'Auth Required' } };
		}

		let sessionKey: string;
		let conversationId: string | undefined;

		if (chatContext.history.length > 0) {
			const firstTurn = chatContext.history[0];
			if (firstTurn instanceof vscode.ChatRequestTurn) {
				sessionKey = hashString(firstTurn.prompt);
			} else {
				sessionKey = hashString(request.prompt);
			}
			conversationId = conversationIdMap.get(sessionKey);
			debug('Continuing conversation:', conversationId, 'sessionKey:', sessionKey);
		} else {
			sessionKey = hashString(request.prompt);
			debug('Starting new conversation, sessionKey:', sessionKey);
		}

		response.progress('Thinking...');

		const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
		const connectionName = activeNotebook?.metadata?.connectionName as string | undefined;

		// Get referenced cells (explicit @mentions) and recent cells (background context)
		const referencedCells = await extractReferencedCells(request.references, activeNotebook);
		const recentCells = activeNotebook ? getRecentCells(activeNotebook, 5) : [];

		// Combine: recent first, then referenced. Dedupe by SQL content.
		const seenSql = new Set(referencedCells.map(c => c.sql));
		const uniqueRecentCells = recentCells.filter(c => !seenSql.has(c.sql));
		const sqlCells = [...uniqueRecentCells, ...referencedCells];

		debug('Context:', { connectionName, referencedCells: referencedCells.length, recentCells: uniqueRecentCells.length });

		const apiContext: ChatContext = {
			connection_name: connectionName,
			sql_cells: sqlCells
		};

		// Collect tool call IDs for tracking accept/reject outcomes
		const toolCallIds: string[] = [];

		try {
			const abortController = new AbortController();
			token.onCancellationRequested(() => abortController.abort());

			const returnedConversationId = await streamFromBackend(
				{ role: 'user', content: request.prompt },
				session.accessToken,
				abortController.signal,
				{
					onText: (content) => response.markdown(content),
					onToolCall: (id, name, args) => {
						toolCallIds.push(id);
						handleToolCall(id, name, args, response);
					}
				},
				conversationId,
				apiContext
			);

			if (returnedConversationId) {
				conversationIdMap.set(sessionKey, returnedConversationId);
				debug('Stored conversation ID:', returnedConversationId, 'for sessionKey:', sessionKey);
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				response.markdown('\n\n*Request cancelled*');
			} else {
				// allow-any-unicode-next-line
				response.markdown(`👋 Hello **${session.account.label}**!\n\n`);
				response.markdown(`You asked: *${request.prompt}*\n\n`);
				response.markdown(`---\n\n`);
				// allow-any-unicode-next-line
				response.markdown(`✅ **GitHub Auth working!**\n\n`);
				response.markdown(`Your GitHub token is ready to send to the Kozani backend.\n\n`);
				response.markdown(`To complete the setup:\n`);
				response.markdown(`1. Start your backend server at \`${KOZANI_API_URL}\`\n`);
				response.markdown(`2. Implement the \`POST /api/chat\` endpoint\n`);
				response.markdown(`3. Validate the GitHub token and process the request\n`);
			}
		}

		// Include tool call IDs in metadata for tracking accept/reject outcomes
		return {
			metadata: {
				title: 'Kozani Chat',
				toolCallIds,
				conversationId: conversationIdMap.get(sessionKey),
			}
		};
	});

	chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');

	// Track when users accept/reject proposed edits (experimental API)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const participant = chatParticipant as any;
	if (participant.onDidPerformAction) {
		participant.onDidPerformAction(async (event: vscode.ChatUserActionEvent) => {
			const action = event.action;
			debug('User performed action:', action.kind, action);

			// Handle editing session actions (accept/reject all edits for a file)
			if (action.kind === 'chatEditingSessionAction' || action.kind === 'chatEditingHunkAction') {
				const outcome = action.outcome === 1 ? 'accepted'
					: action.outcome === 2 ? 'rejected'
						: 'saved';

				// Extract tool call IDs and conversation ID from result metadata
				const metadata = event.result?.metadata as {
					toolCallIds?: string[];
					conversationId?: string;
				} | undefined;

				debug(`Edit ${outcome}:`, action.uri?.toString(), 'toolCallIds:', metadata?.toolCallIds);

				// Report to backend
				try {
					const session = await getGitHubSession();
					if (session && metadata?.toolCallIds?.length) {
						await reportToolCallOutcome(session.accessToken, {
							action_kind: action.kind,
							outcome,
							uri: action.uri?.toString(),
							has_remaining_edits: action.hasRemainingEdits,
							tool_call_ids: metadata.toolCallIds,
							conversation_id: metadata.conversationId,
						});
					}
				} catch (err) {
					warn('Failed to report tool call outcome:', err);
				}
			}
		});
	}

	context.subscriptions.push(chatParticipant);
	debug('Chat participant registered');
}
