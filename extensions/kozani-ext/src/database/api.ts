import { KOZANI_API_URL } from '../chat/api';

export interface Connection {
	id: string;
	user_id: string;
	name: string;
	host: string;
	port: number;
	default_database: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateConnectionRequest {
	name: string;
	host: string;
	port?: number;
	default_database?: string;
}

const CONNECTIONS_URL = `${KOZANI_API_URL}/connections`;

export async function fetchConnections(token: string): Promise<Connection[]> {
	const response = await fetch(`${CONNECTIONS_URL}/list`, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${token}`
		}
	});

	if (!response.ok) {
		throw new Error(`API error: ${response.status} ${response.statusText}`);
	}

	return response.json() as Promise<Connection[]>;
}

export async function createConnection(token: string, data: CreateConnectionRequest): Promise<Connection> {
	const response = await fetch(`${CONNECTIONS_URL}/create`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${token}`
		},
		body: JSON.stringify(data)
	});

	if (!response.ok) {
		throw new Error(`API error: ${response.status} ${response.statusText}`);
	}

	return response.json() as Promise<Connection>;
}

export async function deleteConnection(token: string, connectionId: string): Promise<void> {
	const response = await fetch(`${CONNECTIONS_URL}/${connectionId}`, {
		method: 'DELETE',
		headers: {
			'Authorization': `Bearer ${token}`
		}
	});

	if (!response.ok) {
		throw new Error(`API error: ${response.status} ${response.statusText}`);
	}
}
