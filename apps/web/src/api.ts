import type { StudyRecord } from '@mindmap/core';
import type { Backlinks, SearchHit, TreeEntry } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type VaultEvent = { type: 'file'; path: string; hash: string | null } | { type: 'tree' };

export interface HistoryEntry {
  name: string;
  time: string;
  size: number;
}

export interface SyncInfo {
  enabled: boolean;
  state?: 'off' | 'idle' | 'syncing' | 'error';
  lastSync?: string | null;
  error?: string | null;
  conflicts?: number;
}

/** 웹 UI 가 필요로 하는 저장소 기능. PC 서버(localBackend)와 모바일 클라우드(cloudBackend)가 각각 구현한다. */
export interface Api {
  tree(): Promise<TreeEntry[]>;
  read(path: string): Promise<{ content: string; hash: string }>;
  write(path: string, content: string, baseHash: string | null): Promise<{ hash: string }>;
  createMap(dir: string, name: string): Promise<{ path: string }>;
  createFolder(path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  trash(path: string): Promise<unknown>;
  files(): Promise<string[]>;
  study(path: string): Promise<Record<string, StudyRecord>>;
  recordStudy(path: string, results: { id: string; known: boolean }[]): Promise<unknown>;
  search(q: string): Promise<SearchHit[]>;
  backlinks(path: string): Promise<Backlinks>;
  createPage(path: string, title: string): Promise<{ path: string }>;
  /** 이미지를 from 파일에 딸린 assets/ 에 저장하고 from 기준 상대 경로(ref)를 돌려준다 */
  upload(from: string, file: Blob, ext: string): Promise<string>;
  /** 이전 버전 (PC 만 지원) */
  history(path: string): Promise<HistoryEntry[]>;
  historyFile(path: string, name: string): Promise<{ content: string }>;
  restore(path: string, name: string, baseHash: string | null): Promise<{ content: string; hash: string }>;
  syncInfo(): Promise<SyncInfo>;
  syncNow(): Promise<SyncInfo>;
}

export interface Backend {
  api: Api;
  subscribe(onEvent: (e: VaultEvent) => void, onReconnect: () => void): () => void;
  /** 폴더 만들기·이름 변경·삭제를 UI 에서 제공할지 (모바일은 PC 에서 하도록 숨긴다) */
  canManage: boolean;
  /** 모바일 클라우드 모드인가 */
  cloud: boolean;
  /** 클라우드 모드에서 로그아웃 */
  signOut?: () => Promise<void>;
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

const localApi: Api = {
  tree: () => req('GET', '/api/tree'),
  read: (path) => req('GET', `/api/file?path=${encodeURIComponent(path)}`),
  write: (path, content, baseHash) => req('PUT', '/api/file', { path, content, baseHash }),
  createMap: (dir, name) => req('POST', '/api/maps', { dir, name }),
  createFolder: (path) => req('POST', '/api/folders', { path }),
  rename: (from, to) => req('POST', '/api/rename', { from, to }),
  trash: (path) => req('POST', '/api/trash', { path }),
  files: () => req('GET', '/api/files'),
  study: (path) => req('GET', `/api/study?path=${encodeURIComponent(path)}`),
  recordStudy: (path, results) => req('POST', '/api/study', { path, results }),
  search: (q) => req('GET', `/api/search?q=${encodeURIComponent(q)}`),
  backlinks: (path) => req('GET', `/api/backlinks?path=${encodeURIComponent(path)}`),
  createPage: (path, title) => req('POST', '/api/pages', { path, title }),
  async upload(from, file, ext) {
    const res = await fetch(`/api/upload?from=${encodeURIComponent(from)}&ext=${ext}`, { method: 'POST', body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data.ref as string;
  },
  history: (path) => req('GET', `/api/history?path=${encodeURIComponent(path)}`),
  historyFile: (path, name) => req('GET', `/api/history/file?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`),
  restore: (path, name, baseHash) => req('POST', '/api/history/restore', { path, name, baseHash }),
  syncInfo: () => req('GET', '/api/sync'),
  syncNow: () => req('POST', '/api/sync'),
};

function localSubscribe(onEvent: (e: VaultEvent) => void, onReconnect: () => void): () => void {
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

export const localBackend: Backend = { api: localApi, subscribe: localSubscribe, canManage: true, cloud: false };

let current: Backend = localBackend;

export function setBackend(b: Backend) {
  current = b;
}
export const getBackend = () => current;

/** 현재 백엔드로 위임한다 (화면 코드는 어느 백엔드인지 몰라도 된다) */
export const api: Api = new Proxy({} as Api, {
  get: (_t, key: string) => (...args: unknown[]) => (current.api as unknown as Record<string, (...a: unknown[]) => unknown>)[key](...args),
});

export const subscribe: Backend['subscribe'] = (onEvent, onReconnect) => current.subscribe(onEvent, onReconnect);
