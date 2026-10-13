import {
  FileLookup,
  dirOf,
  displayName,
  extractLinks,
  isMapPath,
  linkNodeId,
  plainLine,
  type WikiLink,
} from './links';
import { getTags, type MapNode } from './model';
import { parseMap } from './parse';

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
export const plainTitle = plainLine;

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

/** 메모리 안의 맵·페이지 색인. 검색과 역링크를 맡는다 (서버와 모바일이 함께 씀) */
export class VaultIndex {
  private files = new Map<string, FileRec>();
  private lookupCache: FileLookup | null = null;

  clear() {
    this.files.clear();
    this.lookupCache = null;
  }

  /** 색인 대상인가: 숨김 폴더와 Vault 설명서(AGENTS.md)는 제외 */
  static isIndexable(rel: string): boolean {
    return rel.endsWith('.md') && !rel.split('/').some((s) => s.startsWith('.')) && rel !== 'AGENTS.md';
  }

  /** 파일 내용으로 색인을 갱신한다. src 가 null 이면 지워진 파일 */
  set(rel: string, src: string | null): void {
    if (!VaultIndex.isIndexable(rel)) return;
    if (src === null) {
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
      const folder = dirOf(f.path);
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
