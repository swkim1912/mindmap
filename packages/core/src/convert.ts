/**
 * 다른 프로그램과 주고받기 위한 변환 (내보내기/가져오기).
 * 원본 형식(.mm.md)은 이미 평문 Markdown이므로 그대로 내보내고, 여기서는 나머지 형식을 다룬다.
 * 압축(.xmind 는 zip)과 파일 입출력은 바깥(웹/서버)에서 한다.
 */
import { newId, randomId } from './id';
import { parseMap } from './parse';
import type { LayoutKind, MapDoc, MapNode } from './model';
import { getTags } from './model';
import type { Card } from './cards';

// ---------- XML 보조 ----------
const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '&#10;');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

function attrsOf(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unesc(m[2] ?? m[3] ?? '');
  return out;
}

const firstLine = (t: string) => (t.split('\n')[0] ?? '').trim();

function newDoc(title: string, layout: LayoutKind = 'mindmap'): MapDoc {
  return {
    meta: { id: `map_${randomId(6)}`, title, layout },
    rawFrontmatter: null,
    root: { id: 'root', text: title, attrs: {}, note: null, children: [] },
    extra: [],
  };
}

function node(text: string, taken: Set<string>, note: string | null = null, tags: string[] = []): MapNode {
  return { id: newId(taken), text: text.replace(/\r\n?/g, '\n').trim(), attrs: tags.length ? { tags: tags.join(',') } : {}, note, children: [] };
}

// ---------- OPML ----------
export function toOpml(doc: MapDoc): string {
  const title = String(doc.meta.title ?? firstLine(doc.root.text));
  const walk = (n: MapNode, pad: string): string => {
    const a = [`text="${esc(n.text)}"`];
    if (n.note) a.push(`_note="${esc(n.note)}"`);
    const tags = getTags(n);
    if (tags.length) a.push(`category="${esc(tags.join(','))}"`);
    if (!n.children.length) return `${pad}<outline ${a.join(' ')}/>\n`;
    return `${pad}<outline ${a.join(' ')}>\n${n.children.map((c) => walk(c, pad + '  ')).join('')}${pad}</outline>\n`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${esc(title)}</title></head>\n  <body>\n${walk(doc.root, '    ')}  </body>\n</opml>\n`;
}

export function fromOpml(xml: string): MapDoc {
  const taken = new Set<string>();
  const title = unesc(/<title>([\s\S]*?)<\/title>/i.exec(xml)?.[1]?.trim() ?? '') || '가져온 맵';
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(xml)?.[1] ?? xml;
  const top: MapNode[] = [];
  const stack: MapNode[] = [];
  for (const m of body.matchAll(/<(\/?)outline\b([^>]*?)(\/?)>/gi)) {
    if (m[1]) {
      stack.pop();
      continue;
    }
    const a = attrsOf(m[2]);
    const n = node(a.text ?? a.title ?? '', taken, a._note ?? a.note ?? null, (a.category ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    (stack.length ? stack[stack.length - 1].children : top).push(n);
    if (!m[3]) stack.push(n);
  }
  if (!top.length) throw new Error('OPML 에서 항목(outline)을 찾지 못했습니다');
  const doc = newDoc(title);
  if (top.length === 1) {
    doc.root = { ...top[0], id: 'root' };
    taken.add('root');
    doc.meta.title = firstLine(top[0].text) || title;
  } else {
    doc.root.children = top;
  }
  return doc;
}

// ---------- FreeMind (.mm) 내보내기 ----------
export function toFreeMind(doc: MapDoc): string {
  const walk = (n: MapNode, pad: string, side?: 'left' | 'right', depth = 0): string => {
    const a = [`ID="${esc(n.id)}"`, `TEXT="${esc(n.text)}"`];
    if (side) a.push(`POSITION="${side}"`);
    const inner: string[] = [];
    if (n.note) {
      const paras = n.note.split('\n').map((l) => `<p>${esc(l).replace(/&#10;/g, '')}</p>`).join('');
      inner.push(`${pad}  <richcontent TYPE="NOTE"><html><head></head><body>${paras}</body></html></richcontent>\n`);
    }
    n.children.forEach((c, i) => inner.push(walk(c, pad + '  ', depth === 0 ? (i % 2 === 0 ? 'right' : 'left') : undefined, depth + 1)));
    return inner.length ? `${pad}<node ${a.join(' ')}>\n${inner.join('')}${pad}</node>\n` : `${pad}<node ${a.join(' ')}/>\n`;
  };
  return `<map version="1.0.1">\n${walk(doc.root, '  ')}</map>\n`;
}

// ---------- XMind (.xmind = zip) ----------
interface XTopic {
  id?: string;
  title?: string;
  notes?: { plain?: { content?: string } };
  labels?: string[];
  children?: { attached?: XTopic[] };
}

/** zip 안에 넣을 파일들. 웹에서 압축해 .xmind 로 저장한다 (XMind 8 이후의 JSON 형식) */
export function toXMindFiles(doc: MapDoc): Record<string, string> {
  const topic = (n: MapNode, root = false): XTopic & { class: string; structureClass?: string } => {
    const t: XTopic & { class: string; structureClass?: string } = { id: n.id, class: 'topic', title: n.text };
    if (root) t.structureClass = doc.meta.layout === 'logic-right' ? 'org.xmind.ui.logic.right' : 'org.xmind.ui.map.clockwise';
    if (n.note) t.notes = { plain: { content: n.note } };
    const tags = getTags(n);
    if (tags.length) t.labels = tags;
    if (n.children.length) t.children = { attached: n.children.map((c) => topic(c)) };
    return t;
  };
  const title = String(doc.meta.title ?? firstLine(doc.root.text));
  return {
    'content.json': JSON.stringify([{ id: `sheet_${randomId(6)}`, class: 'sheet', title, rootTopic: topic(doc.root, true) }]),
    'metadata.json': JSON.stringify({ creator: { name: 'mindmap' } }),
    'manifest.json': JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }),
  };
}

