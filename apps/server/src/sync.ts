import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  FOLDERS_PATH,
  STUDY_PATH,
  SILENT_PREFIX,
  SyncEngine,
  isSilentTrash,
  isTextPath,
  isTrashId,
  newTrashId,
  parseFolders,
  stringifyFolders,
  type LocalStore,
  type Remote,
  type SyncState,
} from '@mindmap/core';
import { Vault, atomicWrite } from './vault';

export function hashBytes(buf: Uint8Array | string): string {
  return createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

/** Vault 폴더를 동기화 엔진에 연결한다 */
export class NodeLocalStore implements LocalStore {
  constructor(
    private vault: Vault,
    /** 복습 기록 파일이 바뀐 뒤 메모리 캐시를 버리게 하는 콜백 */
    private onStudyChanged: () => void = () => {},
  ) {}

  private abs(rel: string) {
    return rel === STUDY_PATH ? path.join(this.vault.internalDir, 'study.json') : this.vault.resolve(rel);
  }
  private baseFile(rel: string) {
    return path.join(this.vault.internalDir, 'sync-base', ...rel.split('/'));
  }

  /** 파일이 하나도 없는 폴더들 (맵에 딸린 폴더는 제외). 빈 폴더도 다른 기기에 전달하기 위해 목록으로 만든다. */
  private async emptyDirs(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (abs: string): Promise<boolean> => {
      let hasFiles = false;
      const ents = await fs.readdir(abs, { withFileTypes: true });
      const names = new Set(ents.map((e) => e.name));
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(abs, e.name);
        if (e.isFile()) hasFiles = true;
        else if (e.isDirectory()) {
          if (names.has(`${e.name}.mm.md`)) {
            hasFiles = true; // 맵에 딸린 폴더는 맵의 일부
            continue;
          }
          if (await walk(p)) hasFiles = true;
          else out.push(this.vault.toRel(p));
        }
      }
      return hasFiles;
    };
    await walk(this.vault.root);
    return out;
  }

  private async foldersBytes(): Promise<Buffer> {
    return Buffer.from(stringifyFolders(await this.emptyDirs()), 'utf8');
  }

  async scan(): Promise<Map<string, string>> {
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
    out.set(FOLDERS_PATH, hashBytes(await this.foldersBytes()));
    try {
      out.set(STUDY_PATH, hashBytes(await fs.readFile(this.abs(STUDY_PATH))));
    } catch {
      /* 아직 복습 기록이 없음 */
    }
    return out;
  }

  async read(rel: string): Promise<Uint8Array> {
    if (rel === FOLDERS_PATH) return this.foldersBytes();
    return fs.readFile(this.abs(rel));
  }

  async write(rel: string, bytes: Uint8Array, expectHash: string | null): Promise<void> {
    if (rel === FOLDERS_PATH) return this.writeFolders(bytes, expectHash);
    const abs = this.abs(rel);
    let current: Buffer | null = null;
    try {
      current = await fs.readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if ((current === null ? null : hashBytes(current)) !== expectHash) {
      throw new Error('그 사이 로컬 파일이 바뀌었습니다 (다음 동기화에서 다시 시도)');
    }
    if (rel === STUDY_PATH) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await atomicWrite(abs, Buffer.from(bytes));
      this.onStudyChanged();
    } else if (isTextPath(rel) && current !== null) {
      // 히스토리 스냅샷이 남도록 Vault.write 를 거친다
      await this.vault.write(rel, Buffer.from(bytes).toString('utf8'), hashBytes(current));
    } else {
      await this.vault.writeRaw(rel, Buffer.from(bytes));
    }
  }

  /** 다른 기기의 빈 폴더 목록을 반영한다: 새 폴더는 만들고, 목록에서 빠진 빈 폴더는 지운다 */
  private async writeFolders(bytes: Uint8Array, expectHash: string | null) {
    const cur = await this.emptyDirs();
    if (hashBytes(Buffer.from(stringifyFolders(cur))) !== expectHash) {
      throw new Error('그 사이 폴더가 바뀌었습니다 (다음 동기화에서 다시 시도)');
    }
    const next = new Set(parseFolders(Buffer.from(bytes).toString('utf8')));
    for (const rel of next) {
      try {
        await fs.mkdir(this.vault.resolve(rel), { recursive: true });
      } catch {
        /* 이상한 경로는 무시 */
      }
    }
    // 깊은 폴더부터 지워야 비게 된 상위 폴더도 지워진다
    for (const rel of cur.filter((d) => !next.has(d)).sort((a, b) => b.length - a.length)) {
      await fs.rmdir(this.vault.resolve(rel)).catch(() => {});
    }
  }

  /** 삭제: 묶음 ID 가 있으면 휴지통에 보이는 항목으로, 없으면 눈에 띄지 않는 임시 보관으로 옮긴다 */
  async remove(rel: string, trashId?: string): Promise<void> {
    if (!this.vault.exists(rel)) return;
    await this.vault.trash(rel, trashId && isTrashId(trashId) ? trashId : SILENT_PREFIX + newTrashId());
  }

  async readTrashed(rel: string): Promise<{ bytes: Uint8Array; trashId: string } | null> {
    let dirs: string[];
    try {
      dirs = (await fs.readdir(this.vault.trashDir)).filter((d) => isTrashId(d) && !isSilentTrash(d)).sort().reverse();
    } catch {
      return null;
    }
    for (const d of dirs) {
      try {
        return { bytes: await fs.readFile(path.join(this.vault.trashDir, d, ...rel.split('/'))), trashId: d };
      } catch {
        /* 이 묶음에는 없음 */
      }
    }
    return null;
  }

  async stashTrash(rel: string, bytes: Uint8Array, trashId: string): Promise<void> {
    if (!isTrashId(trashId) || isSilentTrash(trashId)) return;
    const dest = path.join(this.vault.trashDir, trashId, ...rel.split('/'));
    try {
      await fs.access(dest);
      return;
    } catch {
      /* 없으면 만든다 */
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await atomicWrite(dest, Buffer.from(bytes));
  }

  async readBase(rel: string): Promise<Uint8Array | null> {
    return fs.readFile(this.baseFile(rel)).catch(() => null);
  }

  async writeBase(rel: string, bytes: Uint8Array | null): Promise<void> {
    const f = this.baseFile(rel);
    if (bytes === null) return void (await fs.rm(f, { force: true }));
    await fs.mkdir(path.dirname(f), { recursive: true });
    await atomicWrite(f, Buffer.from(bytes));
  }

  async loadState(): Promise<SyncState | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.vault.internalDir, 'sync.json'), 'utf8')) as SyncState;
    } catch {
      return null;
    }
  }

  async saveState(state: SyncState): Promise<void> {
    await fs.mkdir(this.vault.internalDir, { recursive: true });
    await atomicWrite(path.join(this.vault.internalDir, 'sync.json'), JSON.stringify(state));
  }
}

export function createSyncEngine(vault: Vault, remote: Remote, onStudyChanged?: () => void): SyncEngine {
  return new SyncEngine(new NodeLocalStore(vault, onStudyChanged), remote, async (b) => hashBytes(b));
}

export { SyncEngine };
