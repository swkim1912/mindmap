import { MAP_SUFFIX } from './links';
import { mergeMaps } from './merge';
import { parseMap } from './parse';
import { serializeMap } from './serialize';

/**
 * PC(Node)와 모바일(브라우저)이 함께 쓰는 동기화 엔진.
 * 파일 접근(LocalStore)과 클라우드 접근(Remote)을 바깥에서 주입받는다.
 */

/** 복습 기록. 숨김 폴더에 있지만 동기화 대상이다 (카드별로 더 최근 기록을 채택) */
export const STUDY_PATH = '.mindmap/study.json';

export interface RemoteRow {
  path: string;
  /** 텍스트 파일은 내용을 그대로 담는다 */
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

export interface Remote {
  /** cursor 이후에 바뀐 행 (cursor 가 null 이면 전부) */
  listSince(cursor: string | null): Promise<RemoteRow[]>;
  put(row: PutRow): Promise<void>;
  blobName(hash: string, ext: string): string;
  uploadBlob(name: string, bytes: Uint8Array): Promise<void>;
  downloadBlob(name: string): Promise<Uint8Array>;
}

export interface SyncState {
  /** 마지막으로 서로 맞춘 시점의 파일 해시 */
  files: Record<string, string>;
  cursor: string | null;
}

export interface LocalStore {
  /** 동기화 대상 파일 전부: 경로 → 내용 해시 */
  scan(): Promise<Map<string, string>>;
  read(rel: string): Promise<Uint8Array>;
  /** expectHash: 쓰기 직전 현재 해시여야 하는 값 (null = 없어야 함). 다르면 throw — 그 사이 편집을 덮어쓰지 않기 위해 */
  write(rel: string, bytes: Uint8Array, expectHash: string | null): Promise<void>;
  /** 삭제 (복구 가능한 곳으로 옮긴다) */
  remove(rel: string): Promise<void>;
  readBase(rel: string): Promise<Uint8Array | null>;
  writeBase(rel: string, bytes: Uint8Array | null): Promise<void>;
  loadState(): Promise<SyncState | null>;
  saveState(state: SyncState): Promise<void>;
}

export interface SyncStatus {
  state: 'off' | 'idle' | 'syncing' | 'error';
  lastSync: string | null;
  error: string | null;
  pushed: number;
  pulled: number;
  merged: number;
  conflicts: number;
}

export const MAX_BLOB = 10 * 1024 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const isTextPath = (rel: string) => rel.endsWith('.md') || rel === STUDY_PATH;

/** 동기화할 수 있는 경로인가 (숨김·상위 경로·이상한 문자는 제외) */
export function isSyncablePath(rel: string): boolean {
  if (rel === STUDY_PATH) return true;
  if (!rel || rel.length > 400 || rel.startsWith('/') || /[\\<>:"|?*\x00-\x1f]/.test(rel)) return false;
  return rel.split('/').every((s) => s !== '' && s !== '..' && !s.startsWith('.'));
}

export function conflictCopyName(rel: string, n = 1): string {
  const dot = rel.lastIndexOf('.');
  const ext = rel.endsWith(MAP_SUFFIX) ? MAP_SUFFIX : dot > rel.lastIndexOf('/') ? rel.slice(dot) : '';
  return `${rel.slice(0, rel.length - ext.length)} (충돌 사본${n > 1 ? ` ${n}` : ''})${ext}`;
}

type StudyData = Record<string, Record<string, { last?: string }>>;

/** 복습 기록 병합: 카드마다 마지막 복습 시각이 더 늦은 쪽을 채택 */
export function mergeStudy(a: string, b: string): string {
  const parse = (s: string): StudyData => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as StudyData) : {};
    } catch {
      return {};
    }
  };
  const A = parse(a);
  const B = parse(b);
  const out: StudyData = {};
  for (const map of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const ra = A[map] ?? {};
    const rb = B[map] ?? {};
    const m: StudyData[string] = {};
    for (const id of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      const x = ra[id];
      const y = rb[id];
      m[id] = !x ? y : !y ? x : (y.last ?? '') > (x.last ?? '') ? y : x;
    }
    out[map] = m;
  }
  return JSON.stringify(out, null, 1);
}

export class SyncEngine {
  private state: SyncState = { files: {}, cursor: null };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  status: SyncStatus = { state: 'idle', lastSync: null, error: null, pushed: 0, pulled: 0, merged: 0, conflicts: 0 };
  onChange?: () => void;

  constructor(
    private local: LocalStore,
    private remote: Remote,
    private hash: (bytes: Uint8Array) => Promise<string>,
  ) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const s = await this.local.loadState().catch(() => null);
    // 상태가 없거나 깨졌으면 처음부터 비교한다 (내용이 같으면 변화 없음으로 처리됨)
    if (s && typeof s.files === 'object') this.state = { files: s.files ?? {}, cursor: s.cursor ?? null };
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

