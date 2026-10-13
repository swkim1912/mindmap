import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAP_EXT = '.mm.md';

export interface TreeEntry {
  name: string;
  /** Vault 기준 상대 경로, '/' 구분 */
  path: string;
  kind: 'dir' | 'map';
  children?: TreeEntry[];
}

export class HttpError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 500,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export function hashContent(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 16);
}

export function isHiddenRel(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => seg.startsWith('.'));
}

export class Vault {
  readonly internalDir: string;
  private lastSnapshot = new Map<string, number>();

  constructor(readonly root: string) {
    this.internalDir = path.join(root, '.mindmap');
  }

  /** 상대 경로를 검증하고 절대 경로로 바꾼다. Vault 밖이나 숨김 경로는 거부한다. */
  resolve(rel: string): string {
    if (typeof rel !== 'string') throw new HttpError(400, 'path가 필요합니다');
    const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const segs = norm.split('/').filter(Boolean);
    if (segs.some((s) => s === '..' || s.startsWith('.'))) throw new HttpError(400, `허용되지 않는 경로: ${rel}`);
    if (/[<>:"|?*\x00-\x1f]/.test(norm)) throw new HttpError(400, `경로에 사용할 수 없는 문자가 있습니다: ${rel}`);
    const abs = path.resolve(this.root, ...segs);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new HttpError(400, 'Vault 밖 경로입니다');
    return abs;
  }

  toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async tree(): Promise<TreeEntry[]> {
    const walk = async (abs: string): Promise<TreeEntry[]> => {
      const ents = await fs.readdir(abs, { withFileTypes: true });
      const names = new Set(ents.map((e) => e.name));
      const out: TreeEntry[] = [];
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const childAbs = path.join(abs, e.name);
        if (e.isDirectory()) {
          // 맵에 딸린 폴더(같은 이름의 .mm.md가 있는 폴더)는 숨긴다
          if (names.has(e.name + MAP_EXT)) continue;
          out.push({ name: e.name, path: this.toRel(childAbs), kind: 'dir', children: await walk(childAbs) });
        } else if (e.isFile() && e.name.endsWith(MAP_EXT)) {
          out.push({ name: e.name.slice(0, -MAP_EXT.length), path: this.toRel(childAbs), kind: 'map' });
        }
      }
      out.sort((a, b) =>
        a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'ko', { numeric: true }),
      );
      return out;
    };
    return walk(this.root);
  }

  async read(rel: string): Promise<{ content: string; hash: string }> {
    const abs = this.resolve(rel);
    try {
      const content = await fs.readFile(abs, 'utf8');
      return { content, hash: hashContent(content) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, `파일이 없습니다: ${rel}`);
      throw e;
    }
  }

