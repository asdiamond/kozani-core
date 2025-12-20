import { debug } from '../debug';

export const KOZANI_API_URL = process.env.KOZANI_API_URL || 'http://localhost:5000';

export interface ContextItem {
	type: 'sql_cell';
	content: string;
}

export interface ChatContext {
	connection_id?: string;
	sql_cells: ContextItem[];
}

export async function streamFromBackend(
	message: { role: string; content: string },
	token: string,
	signal: AbortSignal,
	onChunk: (text: string) => void,
	conversationId?: string,
	context?: ChatContext
): Promise<string | undefined> {
	const body = {
		messages: [message],
		conversation_id: conversationId,
		connection_id: context?.connection_id,
		sql_cells: context?.sql_cells || []
	};
	debug('API request body:', JSON.stringify(body, null, 2));

	const response = await fetch(`${KOZANI_API_URL}/api/chat`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${token}`
		},
		body: JSON.stringify(body),
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
