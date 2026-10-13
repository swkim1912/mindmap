/**
 * `[[링크]]` 문법과 해석.
 *   [[대상]]  [[대상|표시명]]  [[대상#^노드ID]]  [[대상#^노드ID|표시명]]
 * 대상은 확장자 없는 파일 경로다. 맵은 `이름.mm`, 페이지는 `이름`.
 * 경로는 Vault 기준(권장)이거나 일부만 써도 된다(끝부분이 일치하는 파일을 찾는다).
 */

export interface WikiLink {
  /** `[[` `]]` 안쪽 원문 */
  raw: string;
  target: string;
  /** `#` 뒤 문자열. 노드 링크면 `^id` */
  anchor: string | null;
  label: string | null;
}

export const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

export function parseWikiLink(inner: string): WikiLink {
  const bar = inner.indexOf('|');
  const label = bar >= 0 ? inner.slice(bar + 1).trim() || null : null;
  let target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  let anchor: string | null = null;
  const hash = target.indexOf('#');
  if (hash >= 0) {
    anchor = target.slice(hash + 1) || null;
    target = target.slice(0, hash).trim();
  }
  return { raw: inner, target, anchor, label };
}

export function linkNodeId(link: { anchor: string | null }): string | null {
  return link.anchor?.startsWith('^') ? link.anchor.slice(1) || null : null;
}

export function extractLinks(text: string): WikiLink[] {
  return [...text.matchAll(WIKILINK_RE)].map((m) => parseWikiLink(m[1]));
}

export function formatWikiLink(o: { target: string; nodeId?: string | null; label?: string | null }): string {
  return `[[${o.target}${o.nodeId ? `#^${o.nodeId}` : ''}${o.label ? `|${o.label}` : ''}]]`;
}

/** 노드 텍스트의 첫 줄. `[[링크]]` 는 표시명으로 바꿔 사람이 읽기 좋게 만든다 */
export function plainLine(text: string): string {
  return (text.split('\n')[0] ?? '')
    .replace(WIKILINK_RE, (_w, inner: string) => {
      const l = parseWikiLink(inner);
      return l.label ?? baseName(l.target).replace(/\.mm$/, '');
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** 링크 안의 대상 부분만 바꿔 쓴 새 `[[...]]` 문자열 */
export function replaceLinkTarget(link: WikiLink, newTarget: string): string {
  return formatWikiLink({ target: newTarget, nodeId: linkNodeId(link), label: link.label });
}

// ---------- 경로 도우미 (항상 '/' 구분) ----------

export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

export const MAP_SUFFIX = '.mm.md';

export function isMapPath(p: string): boolean {
  return p.endsWith(MAP_SUFFIX);
}

/** 파일 경로 → 링크에 쓰는 대상 문자열 (`a/b.mm.md` → `a/b.mm`, `a/p.md` → `a/p`) */
export function linkTargetFor(path: string): string {
  return path.endsWith('.md') ? path.slice(0, -3) : path;
}

/** 파일 경로 → 사람이 읽는 이름 */
export function displayName(path: string): string {
  const b = baseName(path);
  return b.endsWith(MAP_SUFFIX) ? b.slice(0, -MAP_SUFFIX.length) : b.replace(/\.md$/, '');
}

/** 맵에 딸린 폴더 (`a/b.mm.md` → `a/b`) */
export function mapCompanionDir(mapPath: string): string {
  return mapPath.slice(0, -MAP_SUFFIX.length);
}

/**
 * 파일에 딸린 첨부 폴더. 페이지/맵 모두 같은 맵 폴더의 assets/ 를 쓴다.
 *   x/y.mm.md → x/y/assets,  x/y/pages/p.md → x/y/assets,  기타 → 같은 폴더의 assets
 */
export function assetsDirFor(filePath: string): string {
  if (isMapPath(filePath)) return joinPath(mapCompanionDir(filePath), 'assets');
  const dir = dirOf(filePath);
  if (baseName(dir) === 'pages') return joinPath(dirOf(dir), 'assets');
  return joinPath(dir, 'assets');
}

/** base 파일(또는 폴더)에서 target 으로 가는 상대 경로 */
export function relativePath(fromDir: string, target: string): string {
  const a = normalizePath(fromDir).split('/').filter(Boolean);
  const b = normalizePath(target).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

// ---------- 해석 ----------

export interface Resolved {
  path: string;
  nodeId: string | null;
}

function variants(t: string): string[] {
  return [t, `${t}.md`, `${t}.mm.md`];
}

function commonPrefixLen(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

export class FileLookup {
  private exact = new Set<string>();
  private lower = new Map<string, string>();

  constructor(readonly files: string[]) {
    for (const f of files) {
      this.exact.add(f);
      this.lower.set(f.toLowerCase(), f);
    }
  }

  has(path: string): boolean {
    return this.exact.has(path);
  }

  resolve(link: { target: string; anchor: string | null }, fromPath: string): Resolved | null {
    const nodeId = linkNodeId(link);
    const t = normalizePath(link.target);
    if (!t) return { path: fromPath, nodeId };

    const direct = (base: string): string | null => {
      for (const v of variants(joinPath(base, t))) {
        if (this.exact.has(v)) return v;
        const l = this.lower.get(v.toLowerCase());
        if (l) return l;
      }
      return null;
    };
    const hit = direct('') ?? (/^\.\.?\//.test(link.target.trim()) ? direct(dirOf(fromPath)) : null);
    if (hit) return { path: hit, nodeId };

    // 끝부분이 일치하는 파일 (이름만 써도 동작). 여럿이면 현재 파일과 가까운 것.
    const suffixes = variants(t).map((v) => `/${v.toLowerCase()}`);
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const f of this.files) {
      const lf = `/${f.toLowerCase()}`;
      if (!suffixes.some((s) => lf.endsWith(s))) continue;
      const score = commonPrefixLen(dirOf(f), dirOf(fromPath)) * 1000 - f.length;
      if (score > bestScore) {
        best = f;
        bestScore = score;
      }
    }
    return best ? { path: best, nodeId } : null;
  }
}

export function resolveLink(
  link: { target: string; anchor: string | null },
  fromPath: string,
  files: string[] | FileLookup,
): Resolved | null {
  return (files instanceof FileLookup ? files : new FileLookup(files)).resolve(link, fromPath);
}

/**
 * 텍스트 안의 모든 `[[...]]` 를 fn 결과로 바꾼다. fn이 null/undefined를 주면 그대로 둔다.
 */
export function rewriteLinks(text: string, fn: (link: WikiLink) => string | null | undefined): string {
  return text.replace(WIKILINK_RE, (whole, inner: string) => fn(parseWikiLink(inner)) ?? whole);
}
