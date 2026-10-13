import type { SupabaseClient } from '@supabase/supabase-js';
import {
  STUDY_PATH,
  SyncEngine,
  VaultIndex,
  applyResult,
  assetsDirFor,
  dirOf,
  isMapPath,
  newMapSource,
  relativePath,
  type PutRow,
  type Remote,
  type RemoteRow,
  type StudyRecord,
} from '@mindmap/core';
import { ApiError, type Api, type Backend, type SyncInfo, type VaultEvent } from '../api';
import type { TreeEntry } from '../types';
import { IdbLocalStore, hashBytes } from './idbStore';

const BUCKET = 'vault-assets';
const PAGE = 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Supabase(DB + Storage)를 동기화 엔진의 Remote 로 연결한다 */
export class BrowserRemote implements Remote {
  constructor(
    private client: SupabaseClient,
    private owner: string,
  ) {}

  async listSince(cursor: string | null): Promise<RemoteRow[]> {
    const out: RemoteRow[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = this.client.from('vault_files').select('path,content,blob,hash,deleted,updated_at').order('updated_at').order('path');
      if (cursor) q = q.gt('updated_at', cursor);
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw new Error(`목록을 받지 못했습니다: ${error.message}`);
      out.push(...(data as RemoteRow[]));
      if (data.length < PAGE) return out;
    }
  }

  async put(row: PutRow): Promise<void> {
    const { error } = await this.client.from('vault_files').upsert({ ...row, device: 'mobile' }, { onConflict: 'owner,path' });
    if (error) throw new Error(`${row.path} 업로드 실패: ${error.message}`);
  }

  blobName(hash: string, ext: string): string {
    return `${this.owner}/${hash}${ext.toLowerCase()}`;
  }

  async uploadBlob(name: string, bytes: Uint8Array): Promise<void> {
    const { error } = await this.client.storage.from(BUCKET).upload(name, bytes, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw new Error(`이미지 업로드 실패: ${error.message}`);
  }

  async downloadBlob(name: string): Promise<Uint8Array> {
    const { data, error } = await this.client.storage.from(BUCKET).download(name);
    if (error || !data) throw new Error(`이미지 다운로드 실패: ${error?.message ?? name}`);
    return new Uint8Array(await data.arrayBuffer());
  }
}

export function buildTree(paths: string[]): TreeEntry[] {
  const root: TreeEntry = { name: '', path: '', kind: 'dir', children: [] };
  for (const p of paths.filter(isMapPath)) {
    const segs = p.split('/');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const dirPath = segs.slice(0, i + 1).join('/');
      let d = cur.children!.find((c) => c.kind === 'dir' && c.path === dirPath);
      if (!d) {
        d = { name: segs[i], path: dirPath, kind: 'dir', children: [] };
        cur.children!.push(d);
      }
      cur = d;
    }
    cur.children!.push({ name: segs[segs.length - 1].slice(0, -'.mm.md'.length), path: p, kind: 'map' });
  }
  const sort = (list: TreeEntry[]) => {
    list.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'ko', { numeric: true })));
    list.forEach((e) => e.children && sort(e.children));
  };
  sort(root.children!);
  return root.children!;
}

const notOnMobile = () =>
  Promise.reject(new ApiError(400, '폴더 만들기·이름 변경·삭제는 PC에서 해 주세요 (모바일은 보기·복습·간단 편집용입니다)', {}));

export type SyncListener = (info: SyncInfo) => void;

export interface CloudBackend extends Backend {
  engine: SyncEngine;
  store: IdbLocalStore;
  onSyncChange(fn: SyncListener): () => void;
  dispose(): void;
}

