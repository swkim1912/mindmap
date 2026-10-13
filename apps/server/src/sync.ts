import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mergeMaps, parseMap, serializeMap } from '@mindmap/core';
import { HttpError, MAP_EXT, Vault, atomicWrite } from './vault';

export interface RemoteRow {
  path: string;
  /** 텍스트 파일(.md)은 내용을 그대로 담는다 */
  content: string | null;
  /** 그 외 파일(이미지 등)은 Storage 의 객체 이름 */
  blob: string | null;
  hash: string;
  deleted: boolean;
  updated_at: string;
}

export interface PutRow {
  path: string;
  content: string | null;
  blob: string | null;
  hash: string;
  deleted: boolean;
}

/** 클라우드 쪽 저장소. 테스트에서는 메모리 구현으로 바꿔 끼운다. */
export interface Remote {
  /** cursor 이후에 바뀐 행 (cursor 가 null 이면 전부) */
  listSince(cursor: string | null): Promise<RemoteRow[]>;
  put(row: PutRow): Promise<void>;
  blobName(hash: string, ext: string): string;
  uploadBlob(name: string, bytes: Buffer): Promise<void>;
  downloadBlob(name: string): Promise<Buffer>;
}

interface SyncState {
  /** 마지막으로 서로 맞춘 시점의 파일 해시 */
  files: Record<string, string>;
  cursor: string | null;
}

export interface SyncStatus {
  state: 'off' | 'idle' | 'syncing' | 'error';
  lastSync: string | null;
  error: string | null;
  /** 최근 한 번의 동기화에서 처리한 건수 */
  pushed: number;
  pulled: number;
  merged: number;
  conflicts: number;
}

const MAX_BLOB = 10 * 1024 * 1024;

