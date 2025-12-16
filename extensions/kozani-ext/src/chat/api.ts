// Kozani API endpoint (configure this for your backend)
export const KOZANI_API_URL = process.env.KOZANI_API_URL || 'http://localhost:5000';

/**
 * Send a chat request to the Kozani backend and stream the response.
 * Only sends the latest message - backend reconstructs history from conversation_id.
 * Returns the conversation_id from the response.
 */
export async function streamFromBackend(
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
