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

/** Upper bound on followed pages, so a misbehaving cursor cannot loop forever. */
const MAX_PAGES = 100;

/** Reads every page of a cursor-paged list (`{ items, nextCursor }`). */
export async function apiRequestAllPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const url =
      cursor === undefined ? path : `${path}${separator}cursor=${encodeURIComponent(cursor)}`;
    const result = await apiRequest<{ items: T[]; nextCursor?: string }>(url);
    items.push(...result.items);
    if (result.nextCursor === undefined) return items;
    cursor = result.nextCursor;
  }
  throw new Error('too_many_pages');
}
