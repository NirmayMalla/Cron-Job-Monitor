export const API_URL = process.env.NEXT_PUBLIC_API_URL;

export function api(path, options = {}) {
	return fetch(`${API_URL}${path}`, {
		...options,
		credentials: 'include',
		headers: {
			// Only set JSON content-type when there's a body (server rejects empty JSON body)
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
			...options.headers,
		},
	});
}
