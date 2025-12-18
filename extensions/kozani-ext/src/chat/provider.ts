import * as vscode from 'vscode';
import { getGitHubSession } from '../auth';
import { streamFromBackend, KOZANI_API_URL, type ContextItem } from './api';

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

	for (const ref of references) {
		let uri: vscode.Uri | undefined;
		if (ref.value instanceof vscode.Uri) {
			uri = ref.value;
		} else if (ref.value instanceof vscode.Location) {
			uri = ref.value.uri;
		}

		if (uri?.scheme !== 'vscode-notebook-cell') {
			continue;
		}

		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			const content = doc.getText().trim();
			if (content) {
				context.push({ type: 'sql_cell', content });
				console.log('[Kozani] Added SQL cell context:', content.substring(0, 50) + '...');
			}
		} catch (err) {
			console.warn('[Kozani] Failed to read notebook cell:', err);
		}
	}

	return context;
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
			console.log('[Kozani] Providing model information');
			return [modelInfo];
		},

		async provideLanguageModelChatResponse(
			_model,
			messages,
			_options,
			progress,
			token
		) {
			console.log('[Kozani] Language model request received');

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
					(chunk) => {
						progress.report(new vscode.LanguageModelTextPart(chunk));
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
					console.log('[Kozani] Backend not available, returning placeholder');
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
	console.log('[Kozani] Language model provider registered');
}

export function registerChatParticipant(context: vscode.ExtensionContext): void {
	const chatParticipant = vscode.chat.createChatParticipant('kozani.chat', async (request, chatContext, response, token) => {
		console.log('[Kozani] Chat participant request:', request.prompt);

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
			console.log('[Kozani] Continuing conversation:', conversationId, 'sessionKey:', sessionKey);
		} else {
			sessionKey = hashString(request.prompt);
			console.log('[Kozani] Starting new conversation, sessionKey:', sessionKey);
		}

		response.progress('Thinking...');

		// Extract context from references (notebook cells, etc.)
		const context = await extractContextFromReferences(request.references);
		if (context.length > 0) {
			console.log('[Kozani] Sending', context.length, 'context items');
		}

		try {
			const abortController = new AbortController();
			token.onCancellationRequested(() => abortController.abort());

			const returnedConversationId = await streamFromBackend(
				{ role: 'user', content: request.prompt },
				session.accessToken,
				abortController.signal,
				(chunk) => response.markdown(chunk),
				conversationId,
				context
			);

			if (returnedConversationId) {
				conversationIdMap.set(sessionKey, returnedConversationId);
				console.log('[Kozani] Stored conversation ID:', returnedConversationId, 'for sessionKey:', sessionKey);
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
	console.log('[Kozani] Chat participant registered');
}