/** 저장소·색인·동기화 엔진을 묶는다. 타이머나 브라우저 이벤트는 쓰지 않는다 (테스트 가능하게). */
export async function buildCloudBackend(remote: Remote, signOut?: () => Promise<void>): Promise<CloudBackend> {
  const store = new IdbLocalStore();
  await store.init();
  const index = new VaultIndex();
  for (const p of store.paths()) {
    if (VaultIndex.isIndexable(p)) index.set(p, dec.decode(store.get(p)!.bytes));
  }
  const listeners = new Set<(e: VaultEvent) => void>();
  const emit = (e: VaultEvent) => listeners.forEach((l) => l(e));

  store.onChange = (path, hash, existed) => {
    if (VaultIndex.isIndexable(path)) index.set(path, hash === null ? null : dec.decode(store.get(path)!.bytes));
    if (path === STUDY_PATH) return;
    emit({ type: 'file', path, hash });
    if (existed !== (hash !== null)) emit({ type: 'tree' });
  };

  const engine = new SyncEngine(store, remote, hashBytes);
  const syncListeners = new Set<SyncListener>();
  const info = (): SyncInfo => ({ enabled: true, ...engine.status });
  engine.onChange = () => syncListeners.forEach((l) => l(info()));

  const text = (rel: string) => {
    const f = store.get(rel);
    return f ? { content: dec.decode(f.bytes), hash: f.hash } : null;
  };

  const api: Api = {
    async tree() {
      return buildTree(store.paths());
    },
    async read(path) {
      const f = text(path);
      if (!f) throw new ApiError(404, `파일이 없습니다: ${path}`, {});
      return f;
    },
    async write(path, content, baseHash) {
      const cur = text(path);
      if (cur && cur.hash !== baseHash) throw new ApiError(409, '저장된 파일이 변경되었습니다', cur);
      if (!cur && baseHash !== null) throw new ApiError(409, '파일이 삭제되었습니다', { content: null, hash: null });
      const hash = await store.put(path, enc.encode(content));
      engine.schedule(2500);
      return { hash };
    },
    async createMap(dir, name) {
      const clean = name.trim();
      if (!clean) throw new ApiError(400, '이름을 입력하세요', {});
      const path = [dir, `${clean}.mm.md`].filter(Boolean).join('/');
      if (store.get(path)) throw new ApiError(409, '같은 이름의 맵이 이미 있습니다', {});
      await store.put(path, enc.encode(newMapSource(clean)));
      engine.schedule(2500);
      return { path };
    },
    createFolder: notOnMobile,
    rename: notOnMobile,
    trash: notOnMobile,
    async files() {
      return index.paths();
    },
    async study(path) {
      const f = text(STUDY_PATH);
      if (!f) return {};
      try {
        return (JSON.parse(f.content)[path] ?? {}) as Record<string, StudyRecord>;
      } catch {
        return {};
      }
    },
    async recordStudy(path, results) {
      let data: Record<string, Record<string, StudyRecord>> = {};
      try {
        data = JSON.parse(text(STUDY_PATH)?.content ?? '{}');
      } catch {
        /* 깨진 기록은 새로 시작 */
      }
      const map = (data[path] ??= {});
      const at = new Date().toISOString();
      for (const r of results) map[r.id] = applyResult(map[r.id], r.known, at);
      await store.put(STUDY_PATH, enc.encode(JSON.stringify(data, null, 1)));
      engine.schedule(5000);
      return { ok: true };
    },
    async search(q) {
      return index.search(q, 50);
    },
    async backlinks(path) {
      return index.backlinks(path);
    },
    async createPage(path, title) {
      if (!path.endsWith('.md') || isMapPath(path)) throw new ApiError(400, '페이지 경로는 .md 로 끝나야 합니다', {});
      if (store.get(path)) throw new ApiError(409, '같은 이름의 파일이 이미 있습니다', {});
      await store.put(path, enc.encode(`---\ntitle: ${JSON.stringify(title)}\n---\n\n`));
      engine.schedule(2500);
      return { path };
    },
    async upload(from, file, ext) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.length) throw new ApiError(400, '빈 파일입니다', {});
      if (bytes.length > 10 * 1024 * 1024) throw new ApiError(400, '이미지는 10MB 이하여야 합니다', {});
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const rel = `${assetsDirFor(from)}/${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      await store.put(rel, bytes);
      engine.schedule(2500);
      return encodeURI(relativePath(dirOf(from), rel)).replace(/\(/g, '%28').replace(/\)/g, '%29');
    },
    async syncInfo() {
      return info();
    },
    async syncNow() {
      await engine.run();
      return info();
    },
  };

  const backend: CloudBackend = {
    api,
    engine,
    store,
    canManage: false,
    cloud: true,
    signOut,
    subscribe(onEvent, onReconnect) {
      listeners.add(onEvent);
      onReconnect();
      return () => void listeners.delete(onEvent);
    },
    onSyncChange(fn) {
      syncListeners.add(fn);
      return () => void syncListeners.delete(fn);
    },
    dispose() {},
  };
  return backend;
}

/** Supabase 와 연결한 모바일 백엔드를 만들고 자동 동기화를 시작한다 */
export async function createCloudBackend(client: SupabaseClient, owner: string): Promise<CloudBackend> {
  const backend = await buildCloudBackend(new BrowserRemote(client, owner), async () => {
    await client.auth.signOut();
  });
  const { engine } = backend;
  // 처음, 30초마다, 앱으로 돌아왔을 때, 온라인이 되었을 때, 다른 기기가 바꿨을 때 동기화한다
  const run = () => void engine.run().catch(() => {});
  run();
  const timer = setInterval(run, 30_000);
  const onVisible = () => document.visibilityState === 'visible' && run();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', run);
  const channel = client
    .channel('vault-files')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vault_files' }, () => engine.schedule(500))
    .subscribe();
  backend.dispose = () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', run);
    void client.removeChannel(channel);
  };
  return backend;
}