/** content.json 의 모든 시트를 맵으로 바꾼다 */
export function fromXMindContent(json: string): MapDoc[] {
  let sheets: unknown;
  try {
    sheets = JSON.parse(json);
  } catch {
    throw new Error('XMind content.json 을 읽을 수 없습니다');
  }
  if (!Array.isArray(sheets)) throw new Error('지원하지 않는 XMind 형식입니다');
  const docs: MapDoc[] = [];
  for (const s of sheets as { title?: string; rootTopic?: XTopic }[]) {
    if (!s?.rootTopic) continue;
    const taken = new Set<string>(['root']);
    const conv = (t: XTopic): MapNode => {
      const n = node(t.title ?? '', taken, t.notes?.plain?.content?.trim() || null, (t.labels ?? []).filter((x) => typeof x === 'string'));
      for (const c of t.children?.attached ?? []) n.children.push(conv(c));
      return n;
    };
    const root = conv(s.rootTopic);
    root.id = 'root';
    const doc = newDoc(s.title?.trim() || firstLine(root.text) || '가져온 맵');
    doc.root = root;
    docs.push(doc);
  }
  if (!docs.length) throw new Error('XMind 파일에서 맵을 찾지 못했습니다');
  return docs;
}

// ---------- Markdown 목록/제목 가져오기 ----------
/**
 * 일반 Markdown(제목 `#`과 들여쓰기 목록)을 맵으로 바꾼다.
 * 제목은 단계가 되고, 목록은 그 아래 가지가 된다. 목록 밖 문단은 가까운 노드의 메모로 둔다.
 */
