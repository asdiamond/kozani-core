/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// GitHub auth scopes - read:user for basic info, user:email for email
const GITHUB_AUTH_SCOPES = ['read:user', 'user:email'];

// Kozani API endpoint (configure this for your backend)
const KOZANI_API_URL = process.env.KOZANI_API_URL || 'http://localhost:5000';

// Store conversation IDs keyed by a hash of the first message in the chat session
const conversationIdMap = new Map<string, string>();

/**
 * Generate a simple hash from a string for session lookup
 */
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
 * Get or create a GitHub authentication session
 */
async function getGitHubSession(createIfNone: boolean = true): Promise<vscode.AuthenticationSession | undefined> {
	try {
		const session = await vscode.authentication.getSession('github', GITHUB_AUTH_SCOPES, { createIfNone });
		return session;
	} catch (error) {
		console.error('Failed to get GitHub session:', error);
		return undefined;
	}
}

/**
 * Send a chat request to the Kozani backend and stream the response.
 * Only sends the latest message - backend reconstructs history from conversation_id.
 * Returns the conversation_id from the response.
 */
async function streamFromBackend(
	message: { role: string; content: string },
	token: string,
	signal: AbortSignal,
	onChunk: (text: string) => void,
	conversationId?: string
): Promise<string | undefined> {
	const response = await fetch(`${KOZANI_API_URL}/api/chat`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${token}`
		},
		body: JSON.stringify({
			messages: [message],
			conversation_id: conversationId
		}),
		signal
	});

	if (!response.ok) {
		throw new Error(`API error: ${response.status} ${response.statusText}`);
	}

	// Read the conversation ID from response header
	const returnedConversationId = response.headers.get('X-Conversation-Id') || undefined;

	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('No response body');
	}

	const decoder = new TextDecoder();
	while (true) {
		const { done, value } = await reader.read();
		if (done) { break; }
		const chunk = decoder.decode(value, { stream: true });
		onChunk(chunk);
	}

	return returnedConversationId;
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('[Kozani] Extension activating...');

	// Register the Kozani language model provider
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

	// Track conversation ID for language model API calls
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

			// Get GitHub auth
			const session = await getGitHubSession(false);
			if (!session) {
				progress.report(new vscode.LanguageModelTextPart('Please sign in with GitHub to use Kozani.'));
				return;
			}

			// Get the latest message only - backend will reconstruct history
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

			// Determine session key from first message to track conversation
			const firstMessage = messages[0];
			const firstContent = firstMessage.content.map(part => {
				if (part instanceof vscode.LanguageModelTextPart) {
					return part.value;
				}
				return '';
			}).join('');
			const currentSessionKey = hashString(firstContent);

			// If session changed, reset conversation ID
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

				// Store the conversation ID for future messages
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
			// Simple estimation: ~4 characters per token
			const content = typeof text === 'string' ? text : text.content.map(p => {
				if (p instanceof vscode.LanguageModelTextPart) {
					return p.value;
				}
				return '';
			}).join('');
			return Math.ceil(content.length / 4);
		}
	};

	// Register the language model
	const modelDisposable = vscode.lm.registerLanguageModelChatProvider('kozani', modelProvider);
	context.subscriptions.push(modelDisposable);
	console.log('[Kozani] Language model provider registered');

	// Register the Kozani chat participant
	const chatParticipant = vscode.chat.createChatParticipant('kozani.chat', async (request, context, response, token) => {
		console.log('[Kozani] Chat participant request:', request.prompt);

		// Get GitHub authentication
		const session = await getGitHubSession();

		if (!session) {
			response.markdown('⚠️ **Authentication required**\n\nPlease sign in with GitHub to use Kozani.');
			return { metadata: { title: 'Auth Required' } };
		}

		// Determine conversation ID from chat history
		// Use the first message in history (or current message if new chat) as session key
		let sessionKey: string;
		let conversationId: string | undefined;

		if (context.history.length > 0) {
			// Existing conversation - get session key from first message
			const firstTurn = context.history[0];
			if (firstTurn instanceof vscode.ChatRequestTurn) {
				sessionKey = hashString(firstTurn.prompt);
			} else {
				// Fallback to current prompt
				sessionKey = hashString(request.prompt);
			}
			conversationId = conversationIdMap.get(sessionKey);
			console.log('[Kozani] Continuing conversation:', conversationId, 'sessionKey:', sessionKey);
		} else {
			// New conversation - use current prompt as session key
			sessionKey = hashString(request.prompt);
			console.log('[Kozani] Starting new conversation, sessionKey:', sessionKey);
		}

		// Show progress while waiting for response
		response.progress('Thinking...');

		try {
			const abortController = new AbortController();
			token.onCancellationRequested(() => abortController.abort());

			const returnedConversationId = await streamFromBackend(
				{ role: 'user', content: request.prompt },
				session.accessToken,
				abortController.signal,
				(chunk) => response.markdown(chunk),
				conversationId
			);

			// Store the conversation ID for future messages in this chat
			if (returnedConversationId) {
				conversationIdMap.set(sessionKey, returnedConversationId);
				console.log('[Kozani] Stored conversation ID:', returnedConversationId, 'for sessionKey:', sessionKey);
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				response.markdown('\n\n*Request cancelled*');
			} else {
				// Backend not available - show helpful message
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

	// Register sign-in command
	const signInCommand = vscode.commands.registerCommand('kozani-ext.signIn', async () => {
		const session = await getGitHubSession(true);
		if (session) {
			vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
		}
	});
	context.subscriptions.push(signInCommand);

	console.log('[Kozani] Extension activated');
}

export function deactivate() {
	console.log('[Kozani] Extension deactivated');
}
