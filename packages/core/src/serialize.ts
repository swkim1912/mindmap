import { stringify as stringifyYaml } from 'yaml';
import type { Attrs, MapDoc, MapNode } from './model';
import { isSpecialLine } from './parse';

const BARE_VALUE_RE = /^[^\s"{}]+$/;

export function serializeAttrs(attrs: Attrs): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === true) parts.push(k);
    else if (v === '' || !BARE_VALUE_RE.test(v)) parts.push(`${k}=${JSON.stringify(v)}`);
    else parts.push(`${k}=${v}`);
  }
  return parts.join(' ');
}

function itemLine(node: MapNode, firstLine: string): string {
  const a = serializeAttrs(node.attrs);
  return [firstLine, a && `{${a}}`, `^${node.id}`].filter(Boolean).join(' ');
}

function textLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

function noteLines(note: string, indent: string): string[] {
  return note.split('\n').map((l, i) => {
    const content = i === 0 ? `📌 ${l}`.trimEnd() : l;
    return content ? `${indent}> ${content}` : `${indent}>`;
  });
}

function writeNode(node: MapNode, depth: number, out: string[]) {
  const indent = '  '.repeat(depth);
  const contIndent = indent + '  ';
  const [first = '', ...rest] = textLines(node.text);
  out.push(`${indent}- ${itemLine(node, first)}`);
  for (const l of rest) out.push(contIndent + (isSpecialLine(l) ? `\\${l}` : l));
  if (node.note !== null) out.push(...noteLines(node.note, contIndent));
  for (const c of node.children) writeNode(c, depth + 1, out);
}

export function serializeMap(doc: MapDoc): string {
  const out: string[] = [];
  if (doc.rawFrontmatter !== null) {
    out.push('---', doc.rawFrontmatter, '---', '');
  } else if (Object.keys(doc.meta).length > 0) {
    out.push('---', stringifyYaml(doc.meta, { lineWidth: 0 }).trimEnd(), '---', '');
  }
  const rootText = textLines(doc.root.text).join(' ');
  out.push(`# ${itemLine(doc.root, rootText)}`);
  if (doc.root.note !== null) out.push(...noteLines(doc.root.note, ''));
  if (doc.extra.length) out.push('', ...doc.extra);
  if (doc.root.children.length) {
    out.push('');
    for (const c of doc.root.children) writeNode(c, 0, out);
  }
  return out.join('\n') + '\n';
}

/** 복사용: 노드들을 들여쓰기 목록으로 만든다 (ID 제외, 사람이 읽기 좋은 형태) */
export function serializeFragment(nodes: MapNode[]): string {
  const out: string[] = [];
  const write = (n: MapNode, depth: number) => {
    const indent = '  '.repeat(depth);
    const [first = '', ...rest] = textLines(n.text);
    const a = serializeAttrs(n.attrs);
    out.push(`${indent}- ${first}${a ? ` {${a}}` : ''}`);
    for (const l of rest) out.push(`${indent}  ${isSpecialLine(l) ? `\\${l}` : l}`);
    if (n.note !== null) out.push(...noteLines(n.note, indent + '  '));
    n.children.forEach((c) => write(c, depth + 1));
  };
  nodes.forEach((n) => write(n, 0));
  return out.join('\n');
}