  private async pass() {
    await this.load();
    const st = this.status;
    Object.assign(st, { state: 'syncing', error: null, pushed: 0, pulled: 0, merged: 0, conflicts: 0 });
    this.onChange?.();
    try {
      const local = await this.local.scan();
      const rows = await this.remote.listSince(this.state.cursor);
      const delta = new Map<string, RemoteRow>();
      let cursor = this.state.cursor;
      for (const r of rows) {
        if (!isSyncablePath(r.path)) continue;
        delta.set(r.path, r);
        if (!cursor || r.updated_at > cursor) cursor = r.updated_at;
      }
      const paths = new Set<string>([...local.keys(), ...Object.keys(this.state.files), ...delta.keys()]);
      for (const rel of [...paths].sort()) {
        try {
          await this.syncPath(rel, local.get(rel) ?? null, delta.get(rel));
        } catch (e) {
          // 한 파일의 문제(잠김, 사이에 바뀜 등)가 전체를 막지 않게 하고, 다음 주기에 다시 시도한다
          console.error(`[sync] ${rel}:`, (e as Error).message);
          st.error = `${rel}: ${(e as Error).message}`;
          cursor = this.state.cursor; // 이번 회차에 받은 변경을 다음에 다시 확인한다
        }
      }
      this.state.cursor = cursor;
      await this.local.saveState(this.state);
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
    if (!localChanged) return this.pull(rel, R!, L);
    // 양쪽이 모두 바뀜
    if (L === Rh) return this.markSynced(rel, L);
    if (L === null) return this.pull(rel, R!, L); // 한쪽은 지웠고 다른 쪽은 고침 → 고친 쪽을 살린다
    if (Rh === null) return this.push(rel, L);
    return this.conflict(rel, R!, L);
  }

  private markSynced(rel: string, hash: string | null) {
    if (hash === null) delete this.state.files[rel];
    else this.state.files[rel] = hash;
  }

  private async push(rel: string, hash: string | null) {
    if (hash === null) {
      await this.remote.put({ path: rel, content: null, blob: null, hash: '', deleted: true });
      this.markSynced(rel, null);
      await this.local.writeBase(rel, null);
      this.status.pushed++;
      return;
    }
    const bytes = await this.local.read(rel);
    const real = await this.hash(bytes); // 스캔 뒤에 바뀌었을 수 있으니 다시 계산한다
    if (isTextPath(rel)) {
      await this.remote.put({ path: rel, content: dec.decode(bytes), blob: null, hash: real, deleted: false });
    } else {
      if (bytes.length > MAX_BLOB) throw new Error(`파일이 너무 큽니다 (10MB 초과): ${rel}`);
      const dot = rel.lastIndexOf('.');
      const name = this.remote.blobName(real, dot > rel.lastIndexOf('/') ? rel.slice(dot) : '');
      await this.remote.uploadBlob(name, bytes);
      await this.remote.put({ path: rel, content: null, blob: name, hash: real, deleted: false });
    }
    this.markSynced(rel, real);
    if (rel.endsWith(MAP_SUFFIX)) await this.local.writeBase(rel, bytes);
    this.status.pushed++;
  }

  private fetchBytes(R: RemoteRow): Promise<Uint8Array> {
    return R.blob ? this.remote.downloadBlob(R.blob) : Promise.resolve(enc.encode(R.content ?? ''));
  }

  private async pull(rel: string, R: RemoteRow, L: string | null) {
    if (R.deleted) {
      if (L !== null) await this.local.remove(rel);
      this.markSynced(rel, null);
      await this.local.writeBase(rel, null);
      this.status.pulled++;
      return;
    }
    const bytes = await this.fetchBytes(R);
    await this.local.write(rel, bytes, L);
    this.markSynced(rel, await this.hash(bytes));
    if (rel.endsWith(MAP_SUFFIX)) await this.local.writeBase(rel, bytes);
    this.status.pulled++;
  }

  private async conflict(rel: string, R: RemoteRow, L: string) {
    const remoteBytes = await this.fetchBytes(R);
    const localBytes = await this.local.read(rel);
    const st = this.status;
    let merged: Uint8Array | null = null;
    let sameNodeConflict = false;
    if (rel === STUDY_PATH) {
      merged = enc.encode(mergeStudy(dec.decode(localBytes), dec.decode(remoteBytes)));
      st.merged++;
    } else if (rel.endsWith(MAP_SUFFIX)) {
      const base = await this.local.readBase(rel);
      if (base) {
        const r = mergeMaps(
          parseMap(dec.decode(base)).doc,
          parseMap(dec.decode(localBytes)).doc,
          parseMap(dec.decode(remoteBytes)).doc,
        );
        merged = enc.encode(serializeMap(r.doc));
        sameNodeConflict = r.conflicts.length > 0;
        st.merged++;
      }
      // 기준본이 없으면 병합하지 않고 사본으로 보존한다
    }
    if (merged === null || sameNodeConflict) {
      // 로컬 내용을 우선하고, 클라우드 쪽 내용은 사본 파일로 남겨 잃지 않게 한다
      for (let n = 1; ; n++) {
        try {
          await this.local.write(conflictCopyName(rel, n), remoteBytes, null);
          break;
        } catch (e) {
          if (n >= 20) throw e; // 같은 이름의 사본이 이미 있으면 번호를 올려 다시 시도
        }
      }
      st.conflicts++;
    }
    const finalBytes = merged ?? localBytes;
    const finalHash = await this.hash(finalBytes);
    if (finalHash !== L) await this.local.write(rel, finalBytes, L);
    // 합친 결과를 클라우드에도 올린다
    await this.push(rel, finalHash);
  }
}
