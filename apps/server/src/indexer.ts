import fs from 'node:fs/promises';
import path from 'node:path';
import {
  FileLookup,
  WIKILINK_RE,
  baseName,
  displayName,
  extractLinks,
  getTags,
  isMapPath,
  linkNodeId,
  parseMap,
  parseWikiLink,
  type MapNode,
  type WikiLink,
} from '@mindmap/core';
import { isHiddenRel, type Vault } from './vault';

export interface NodeRec {
  id: string;
  text: string;
  note: string | null;
  tags: string[];
  /** 루트부터 부모까지의 노드 텍스트 */
  trail: string[];
}

export interface LinkRec extends WikiLink {
  fromNode: string | null;
}

export interface FileRec {
  path: string;
  kind: 'map' | 'page';
  title: string;
  nodes: NodeRec[];
  /** 페이지 본문 (맵은 빈 문자열) */
  body: string;
  links: LinkRec[];
}

export interface SearchHit {
  kind: 'map' | 'page' | 'node';
  path: string;
  nodeId: string | null;
  title: string;
  /** 노드: 상위 경로, 파일: 폴더 */
  context: string;
  snippet: string;
}

export interface BacklinkSource {
  kind: 'map' | 'page';
  path: string;
  title: string;
  nodeId: string | null;
  nodeText: string | null;
}

