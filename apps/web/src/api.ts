import type { TreeEntry } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data);
  return data as T;
}

export const api = {
  tree: () => req<TreeEntry[]>('GET', '/api/tree'),
  read: (path: string) => req<{ content: string; hash: string }>('GET', `/api/file?path=${encodeURIComponent(path)}`),
  write: (path: string, content: string, baseHash: string | null) =>
    req<{ hash: string }>('PUT', '/api/file', { path, content, baseHash }),
  createMap: (dir: string, name: string) => req<{ path: string }>('POST', '/api/maps', { dir, name }),
  createFolder: (path: string) => req('POST', '/api/folders', { path }),
  rename: (from: string, to: string) => req('POST', '/api/rename', { from, to }),
  trash: (path: string) => req('POST', '/api/trash', { path }),
};

export type VaultEvent = { type: 'file'; path: string; hash: string | null } | { type: 'tree' };

export function subscribe(onEvent: (e: VaultEvent) => void, onReconnect: () => void): () => void {
  const es = new EventSource('/api/events');
  // 첫 연결 포함, 연결될 때마다 놓친 변경이 없는지 다시 확인한다
  es.onopen = () => onReconnect();
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ping 등 무시 */
    }
  };
  return () => es.close();
}
