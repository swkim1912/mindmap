import { STUDY_PATH, type LocalStore, type SyncState } from '@mindmap/core';

/** 브라우저(모바일)용 로컬 저장소: 파일은 IndexedDB 에 두고, 메모리에도 올려 둔다. */

const DB_NAME = 'mindmap-cloud';
const FILES = 'files';
const KV = 'kv';

export interface FileRec {
  path: string;
  bytes: Uint8Array;
  hash: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'path' });
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** SHA-1 의 앞 16자리(hex). PC(Node)의 hashBytes 와 같은 값이어야 한다. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', bytes as BufferSource);
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export class IdbLocalStore implements LocalStore {
  private db!: IDBDatabase;
  private files = new Map<string, FileRec>();
  /** 파일이 바뀌면 호출된다 (hash 가 null 이면 삭제, existed 는 변경 전 존재 여부) */
  onChange: (path: string, hash: string | null, existed: boolean) => void = () => {};

  async init() {
    this.db = await openDb();
    for (const rec of await tx<FileRec[]>(this.db, FILES, 'readonly', (s) => s.getAll())) this.files.set(rec.path, rec);
  }

  paths(): string[] {
    return [...this.files.keys()];
  }
  get(path: string): FileRec | undefined {
    return this.files.get(path);
  }

  /** 앱에서 편집한 내용을 저장한다 */
  async put(path: string, bytes: Uint8Array): Promise<string> {
    const hash = await hashBytes(bytes);
    const existed = this.files.has(path);
    const rec: FileRec = { path, bytes, hash };
    await tx(this.db, FILES, 'readwrite', (s) => s.put(rec));
    this.files.set(path, rec);
    this.onChange(path, hash, existed);
    return hash;
  }

  async delete(path: string): Promise<void> {
    const existed = this.files.has(path);
    if (!existed) return;
    await tx(this.db, FILES, 'readwrite', (s) => s.delete(path));
    this.files.delete(path);
    this.onChange(path, null, true);
  }

  private kvGet<T>(key: string): Promise<T | undefined> {
    return tx<T | undefined>(this.db, KV, 'readonly', (s) => s.get(key));
  }
  private kvPut(key: string, value: unknown): Promise<unknown> {
    return tx(this.db, KV, 'readwrite', (s) => s.put(value, key));
  }

  // ---- LocalStore ----
  async scan(): Promise<Map<string, string>> {
    return new Map([...this.files.values()].map((f) => [f.path, f.hash]));
  }
  async read(rel: string): Promise<Uint8Array> {
    const f = this.files.get(rel);
    if (!f) throw new Error(`파일이 없습니다: ${rel}`);
    return f.bytes;
  }
  async write(rel: string, bytes: Uint8Array, expectHash: string | null): Promise<void> {
    const cur = this.files.get(rel)?.hash ?? null;
    if (cur !== expectHash) throw new Error('그 사이 파일이 바뀌었습니다 (다음 동기화에서 다시 시도)');
    await this.put(rel, bytes);
  }
  async remove(rel: string): Promise<void> {
    await this.delete(rel);
  }
  async readBase(rel: string): Promise<Uint8Array | null> {
    return (await this.kvGet<Uint8Array>(`base:${rel}`)) ?? null;
  }
  async writeBase(rel: string, bytes: Uint8Array | null): Promise<void> {
    if (bytes === null) await tx(this.db, KV, 'readwrite', (s) => s.delete(`base:${rel}`));
    else await this.kvPut(`base:${rel}`, bytes);
  }
  async loadState(): Promise<SyncState | null> {
    return (await this.kvGet<SyncState>('state')) ?? null;
  }
  async saveState(state: SyncState): Promise<void> {
    await this.kvPut('state', state);
  }
}

export { STUDY_PATH };
