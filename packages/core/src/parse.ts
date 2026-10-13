import { parse as parseYaml } from 'yaml';
import type { Attrs, MapDoc, MapNode, ParseResult, ParseWarning } from './model';
import { ID_RE, newId } from './id';

const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])(?:[ \t]+(.*))?$/;
const HEADING_RE = /^#[ \t]+(.*)$/;
const ID_TAIL_RE = /(?:^|[ \t])\^([A-Za-z0-9_-]+)$/;
const ATTR_TAIL_RE = /(?:^|[ \t])\{([^{}]*)\}$/;
const ATTR_TOKEN_RE = /([A-Za-z][\w-]*)(?:=("(?:[^"\\]|\\.)*"|[^\s"]+))?/y;

/** 이 패턴으로 시작하는 여러 줄 텍스트의 연속 줄은 `\`로 이스케이프한다 */
const SPECIAL_LINE_RE = /^(?:>|[-*+](?:[ \t]|$)|\d+[.)](?:[ \t]|$)|\\)/;

export function isSpecialLine(s: string): boolean {
  return SPECIAL_LINE_RE.test(s);
}

function indentWidth(ws: string): number {
  let w = 0;
  for (const ch of ws) w = ch === '\t' ? w + 4 - (w % 4) : w + 1;
  return w;
}

export function parseAttrs(src: string): Attrs | null {
  const attrs: Attrs = {};
  let pos = 0;
  let count = 0;
  const s = src.trim();
  while (pos < s.length) {
    while (s[pos] === ' ' || s[pos] === '\t') pos++;
    if (pos >= s.length) break;
    ATTR_TOKEN_RE.lastIndex = pos;
    const m = ATTR_TOKEN_RE.exec(s);
    if (!m) return null;
    pos = ATTR_TOKEN_RE.lastIndex;
    if (pos < s.length && s[pos] !== ' ' && s[pos] !== '\t') return null;
    const raw = m[2];
    if (raw === undefined) attrs[m[1]] = true;
    else if (raw.startsWith('"')) attrs[m[1]] = JSON.parse(raw) as string;
    else attrs[m[1]] = raw;
    count++;
  }
  return count > 0 ? attrs : null;
}

interface ItemParts {
  text: string;
  attrs: Attrs;
  id: string | null;
}

/** `본문 {속성} ^id` 형태의 한 줄을 분해한다 */
export function parseItemLine(content: string): ItemParts {
  let s = content.trimEnd();
  let id: string | null = null;
  let attrs: Attrs = {};
  const idm = ID_TAIL_RE.exec(s);
  if (idm) {
    id = idm[1];
    s = s.slice(0, idm.index).trimEnd();
  }
  const am = ATTR_TAIL_RE.exec(s);
  if (am) {
    const parsed = parseAttrs(am[1]);
    if (parsed) {
      attrs = parsed;
      s = s.slice(0, am.index).trimEnd();
    }
  }
  return { text: s.trim(), attrs, id };
}

interface Building {
  node: MapNode;
  rawId: string | null;
  line: number;
  noteLines: string[] | null;
}

function makeNode(parts: ItemParts, line: number, all: Building[]): Building {
  const b: Building = {
    node: { id: '', text: parts.text, attrs: parts.attrs, note: null, children: [] },
    rawId: parts.id,
    line,
    noteLines: null,
  };
  all.push(b);
  return b;
}

function addNoteLine(b: Building, trimmed: string) {
  let content = trimmed.slice(1);
  if (content.startsWith(' ')) content = content.slice(1);
  if (b.noteLines === null) {
    b.noteLines = [];
    content = content.replace(/^📌[ \t]?/u, '');
  }
  b.noteLines.push(content);
}

function addTextLine(b: Building, trimmed: string) {
  const line = trimmed.startsWith('\\') && isSpecialLine(trimmed.slice(1)) ? trimmed.slice(1) : trimmed;
  b.node.text = b.node.text ? `${b.node.text}\n${line}` : line;
}

