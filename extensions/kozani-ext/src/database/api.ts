import { KOZANI_API_URL } from '../chat/api';
import { SchemaElement } from './introspect';

/**
 * Upsert schema elements to the backend for AI context.
 * Sends flat array of schema elements - backend handles storage.
 * Uses connection name (folder name from .kozani/) as identifier.
 */
export async function upsertSchema(token: string, connectionName: string, elements: SchemaElement[]): Promise<void> {
	const response = await fetch(`${KOZANI_API_URL}/api/schemas/${encodeURIComponent(connectionName)}`, {
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
