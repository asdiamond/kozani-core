import * as vscode from 'vscode';
import { getGitHubSession } from '../auth';
import { streamFromBackend, KOZANI_API_URL, type ContextItem, type ChatContext } from './api';
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

/**
 * Extract SQL cell content from notebook cell references
 */
async function extractContextFromReferences(references: readonly vscode.ChatPromptReference[]): Promise<ContextItem[]> {
	const context: ContextItem[] = [];

	debug('extractContextFromReferences called with', references.length, 'references');

	for (const ref of references) {
		debug('Reference:', {
			id: ref.id,
			valueType: typeof ref.value,
			valueConstructor: ref.value?.constructor?.name,
			value: ref.value
		});

		let uri: vscode.Uri | undefined;
		if (ref.value instanceof vscode.Uri) {
			uri = ref.value;
			debug('Value is Uri:', uri.toString(), 'scheme:', uri.scheme);
		} else if (ref.value instanceof vscode.Location) {
			uri = ref.value.uri;
			debug('Value is Location, uri:', uri.toString(), 'scheme:', uri.scheme);
		} else {
			debug('Value is neither Uri nor Location, skipping scheme check');
			// Try to extract content directly if it's a string or has content
			if (typeof ref.value === 'string') {
				context.push({ type: 'sql_cell', content: ref.value });
				debug('Added string content directly');
				continue;
			}
			// Check if it has a text property (some reference types do)
			const val = ref.value as { text?: string; content?: string };
			if (val?.text) {
				context.push({ type: 'sql_cell', content: val.text });
				debug('Added text property content');
				continue;
			}
			if (val?.content) {
				context.push({ type: 'sql_cell', content: val.content });
				debug('Added content property content');
				continue;
			}
		}

		if (!uri) {
			debug('No URI found for reference, skipping');
			continue;
		}

		// Accept both vscode-notebook-cell and file schemes for notebook cells
		if (uri.scheme !== 'vscode-notebook-cell' && !uri.path.endsWith('.kozani') && !uri.path.endsWith('.sqlbook')) {
			debug('Skipping non-notebook URI:', uri.toString());
			continue;
		}

		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			const content = doc.getText().trim();
			if (content) {
				context.push({ type: 'sql_cell', content });
				debug('Added SQL cell context:', content.substring(0, 50) + '...');
			}
		} catch (err) {
			warn('Failed to read notebook cell:', err);
		}
	}

	return context;
}

/**
 * Handle tool calls from the LLM by modifying the notebook
 */
async function handleToolCall(
	name: string,
	args: Record<string, unknown>,
	response: vscode.ChatResponseStream
): Promise<void> {
	debug('Handling tool call:', name, args);

	if (name === 'insert_sql_cell') {
		const sql = args.sql as string;
		const explanation = args.explanation as string | undefined;

		if (!sql) {
			warn('insert_sql_cell called without sql argument');
			return;
		}

		const notebook = vscode.window.activeNotebookEditor?.notebook;
		if (!notebook) {
			response.markdown('\n\n⚠️ No notebook is open. Please open a `.kozani` or `.sqlbook` file first.\n');
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
			'sql'
		);

		// Insert at the end of the notebook
		const edit = new vscode.WorkspaceEdit();
		const insertPosition = notebook.cellCount;
		edit.set(notebook.uri, [
			vscode.NotebookEdit.insertCells(insertPosition, [cellData])
		]);

		const success = await vscode.workspace.applyEdit(edit);

		if (success) {
			// allow-any-unicode-next-line
			response.markdown(`\n\n✅ Added SQL cell to notebook\n`);
			debug('Successfully inserted SQL cell at position', insertPosition);

			// Optionally reveal the new cell
			const notebookEditor = vscode.window.activeNotebookEditor;
			if (notebookEditor) {
				const newCellIndex = insertPosition;
				notebookEditor.revealRange(
					new vscode.NotebookRange(newCellIndex, newCellIndex + 1),
					vscode.NotebookEditorRevealType.Default
				);
			}
		} else {
			// allow-any-unicode-next-line
			response.markdown(`\n\n❌ Failed to add SQL cell to notebook\n`);
			warn('Failed to apply notebook edit');
		}
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

		// Extract context from references (notebook cells, etc.)
		const sqlCells = await extractContextFromReferences(request.references);
		if (sqlCells.length > 0) {
			debug('Sending', sqlCells.length, 'SQL cells as context');
		}

		// Get connection_id from active notebook
		const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
		const connectionId = activeNotebook?.metadata?.connectionId as string | undefined;
		debug('Active notebook connectionId:', connectionId);

		const apiContext: ChatContext = {
			connection_id: connectionId,
			sql_cells: sqlCells
		};

		try {
			const abortController = new AbortController();
			token.onCancellationRequested(() => abortController.abort());

			const returnedConversationId = await streamFromBackend(
				{ role: 'user', content: request.prompt },
				session.accessToken,
				abortController.signal,
				{
					onText: (content) => response.markdown(content),
					onToolCall: (name, args) => handleToolCall(name, args, response)
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

		return { metadata: { title: 'Kozani Chat' } };
	});

	chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
	context.subscriptions.push(chatParticipant);
	debug('Chat participant registered');
}