  /**
   * baseHash가 현재 디스크 내용과 다르면 409(충돌)와 함께 디스크 내용을 돌려준다.
   * baseHash가 null이면 새 파일 생성으로 보고, 이미 있으면 409.
   */
  async write(rel: string, content: string, baseHash: string | null): Promise<{ hash: string }> {
    const abs = this.resolve(rel);
    let current: string | null = null;
    try {
      current = await fs.readFile(abs, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (current !== null && hashContent(current) !== baseHash) {
      throw new HttpError(409, '디스크의 파일이 변경되었습니다', { content: current, hash: hashContent(current) });
    }
    if (current === null && baseHash !== null) {
      throw new HttpError(409, '파일이 삭제되었습니다', { content: null, hash: null });
    }
    if (current !== null && current !== content) await this.snapshot(rel, current);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await atomicWrite(abs, content);
    return { hash: hashContent(content) };
  }

  /** 충돌 검사 없이 쓴다 (링크 갱신, 업로드 등 앱이 직접 만드는 파일용) */
  async writeRaw(rel: string, content: string | Buffer): Promise<void> {
    const abs = this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await atomicWrite(abs, content);
  }

  async readBuffer(rel: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolve(rel));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, `파일이 없습니다: ${rel}`);
      throw e;
    }
  }

  exists(rel: string): boolean {
    return existsSync(this.resolve(rel));
  }

  /** 새 파일만 만든다. 이미 있으면 409 */
  async createFile(rel: string, content: string): Promise<void> {
    if (this.exists(rel)) throw new HttpError(409, '같은 이름의 파일이 이미 있습니다');
    await this.writeRaw(rel, content);
  }

  async createMap(dirRel: string, name: string, content: string): Promise<string> {
    const clean = name.trim();
    if (!clean) throw new HttpError(400, '이름을 입력하세요');
    const rel = [dirRel, clean + MAP_EXT].filter(Boolean).join('/');
    const abs = this.resolve(rel);
    if (existsSync(abs)) throw new HttpError(409, '같은 이름의 맵이 이미 있습니다');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await atomicWrite(abs, content);
    return rel;
  }

  async createFolder(rel: string): Promise<void> {
    const abs = this.resolve(rel);
    if (existsSync(abs)) throw new HttpError(409, '같은 이름의 폴더가 이미 있습니다');
    await fs.mkdir(abs, { recursive: true });
  }

  /** 이름 변경/이동. 맵이면 딸린 폴더도 함께 옮긴다. */
  async rename(fromRel: string, toRel: string): Promise<void> {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    if (!existsSync(from)) throw new HttpError(404, '대상이 없습니다');
    if (existsSync(to)) throw new HttpError(409, '같은 이름이 이미 있습니다');
    if (to.startsWith(from + path.sep)) throw new HttpError(400, '폴더를 자기 안으로 옮길 수 없습니다');
    await fs.mkdir(path.dirname(to), { recursive: true });
    await renameWithRetry(from, to);
    if (from.endsWith(MAP_EXT) && to.endsWith(MAP_EXT)) {
      const fromDir = from.slice(0, -MAP_EXT.length);
      const toDir = to.slice(0, -MAP_EXT.length);
      if (existsSync(fromDir) && !existsSync(toDir)) {
        try {
          await renameWithRetry(fromDir, toDir);
        } catch (e) {
          // 딸린 폴더만 못 옮기면 맵 파일과 폴더가 어긋나므로 맵 파일도 원래대로 되돌린다
          await renameWithRetry(to, from).catch(() => {});
          throw e;
        }
      }
    }
  }

  /** 삭제 대신 .mindmap/trash 로 옮긴다 */
  async trash(rel: string): Promise<void> {
    const abs = this.resolve(rel);
    if (abs === this.root) throw new HttpError(400, 'Vault 자체는 삭제할 수 없습니다');
    if (!existsSync(abs)) throw new HttpError(404, '대상이 없습니다');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.internalDir, 'trash', stamp, this.toRel(abs));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await renameWithRetry(abs, dest);
    if (abs.endsWith(MAP_EXT)) {
      const dir = abs.slice(0, -MAP_EXT.length);
      if (existsSync(dir)) {
        try {
          await renameWithRetry(dir, dest.slice(0, -MAP_EXT.length));
        } catch (e) {
          await renameWithRetry(dest, abs).catch(() => {});
          throw e;
        }
      }
    }
  }

  /** 덮어쓰기 전 내용을 .mindmap/history 에 보관한다 (파일당 5분에 한 번, 최근 50개) */
  private async snapshot(rel: string, content: string) {
    const now = Date.now();
    if (now - (this.lastSnapshot.get(rel) ?? 0) < 5 * 60_000) return;
    this.lastSnapshot.set(rel, now);
    const dir = path.join(this.internalDir, 'history', ...rel.split('/'));
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, `${stamp}.md`), content, 'utf8');
    const files = (await fs.readdir(dir)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 50))) await fs.rm(path.join(dir, f), { force: true });
  }
}

async function atomicWrite(abs: string, content: string | Buffer) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, abs);
      return;
    } catch (e) {
      // Windows에서 다른 프로그램이 파일을 잠깐 잡고 있으면 EPERM/EBUSY가 날 수 있다
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }
}

/** Windows 에서 백신/동기화 프로그램이 파일을 잠깐 잡고 있으면 EPERM/EBUSY 가 날 수 있어 몇 번 재시도한다 */
async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}
