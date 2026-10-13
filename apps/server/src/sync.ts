import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STUDY_PATH, SyncEngine, isTextPath, type LocalStore, type Remote, type SyncState } from '@mindmap/core';
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
    try {
      out.set(STUDY_PATH, hashBytes(await fs.readFile(this.abs(STUDY_PATH))));
    } catch {
      /* 아직 복습 기록이 없음 */
    }
    return out;
  }

  async read(rel: string): Promise<Uint8Array> {
    return fs.readFile(this.abs(rel));
  }

  async write(rel: string, bytes: Uint8Array, expectHash: string | null): Promise<void> {
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

  async remove(rel: string): Promise<void> {
    if (this.vault.exists(rel)) await this.vault.trash(rel);
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