export function hashBytes(buf: Buffer | string): string {
  return createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

const isText = (rel: string) => rel.endsWith('.md');

export class SyncEngine {
  private state: SyncState = { files: {}, cursor: null };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  status: SyncStatus = { state: 'idle', lastSync: null, error: null, pushed: 0, pulled: 0, merged: 0, conflicts: 0 };
  onChange?: () => void;

  constructor(
    private vault: Vault,
    private remote: Remote,
  ) {}

  private get stateFile() {
    return path.join(this.vault.internalDir, 'sync.json');
  }
  private baseFile(rel: string) {
    return path.join(this.vault.internalDir, 'sync-base', ...rel.split('/'));
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const s = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as SyncState;
      if (s && typeof s.files === 'object') this.state = { files: s.files ?? {}, cursor: s.cursor ?? null };
    } catch {
      /* 처음이거나 깨진 상태 파일: 처음부터 비교한다 (내용이 같으면 변화 없음으로 처리됨) */
    }
  }

  private async saveState() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await atomicWrite(this.stateFile, JSON.stringify(this.state));
  }

  /** 잠시 뒤 동기화한다 (여러 번 불려도 한 번만 실행) */
  schedule(delayMs = 1500) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run().catch(() => {}), delayMs);
  }

  /** 동기화를 한 줄로 세워 실행한다. 실행 중에 또 불리면 끝난 뒤 한 번 더 돈다. */
  run(): Promise<SyncStatus> {
    if (this.status.state === 'syncing') {
      this.dirty = true;
      return this.queue.then(() => this.status);
    }
    const job = async () => {
      do {
        this.dirty = false;
        await this.pass();
      } while (this.dirty && this.status.state !== 'error');
      return this.status;
    };
    const result = this.queue.then(job, job);
    this.queue = result.catch(() => {});
    return result;
  }

  private async scanLocal(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (abs: string) => {
      for (const e of await fs.readdir(abs, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(abs, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) out.set(this.vault.toRel(p), hashBytes(await fs.readFile(p)));
      }
    };
    await walk(this.vault.root);
    return out;
  }

  private async pass() {
    await this.load();
    const st = this.status;
    Object.assign(st, { state: 'syncing', error: null, pushed: 0, pulled: 0, merged: 0, conflicts: 0 });
    this.onChange?.();
    try {
      const local = await this.scanLocal();
      const rows = await this.remote.listSince(this.state.cursor);
      const delta = new Map<string, RemoteRow>();
      let cursor = this.state.cursor;
      for (const r of rows) {
        delta.set(r.path, r);
        if (!cursor || r.updated_at > cursor) cursor = r.updated_at;
      }
      const paths = new Set<string>([...local.keys(), ...Object.keys(this.state.files), ...delta.keys()]);
      for (const rel of [...paths].sort()) {
        try {
          await this.syncPath(rel, local.get(rel) ?? null, delta.get(rel));
        } catch (e) {
          // 한 파일의 문제(잠김, 충돌 등)가 전체 동기화를 막지 않게 하고, 다음 주기에 다시 시도한다
          console.error(`[sync] ${rel}:`, (e as Error).message);
          this.dirty = false;
          st.error = `${rel}: ${(e as Error).message}`;
          cursor = this.state.cursor; // 이 회차의 변경을 다시 받아 확인한다
        }
      }
      this.state.cursor = cursor;
      await this.saveState();
      st.state = st.error ? 'error' : 'idle';
      st.lastSync = new Date().toISOString();
    } catch (e) {
      st.state = 'error';
      st.error = (e as Error).message;
    }
    this.onChange?.();
  }

  private async syncPath(rel: string, L: string | null, R: RemoteRow | undefined) {
    const S = this.state.files[rel] ?? null;
    const Rh = R ? (R.deleted ? null : R.hash) : undefined;
    const localChanged = L !== S;
    const remoteChanged = R !== undefined && Rh !== S;
    if (!localChanged && !remoteChanged) return;
    if (localChanged && !remoteChanged) return this.push(rel, L);
    if (!localChanged) return this.pull(rel, R!);
    // 양쪽이 모두 바뀜
    if (L === Rh) return this.markSynced(rel, L);
    if (L === null) return this.pull(rel, R!); // 한쪽은 지웠고 다른 쪽은 고침 → 고친 쪽을 살린다
    if (Rh === null) return this.push(rel, L);
    return this.conflict(rel, R!);
  }

  private async markSynced(rel: string, hash: string | null) {
    if (hash === null) delete this.state.files[rel];
    else this.state.files[rel] = hash;
  }

  private async push(rel: string, hash: string | null) {
    if (hash === null) {
      await this.remote.put({ path: rel, content: null, blob: null, hash: '', deleted: true });
      await this.markSynced(rel, null);
      await fs.rm(this.baseFile(rel), { force: true });
      this.status.pushed++;
      return;
    }
    const bytes = await this.vault.readBuffer(rel);
    const real = hashBytes(bytes); // 스캔 뒤에 바뀌었을 수 있으니 다시 계산한다
    if (isText(rel)) {
      await this.remote.put({ path: rel, content: bytes.toString('utf8'), blob: null, hash: real, deleted: false });
    } else {
      if (bytes.length > MAX_BLOB) throw new Error(`파일이 너무 큽니다 (10MB 초과): ${rel}`);
      const name = this.remote.blobName(real, path.extname(rel));
      await this.remote.uploadBlob(name, bytes);
      await this.remote.put({ path: rel, content: null, blob: name, hash: real, deleted: false });
    }
    await this.markSynced(rel, real);
    if (rel.endsWith(MAP_EXT)) await this.saveBase(rel, bytes);
    this.status.pushed++;
  }

  private async fetchBytes(R: RemoteRow): Promise<Buffer> {
    if (R.blob) return this.remote.downloadBlob(R.blob);
    return Buffer.from(R.content ?? '', 'utf8');
  }

  private async saveBase(rel: string, bytes: Buffer) {
    const f = this.baseFile(rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await atomicWrite(f, bytes);
  }

  private async pull(rel: string, R: RemoteRow) {
    if (R.deleted) {
      if (this.vault.exists(rel)) await this.vault.trash(rel);
      await this.markSynced(rel, null);
      await fs.rm(this.baseFile(rel), { force: true });
      this.status.pulled++;
      return;
    }
    const bytes = await this.fetchBytes(R);
    await this.writeLocal(rel, bytes);
    await this.markSynced(rel, hashBytes(bytes));
    if (rel.endsWith(MAP_EXT)) await this.saveBase(rel, bytes);
    this.status.pulled++;
  }

  /** 디스크에 쓴다. 텍스트는 덮어쓰기 전 히스토리에 보관되고, 그 사이 로컬이 바뀌었으면 건너뛴다. */
  private async writeLocal(rel: string, bytes: Buffer) {
    if (isText(rel)) {
      let current: string | null = null;
      try {
        current = (await this.vault.read(rel)).content;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
      await this.vault.write(rel, bytes.toString('utf8'), current === null ? null : hashBytes(current));
    } else {
      await this.vault.writeRaw(rel, bytes);
    }
  }

  private async conflict(rel: string, R: RemoteRow) {
    const remoteBytes = await this.fetchBytes(R);
    const localBytes = await this.vault.readBuffer(rel);
    const st = this.status;
    let merged: Buffer | null = null;
    let sameNodeConflict = false;
    if (rel.endsWith(MAP_EXT)) {
      let baseSrc: string | null = null;
      try {
        baseSrc = await fs.readFile(this.baseFile(rel), 'utf8');
      } catch {
        /* 기준본이 없으면 병합하지 않고 사본으로 보존한다 */
      }
      if (baseSrc !== null) {
        const r = mergeMaps(
          parseMap(baseSrc).doc,
          parseMap(localBytes.toString('utf8')).doc,
          parseMap(remoteBytes.toString('utf8')).doc,
        );
        merged = Buffer.from(serializeMap(r.doc), 'utf8');
        sameNodeConflict = r.conflicts.length > 0;
        st.merged++;
      }
    }
    if (merged === null || sameNodeConflict) {
      // 로컬 내용을 우선하고, 클라우드 쪽 내용은 사본 파일로 남겨 잃지 않게 한다
      await this.vault.writeRaw(conflictCopyName(rel), remoteBytes);
      st.conflicts++;
    }
    const finalBytes = merged ?? localBytes;
    if (!finalBytes.equals(localBytes)) await this.writeLocal(rel, finalBytes);
    // 합친 결과를 클라우드에도 올린다 (클라우드의 현재 상태를 기준으로 덮어쓴다)
    this.state.files[rel] = hashBytes(remoteBytes);
    await this.push(rel, hashBytes(finalBytes));
  }
}

export function conflictCopyName(rel: string): string {
  const ext = rel.endsWith(MAP_EXT) ? MAP_EXT : path.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  return `${stem} (충돌 사본)${ext}`;
}
