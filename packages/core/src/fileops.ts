/**
 * 폴더·맵의 이름 변경/이동/삭제(휴지통)에 쓰는 공용 로직.
 * PC(Node 파일)와 모바일(IndexedDB)이 같은 규칙으로 동작하도록 파일 접근은 바깥에서 주입한다.
 */
import { FileLookup, isMapPath, linkTargetFor, mapCompanionDir, replaceLinkTarget, rewriteLinks } from './links';

/** 휴지통 보관 일수 */
export const TRASH_DAYS = 30;
/** 비어 있는 폴더 목록 (동기화되는 특수 파일) */
export const FOLDERS_PATH = '.mindmap/folders.json';
/** 이동 때문에 생긴 "조용한" 휴지통 묶음의 접두어 (목록에 보이지 않고 기간이 지나면 정리됨) */
export const SILENT_PREFIX = 'x-';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

export type FileKind = 'map' | 'page' | 'image' | 'other';

export function fileKind(p: string): FileKind {
  if (isMapPath(p)) return 'map';
  if (p.endsWith('.md')) return 'page';
  if (IMAGE_EXT.test(p)) return 'image';
  return 'other';
}

export interface KindCounts {
  maps: number;
  pages: number;
  images: number;
  others: number;
}

export function countKinds(paths: Iterable<string>): KindCounts {
  const c: KindCounts = { maps: 0, pages: 0, images: 0, others: 0 };
  for (const p of paths) {
    const k = fileKind(p);
    c[k === 'map' ? 'maps' : k === 'page' ? 'pages' : k === 'image' ? 'images' : 'others']++;
  }
  return c;
}

// ---------- 이름 ----------
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 파일/폴더 이름으로 쓸 수 있는지 검사한다. 문제가 있으면 이유를, 괜찮으면 null 을 돌려준다. */
export function validateName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return '이름을 입력하세요';
  if (name.length > 80) return '이름은 80자 이하여야 합니다';
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return '이름에 \\ / : * ? " < > | 는 쓸 수 없습니다';
  if (name === '.' || name === '..' || name.startsWith('.')) return '이름은 점(.)으로 시작할 수 없습니다';
  if (name.endsWith('.')) return '이름은 점(.)으로 끝날 수 없습니다';
  if (RESERVED.test(name)) return `"${name}" 은(는) 윈도우에서 쓸 수 없는 이름입니다`;
  return null;
}

// ---------- 이동 계획 ----------
/** 이름 변경/이동 한 번에 대한 "옛 경로 → 새 경로" 대응. oldFiles 는 이동 전의 전체 파일 목록 */
export function buildMoveMap(oldFiles: string[], from: string, to: string): Map<string, string> {
  const m = new Map<string, string>();
  const dirs: [string, string][] = [];
  if (from.endsWith('.md')) {
    if (oldFiles.includes(from)) m.set(from, to);
    // 맵이면 딸린 폴더(pages/, assets/)도 같이 이동된다
    if (isMapPath(from) && isMapPath(to)) dirs.push([mapCompanionDir(from), mapCompanionDir(to)]);
  } else {
    dirs.push([from, to]);
  }
  for (const f of oldFiles) {
    for (const [a, b] of dirs) if (f.startsWith(a + '/')) m.set(f, b + f.slice(a.length));
  }
  return m;
}

/** 대상(맵 또는 폴더)이 건드리는 파일 전체 */
export function affectedFiles(allFiles: string[], target: string): string[] {
  const m = buildMoveMap(allFiles, target, isMapPath(target) ? 'x.mm.md' : 'x');
  return [...m.keys()];
}

export interface TextIO {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

/**
 * 파일 이동 후, 이동된 파일을 가리키던 `[[링크]]` 의 대상을 새 경로로 고쳐 쓴다.
 * oldFiles 는 이동 전의 전체 파일 목록, moved 는 buildMoveMap 결과.
 * 이동이 끝난 뒤(새 경로에 파일이 있는 상태)에 호출한다.
 */
export async function rewriteLinksAfterMove(io: TextIO, oldFiles: string[], moved: Map<string, string>): Promise<string[]> {
  if (!moved.size) return [];
  const mds = oldFiles.filter((f) => f.endsWith('.md'));
  const lookup = new FileLookup(mds);
  const changed: string[] = [];
  for (const oldPath of mds) {
    const newPath = moved.get(oldPath) ?? oldPath;
    const src = await io.read(newPath);
    if (src === null) continue;
    const out = rewriteLinks(src, (link) => {
      const r = lookup.resolve(link, oldPath);
      const dest = r && moved.get(r.path);
      if (!dest) return null;
      return replaceLinkTarget(link, linkTargetFor(dest));
    });
    if (out !== src) {
      await io.write(newPath, out);
      changed.push(newPath);
    }
  }
  return changed;
}

/** 복습 기록(JSON)의 맵 경로 키를 이동 결과에 맞춰 바꾼다. 바뀐 게 없으면 null */
export function moveStudyKeys(json: string, moved: Map<string, string>): string | null {
  let data: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    data = v as Record<string, unknown>;
  } catch {
    return null;
  }
  let changed = false;
  for (const [from, to] of moved) {
    if (from !== to && data[from]) {
      data[to] = { ...((data[to] as object) ?? {}), ...(data[from] as object) };
      delete data[from];
      changed = true;
    }
  }
  return changed ? JSON.stringify(data, null, 1) : null;
}