/** 노드 텍스트의 첫 줄. `[[링크]]` 는 표시명으로 바꿔 사람이 읽기 좋게 만든다 */
export function plainTitle(text: string): string {
  return (text.split('\n')[0] ?? '')
    .replace(WIKILINK_RE, (_w, inner: string) => {
      const l = parseWikiLink(inner);
      return l.label ?? baseName(l.target).replace(/\.mm$/, '');
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Vault 루트의 AGENTS.md 는 앱 설명서이므로 색인하지 않는다 */
const isIndexable = (rel: string) => rel.endsWith('.md') && !isHiddenRel(rel) && rel !== 'AGENTS.md';

function walkNodes(root: MapNode): { nodes: NodeRec[]; links: LinkRec[] } {
  const nodes: NodeRec[] = [];
  const links: LinkRec[] = [];
  const walk = (n: MapNode, trail: string[]) => {
    nodes.push({ id: n.id, text: n.text, note: n.note, tags: getTags(n), trail });
    for (const l of extractLinks(n.text)) links.push({ ...l, fromNode: n.id });
    if (n.note) for (const l of extractLinks(n.note)) links.push({ ...l, fromNode: n.id });
    for (const c of n.children) walk(c, [...trail, plainTitle(n.text)]);
  };
  walk(root, []);
  return { nodes, links };
}

function stripFrontmatter(src: string): { title: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { title: null, body: src };
  const t = /^title:\s*(.+)$/m.exec(m[1]);
  return { title: t ? t[1].trim().replace(/^["']|["']$/g, '') : null, body: src.slice(m[0].length) };
}

export class Indexer {
  private files = new Map<string, FileRec>();
  private lookupCache: FileLookup | null = null;
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
        else if (e.isFile() && isIndexable(this.vault.toRel(p))) await this.update(this.vault.toRel(p));
      }
    };
    await walk(this.vault.root);
  }

  /** 색인을 비우고 처음부터 다시 만든다 (감시 없이 파일을 옮긴 뒤에 쓴다) */
  async rebuild(): Promise<void> {
    this.files.clear();
    this.lookupCache = null;
    await this.scan();
  }

  /** 파일이 바뀌었거나(또는 지워졌으면) 색인을 갱신한다 */
  async update(rel: string): Promise<void> {
    if (!isIndexable(rel)) return;
    let src: string;
    try {
      src = await fs.readFile(this.vault.resolve(rel), 'utf8');
    } catch {
      if (this.files.delete(rel)) this.lookupCache = null;
      return;
    }
    const isNew = !this.files.has(rel);
    if (isMapPath(rel)) {
      const { doc } = parseMap(src);
      const { nodes, links } = walkNodes(doc.root);
      const title = typeof doc.meta.title === 'string' && doc.meta.title ? doc.meta.title : displayName(rel);
      this.files.set(rel, { path: rel, kind: 'map', title, nodes, body: '', links });
    } else {
      const { title, body } = stripFrontmatter(src);
      const links = extractLinks(body).map((l) => ({ ...l, fromNode: null }));
      this.files.set(rel, { path: rel, kind: 'page', title: title ?? displayName(rel), nodes: [], body, links });
    }
    if (isNew) this.lookupCache = null;
  }

  /** 색인과 무관하게 디스크를 직접 훑어 .md 목록을 만든다 (이동 직전처럼 정확해야 할 때) */
  async freshPaths(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (abs: string) => {
      for (const e of await fs.readdir(abs, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(abs, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && isIndexable(this.vault.toRel(p))) out.push(this.vault.toRel(p));
      }
    };
    await walk(this.vault.root);
    return out.sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  }

  paths(): string[] {
    return [...this.files.keys()].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  }

  lookup(): FileLookup {
    return (this.lookupCache ??= new FileLookup(this.paths()));
  }

  get(rel: string): FileRec | undefined {
    return this.files.get(rel);
  }

  all(): FileRec[] {
    return [...this.files.values()];
  }

  search(query: string, limit = 50): SearchHit[] {
    const raw = query.trim();
    const hits: (SearchHit & { score: number })[] = [];
    const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
    const tagTokens = tokens.filter((t) => t.startsWith('#') && t.length > 1).map((t) => t.slice(1));
    const textTokens = tokens.filter((t) => !(t.startsWith('#') && t.length > 1));
    const snippetOf = (text: string) => {
      const flat = text.replace(/[|#>*`]+|-{3,}/g, ' ').replace(/\s+/g, ' ');
      const i = textTokens.length ? flat.toLowerCase().indexOf(textTokens[0]) : 0;
      const start = Math.max(0, i - 30);
      return (start > 0 ? '…' : '') + flat.slice(start, start + 100);
    };
    const matches = (hay: string) => textTokens.every((t) => hay.includes(t));

    for (const f of this.files.values()) {
      const dir = path.posix.dirname(f.path);
      const folder = dir === '.' ? '' : dir;
      const titleHay = `${f.title} ${f.path}`.toLowerCase();
      if (!tagTokens.length && matches(titleHay)) {
        hits.push({
          kind: f.kind,
          path: f.path,
          nodeId: null,
          title: f.title,
          context: folder,
          snippet: '',
          score: textTokens.length ? 100 - Math.min(f.title.length, 50) : 0,
        });
      }
      if (f.kind === 'page') {
        if (!tagTokens.length && textTokens.length && matches(f.body.toLowerCase()) && !matches(titleHay)) {
          hits.push({ kind: 'page', path: f.path, nodeId: null, title: f.title, context: folder, snippet: snippetOf(f.body), score: 10 });
        }
        continue;
      }
      if (!textTokens.length && !tagTokens.length) continue;
      for (const n of f.nodes) {
        const hay = `${n.text}\n${n.note ?? ''}`.toLowerCase();
        if (!matches(hay)) continue;
        if (tagTokens.some((t) => !n.tags.some((x) => x.toLowerCase() === t))) continue;
        const inText = textTokens.every((t) => n.text.toLowerCase().includes(t));
        hits.push({
          kind: 'node',
          path: f.path,
          nodeId: n.id,
          title: plainTitle(n.text) || '(빈 주제)',
          context: [f.title, ...n.trail.slice(1)].join(' › '),
          snippet: inText ? '' : snippetOf(n.note ?? ''),
          score: inText ? 50 : 20,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'ko'));
    return hits.slice(0, limit).map(({ score: _s, ...h }) => h);
  }

  /** target 파일을 가리키는 링크들. nodes 는 대상 맵의 노드별 목록 */
  backlinks(target: string): { file: BacklinkSource[]; nodes: Record<string, BacklinkSource[]> } {
    const lookup = this.lookup();
    const file: BacklinkSource[] = [];
    const nodes: Record<string, BacklinkSource[]> = {};
    for (const f of this.files.values()) {
      for (const l of f.links) {
        const r = lookup.resolve(l, f.path);
        if (!r || r.path !== target) continue;
        // 자기 자신의 노드 링크는 제외 (같은 맵 안 연결은 역링크로 보지 않음)
        if (f.path === target) continue;
        const src: BacklinkSource = {
          kind: f.kind,
          path: f.path,
          title: f.title,
          nodeId: l.fromNode,
          nodeText: l.fromNode ? plainTitle(f.nodes.find((n) => n.id === l.fromNode)?.text ?? '') || null : null,
        };
        const nid = linkNodeId(l) ?? r.nodeId;
        const bucket = nid ? (nodes[nid] ??= []) : file;
        if (!bucket.some((s) => s.path === src.path && s.nodeId === src.nodeId)) bucket.push(src);
      }
    }
    return { file, nodes };
  }
}
