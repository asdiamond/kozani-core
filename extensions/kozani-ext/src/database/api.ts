import { KOZANI_API_URL } from '../chat/api';
import { SchemaData } from './schemaSync';

const CONNECTIONS_URL = `${KOZANI_API_URL}/connections`;

/**
 * Upsert schema to the backend for AI context.
 * connection_id is client-generated UUID.
 */
export async function upsertSchema(token: string, connectionId: string, schema: SchemaData): Promise<void> {
	const response = await fetch(`${CONNECTIONS_URL}/${connectionId}/schema`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(schema)
	});

	if (!response.ok) {
		throw new Error(`API error: ${response.status} ${response.statusText}`);
	}
}
