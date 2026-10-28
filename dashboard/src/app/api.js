export const API_URL = '/api';

export function api(path, options = {}) {
	return fetch(`${API_URL}${path}`, {
		...options,
		credentials: 'include',
		headers: {
			// Only set JSON content-type when there's a body (the server rejects an empty JSON body)
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
			...options.headers,
		},
	});
}
