import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultIndex, type FileLookup, type FileRec } from '@mindmap/core';
import type { Vault } from './vault';

export { plainTitle } from '@mindmap/core';
export type { BacklinkSource, FileRec, LinkRec, NodeRec, SearchHit } from '@mindmap/core';

/** Vault 폴더를 훑어 VaultIndex 를 채우고 최신으로 유지한다 */
export class Indexer {
  private index = new VaultIndex();
  readonly ready: Promise<void>;
  private markReady!: () => void;

  constructor(private vault: Vault) {
    this.ready = new Promise<void>((resolve) => (this.markReady = resolve));
  }

  /** Vault 폴더가 준비된 뒤에 호출한다. 처음 스캔이 끝나면 ready 가 풀린다. */
  async start(): Promise<void> {
    try {
      await this.scan();
    } catch (e) {
      console.error('[index] 처음 색인 실패:', e);
    } finally {
      this.markReady();
    }
  }

  private async scan() {
    for (const rel of await this.freshPaths()) await this.update(rel);
  }

  /** 색인을 비우고 처음부터 다시 만든다 (감시 없이 파일을 옮긴 뒤에 쓴다) */
  async rebuild(): Promise<void> {
    this.index.clear();
    await this.scan();
  }

  /** 파일이 바뀌었거나(또는 지워졌으면) 색인을 갱신한다 */
  async update(rel: string): Promise<void> {
    if (!VaultIndex.isIndexable(rel)) return;
    let src: string | null;
    try {
      src = await fs.readFile(this.vault.resolve(rel), 'utf8');
    } catch {
      src = null;
    }
    this.index.set(rel, src);
  }

  /** 색인과 무관하게 디스크를 직접 훑어 .md 목록을 만든다 (이동 직전처럼 정확해야 할 때) */
  async freshPaths(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (abs: string) => {
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // 폴더가 아직 없음/방금 삭제됨
        throw e;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(abs, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && VaultIndex.isIndexable(this.vault.toRel(p))) out.push(this.vault.toRel(p));
      }
    };
    await walk(this.vault.root);
    return out.sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  }

  paths = (): string[] => this.index.paths();
  lookup = (): FileLookup => this.index.lookup();
  get = (rel: string): FileRec | undefined => this.index.get(rel);
  all = (): FileRec[] => this.index.all();
  search = (query: string, limit = 50) => this.index.search(query, limit);
  backlinks = (target: string) => this.index.backlinks(target);
}
