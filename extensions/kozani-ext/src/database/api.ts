import { KOZANI_API_URL } from '../chat/api';
import { SchemaElement } from './introspect';

const CONNECTIONS_URL = `${KOZANI_API_URL}/connections`;

/**
 * Upsert schema elements to the backend for AI context.
 * Sends flat array of schema elements - backend handles storage.
 */
export async function upsertSchema(token: string, connectionId: string, elements: SchemaElement[]): Promise<void> {
	const response = await fetch(`${CONNECTIONS_URL}/${connectionId}/schema`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(elements)
	});

	if (!response.ok) {
		throw new Error(`API error: ${response.status} ${response.statusText}`);
	}
}