function splitFrontmatter(lines: string[], warnings: ParseWarning[]) {
  let meta: Record<string, unknown> = {};
  let rawFrontmatter: string | null = null;
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
    if (end > 0) {
      const raw = lines.slice(1, end).join('\n');
      start = end + 1;
      try {
        const parsed = parseYaml(raw);
        if (parsed == null) meta = {};
        else if (typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
        else throw new Error('frontmatter가 key: value 형식이 아닙니다');
      } catch (e) {
        rawFrontmatter = raw;
        warnings.push({ line: 1, message: `frontmatter 해석 실패: ${(e as Error).message}` });
      }
    } else {
      warnings.push({ line: 1, message: 'frontmatter 닫는 --- 가 없습니다' });
    }
  }
  return { meta, rawFrontmatter, start };
}

/**
 * 맵 파일(.mm.md)을 파싱한다. 해석할 수 없는 줄은 버리지 않고 doc.extra에 보존한다.
 * ID가 없거나 중복된 노드에는 새 ID를 부여하고 normalized=true로 표시한다.
 */
export function parseMap(source: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const { meta, rawFrontmatter, start } = splitFrontmatter(lines, warnings);

  const all: Building[] = [];
  const extra: string[] = [];
  let root: Building | null = null;
  let normalized = false;
  const stack: { indent: number; b: Building }[] = [];

  const ensureRoot = (lineNo: number): Building => {
    if (!root) {
      root = makeNode({ text: typeof meta.title === 'string' ? meta.title : '', attrs: {}, id: null }, lineNo, all);
      warnings.push({ line: lineNo, message: '중심 주제(# 제목)가 없어 자동으로 만들었습니다' });
      normalized = true;
    }
    return root;
  };

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw.trim() === '') continue;

    const lm = LIST_RE.exec(raw);
    if (lm) {
      const indent = indentWidth(lm[1]);
      const r = ensureRoot(lineNo);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].b : r;
      const b = makeNode(parseItemLine(lm[2] ?? ''), lineNo, all);
      parent.node.children.push(b.node);
      stack.push({ indent, b });
      continue;
    }

    const hm = HEADING_RE.exec(raw);
    if (hm && !root) {
      root = makeNode(parseItemLine(hm[1]), lineNo, all);
      continue;
    }

    const indent = indentWidth(/^[ \t]*/.exec(raw)![0]);
    const trimmed = raw.trim();
    let target: Building | null = null;
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s].indent < indent) {
        target = stack[s].b;
        break;
      }
    }
    if (target) {
      if (trimmed.startsWith('>')) addNoteLine(target, trimmed);
      else addTextLine(target, trimmed);
      continue;
    }
    if (root && trimmed.startsWith('>')) {
      addNoteLine(root, trimmed);
      continue;
    }
    extra.push(raw);
    warnings.push({ line: lineNo, message: '맵 구조로 해석되지 않는 줄입니다 (보존됨)' });
  }

  const r: Building = root ?? ensureRoot(start + 1);

  // ID 부여 및 중복 해소
  const taken = new Set<string>();
  for (const b of all) if (b.rawId && ID_RE.test(b.rawId)) taken.add(b.rawId);
  const seen = new Set<string>();
  for (const b of all) {
    if (b.noteLines) b.node.note = b.noteLines.join('\n');
    const want = b.rawId ?? (b === r ? 'root' : null);
    if (want && !seen.has(want)) {
      b.node.id = want;
      seen.add(want);
      taken.add(want);
      if (!b.rawId) normalized = true;
    } else {
      if (want) warnings.push({ line: b.line, message: `중복된 ID ^${want} → 새 ID로 바꿉니다` });
      b.node.id = newId(taken);
      seen.add(b.node.id);
      normalized = true;
    }
  }

  const doc: MapDoc = { meta, rawFrontmatter, root: r.node, extra };
  return { doc, warnings, normalized };
}

/**
 * 붙여넣기용: 들여쓰기 목록 텍스트를 노드 배열로 파싱한다.
 * 목록 형식이 아니면 각 줄을 노드 하나로 본다. ID는 모두 새로 부여한다.
 */
export function parseFragment(text: string, taken: Set<string>): MapNode[] {
  const body = text.replace(/\r\n?/g, '\n');
  const hasList = body.split('\n').some((l) => LIST_RE.test(l));
  const src = hasList
    ? body
    : body
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => `- ${l.trim()}`)
        .join('\n');
  const { doc } = parseMap(`# _\n${src}`);
  const reassign = (n: MapNode) => {
    n.id = newId(taken);
    n.children.forEach(reassign);
  };
  doc.root.children.forEach(reassign);
  return doc.root.children;
}