// ---------- 휴지통 ----------
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 삭제 묶음 ID. 시각을 담고 있어서 목록 정렬·기한 계산에 그대로 쓴다 (예: 2026-10-13T14-02-11-123Z) */
export function newTrashId(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}-${pad(now.getUTCMilliseconds(), 3)}Z`;
}

const ID_RE = /^(?:x-)?(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

export const isTrashId = (id: string) => ID_RE.test(id);
export const isSilentTrash = (id: string) => id.startsWith(SILENT_PREFIX);

export function trashTime(id: string): Date | null {
  const m = ID_RE.exec(id);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7])) : null;
}

export function trashDaysLeft(id: string, now: Date = new Date()): number {
  const t = trashTime(id);
  if (!t) return 0;
  return Math.max(0, Math.ceil(TRASH_DAYS - (now.getTime() - t.getTime()) / 86_400_000));
}

export const isTrashExpired = (id: string, now: Date = new Date()) => {
  const t = trashTime(id);
  return !t || now.getTime() - t.getTime() >= TRASH_DAYS * 86_400_000;
};

/** 이 시각 이전의 묶음은 만료다. (문자열 비교가 시간 순서와 같다) */
export const expiryCutoffId = (now: Date = new Date()) => newTrashId(new Date(now.getTime() - TRASH_DAYS * 86_400_000));

export interface TrashGroup {
  id: string;
  deletedAt: string;
  /** 삭제할 때 고른 원래 경로 (맵 파일, 폴더, 또는 파일) */
  path: string;
  kind: 'map' | 'folder' | 'file';
  maps: number;
  pages: number;
  images: number;
  others: number;
  daysLeft: number;
}

/** 묶음에 든 파일 경로들로부터 사용자가 삭제한 원래 대상을 추정한다 */
export function trashTarget(paths: string[]): { path: string; kind: TrashGroup['kind'] } {
  if (paths.length === 1) return { path: paths[0], kind: isMapPath(paths[0]) ? 'map' : 'file' };
  // 맵 하나와 그 딸린 폴더만 있으면 맵
  const maps = paths.filter(isMapPath);
  for (const m of maps) {
    const dir = mapCompanionDir(m) + '/';
    if (paths.every((p) => p === m || p.startsWith(dir))) return { path: m, kind: 'map' };
  }
  // 아니면 모든 경로의 공통 폴더
  const parts = paths.map((p) => p.split('/').slice(0, -1));
  let common = parts[0] ?? [];
  for (const p of parts) {
    let i = 0;
    while (i < common.length && i < p.length && common[i] === p[i]) i++;
    common = common.slice(0, i);
  }
  return { path: common.join('/'), kind: 'folder' };
}

export function summarizeTrash(id: string, paths: string[], now: Date = new Date()): TrashGroup {
  return {
    id,
    deletedAt: (trashTime(id) ?? new Date(0)).toISOString(),
    ...trashTarget(paths),
    ...countKinds(paths),
    daysLeft: trashDaysLeft(id, now),
  };
}

/**
 * 휴지통에서 복원할 때 파일별 새 경로를 정한다.
 * 원래 자리에 같은 이름이 있으면 "이름 (복원)" 으로 비켜 놓는다.
 */
export function restoreMapping(paths: string[], exists: (p: string) => boolean): { moved: Map<string, string>; renamed: boolean } {
  const { path: target } = trashTarget(paths);
  const clash = (t: string) => paths.some((p) => exists(t === target ? p : buildMoveMap(paths, target, t).get(p) ?? p));
  if (!clash(target)) return { moved: new Map(paths.map((p) => [p, p])), renamed: false };
  const isMap = isMapPath(target);
  const base = isMap ? target.slice(0, -'.mm.md'.length) : target;
  for (let n = 1; n < 100; n++) {
    const cand = `${base} (복원${n > 1 ? ` ${n}` : ''})${isMap ? '.mm.md' : ''}`;
    if (!clash(cand)) {
      const m = buildMoveMap(paths, target, cand);
      return { moved: new Map(paths.map((p) => [p, m.get(p) ?? p])), renamed: true };
    }
  }
  throw new Error('같은 이름이 너무 많아 복원할 수 없습니다');
}

// ---------- 빈 폴더 목록 ----------
export function parseFolders(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))].sort() : [];
  } catch {
    return [];
  }
}

export const stringifyFolders = (list: Iterable<string>) => JSON.stringify([...new Set(list)].sort());

/** 양쪽에서 동시에 바뀌었을 때: 합집합 */
export function mergeFolders(a: string, b: string): string {
  return stringifyFolders([...parseFolders(a), ...parseFolders(b)]);
}