export function fromMarkdownOutline(text: string, titleHint = '가져온 맵'): MapDoc {
  const lines = text.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const taken = new Set<string>(['root']);
  const LIST = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
  const HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const units = lines.map((l) => LIST.exec(l)?.[1]).filter((x): x is string => x !== undefined && x.length > 0).map((x) => x.replace(/\t/g, '    ').length);
  const unit = units.length ? Math.max(1, Math.min(...units)) : 2;

  const doc = newDoc(titleHint);
  const root = doc.root;
  // stack[i] = 깊이 i 의 노드 (0 = 루트)
  const stack: MapNode[] = [root];
  let headingBase = 0;
  let rootFromHeading = false;
  let lastNode: MapNode = root;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      const t = para.join('\n').trim();
      if (t) lastNode.note = lastNode.note ? `${lastNode.note}\n\n${t}` : t;
      para.length = 0;
    }
  };
  const attach = (depth: number, n: MapNode) => {
    const d = Math.max(1, Math.min(depth, stack.length));
    stack.length = d;
    stack[d - 1].children.push(n);
    stack[d] = n;
    lastNode = n;
  };

  for (const line of lines) {
    const h = HEAD.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      if (!rootFromHeading && root.children.length === 0 && level === 1 && stack.length === 1) {
        root.text = h[2].trim() || titleHint;
        doc.meta.title = root.text;
        rootFromHeading = true;
        headingBase = 0;
        lastNode = root;
        continue;
      }
      const depth = rootFromHeading ? level - 1 : level;
      attach(depth, node(h[2], taken));
      headingBase = Math.min(depth, stack.length - 1);
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      flushPara();
      const indent = li[1].replace(/\t/g, '    ').length;
      attach(headingBase + 1 + Math.floor(indent / unit), node(li[2], taken));
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    // 목록 항목 아래로 이어지는 들여쓴 줄은 그 항목의 본문 줄로 본다
    if (/^\s+\S/.test(line) && lastNode !== root) {
      flushPara();
      lastNode.text += `\n${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  if (!root.children.length && !root.note) throw new Error('가져올 목록이나 제목을 찾지 못했습니다');
  return doc;
}

// ---------- Anki CSV (카드) ----------
const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
const html = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/==([^=\n]+)==/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');

/** Anki "텍스트 가져오기"용 파일. 탭 구분, 앞면/뒷면/태그, HTML 허용 */
export function toAnkiCsv(cards: Card[]): string {
  const head = ['#separator:tab', '#html:true', '#tags column:3'].join('\n');
  const rows = cards.map((c) => {
    const ctx = c.trail.length ? `<small>${html(c.trail.join(' › '))}</small><br>` : '';
    const tags = c.tags.map((t) => t.replace(/\s+/g, '_')).join(' ');
    return [cell(ctx + html(c.front)), cell(html(c.back)), cell(tags)].join('\t');
  });
  return `${head}\n${rows.join('\n')}\n`;
}

// ---------- Markdown 자동 판별 가져오기 ----------
/**
 * 이 앱의 맵 형식(.mm.md)으로 쓴 글인가? AI 가 만든 마크다운은 확장자가 .md 여도 맵 형식인 경우가 많다.
 * 루트의 `^root`, 포스트잇(`> 📌`), 노드 끝의 `^id`·`{속성}` 중 하나라도 있으면 맵 형식으로 본다.
 */
export function looksLikeMapFormat(text: string): boolean {
  const t = text.replace(/^\uFEFF/, '');
  if (/^\s*#\s.*\s\^[A-Za-z0-9_-]+\s*$/m.test(t)) return true;
  if (/^\s*>\s*📌/m.test(t)) return true;
  if (/^\s*(?:[-*+]|\d+[.)])\s.*(?:\s\^[A-Za-z0-9_-]{2,}|\{[^{}]*\})\s*$/m.test(t)) return true;
  return /^---\r?\n[\s\S]{0,400}?\b(?:layout|id):/.test(t);
}

export interface ImportedMarkdown {
  doc: MapDoc;
  /** 'map' = 이 앱의 맵 형식으로 읽음, 'outline' = 일반 제목·목록으로 읽음 */
  mode: 'map' | 'outline';
  /** 맵 형식으로 읽다가 해석하지 못한 줄 수 */
  warnings: number;
}

/** 마크다운 글을 새 맵으로 바꾼다 (맵 형식이면 태그·메모·카드 문법까지 그대로, 아니면 제목·목록 구조만) */
export function importMarkdown(text: string, titleHint = '가져온 맵', forceMap = false): ImportedMarkdown {
  if (forceMap || looksLikeMapFormat(text)) {
    const { doc, warnings } = parseMap(text);
    const title = String(doc.meta.title ?? '').trim() || firstLine(doc.root.text) || titleHint;
    // 새 맵으로 만들므로 맵 ID 는 새로 정한다 (노드 ID 는 유지)
    doc.meta = { ...doc.meta, id: `map_${randomId(6)}`, title };
    return { doc, mode: 'map', warnings: warnings.length };
  }
  return { doc: fromMarkdownOutline(text, titleHint), mode: 'outline', warnings: 0 };
}
