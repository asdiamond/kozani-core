import { debug } from '../debug';

export const KOZANI_API_URL = process.env.KOZANI_API_URL || 'http://localhost:5000';

/**
 * Raw query result data from notebook cell outputs.
 * Matches the format stored in 'application/vnd.kozani.query-result+json'
 */
export interface QueryResultData {
	rows: Record<string, unknown>[];
	metadata: {
		columns?: string[];
		rowCount: number;
		truncated?: boolean;
		duration: number;
	};
}

export interface SqlCell {
	sql: string;
	result?: QueryResultData;  // Present if cell has been executed
}

export interface ChatContext {
	connection_name?: string;
	sql_cells: SqlCell[];
}

// Stream event types from backend
export interface TextEvent {
	type: 'text';
	content: string;
}

export interface ToolCallEvent {
	type: 'tool_call';
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type StreamEvent = TextEvent | ToolCallEvent;

export interface StreamCallbacks {
	onText: (content: string) => void;
	onToolCall: (id: string, name: string, args: Record<string, unknown>) => void;
}

export interface ToolCallOutcomeReport {
	action_kind: string;
	outcome: string;
	uri?: string;
	has_remaining_edits?: boolean;
	tool_call_ids: string[];
	conversation_id?: string;
}

/**
 * Report tool call accept/reject outcome to the backend
 */
export async function reportToolCallOutcome(
	token: string,
	data: ToolCallOutcomeReport
): Promise<void> {
	const response = await fetch(`${KOZANI_API_URL}/api/tc-outcome/report`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(data),
	});

	if (!response.ok) {
		throw new Error(`Failed to report outcome: ${response.status}`);
	}
}

export async function streamFromBackend(
	message: { role: string; content: string },
	token: string,
	signal: AbortSignal,
	callbacks: StreamCallbacks,
	conversationId?: string,
	context?: ChatContext
): Promise<string | undefined> {
	const body = {
		messages: [message],
		conversation_id: conversationId,
		connection_name: context?.connection_name,
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
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) { break; }

		buffer += decoder.decode(value, { stream: true });

		// Process complete NDJSON lines
		const lines = buffer.split('\n');
		buffer = lines.pop() || ''; // Keep incomplete line in buffer

		for (const line of lines) {
			if (!line.trim()) { continue; }

			try {
				const event: StreamEvent = JSON.parse(line);

				if (event.type === 'text') {
					callbacks.onText(event.content);
				} else if (event.type === 'tool_call') {
					debug('Received tool call:', event.id, event.name, event.arguments);
					callbacks.onToolCall(event.id, event.name, event.arguments);
				}
			} catch (err) {
				// Not valid JSON - might be legacy plain text, pass through
				debug('Failed to parse NDJSON line, treating as text:', line);
				callbacks.onText(line);
			}
		}
	}

	// Process any remaining buffer content
	if (buffer.trim()) {
		try {
			const event: StreamEvent = JSON.parse(buffer);
			if (event.type === 'text') {
				callbacks.onText(event.content);
			} else if (event.type === 'tool_call') {
				callbacks.onToolCall(event.id, event.name, event.arguments);
			}
		} catch {
			callbacks.onText(buffer);
		}
	}

	return returnedConversationId;
}
