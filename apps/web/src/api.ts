export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ code: 'request_failed' }))) as {
      code?: string;
    };
    throw new Error(body.code ?? 'request_failed');
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
