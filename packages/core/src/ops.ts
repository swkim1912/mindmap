/**
 * 맵 편집 연산. doc을 직접 변경하므로 immer draft에 사용한다.
 */
import type { MapDoc, MapNode } from './model';
import { collectIds, newId } from './id';
import { isCollapsed } from './model';

export function findNode(root: MapNode, id: string): MapNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

export function findParent(root: MapNode, id: string): { parent: MapNode; index: number } | null {
  const i = root.children.findIndex((c) => c.id === id);
  if (i >= 0) return { parent: root, index: i };
  for (const c of root.children) {
    const f = findParent(c, id);
    if (f) return f;
  }
  return null;
}

/** 루트부터 id까지의 경로 (id 포함). 없으면 빈 배열 */
export function pathTo(root: MapNode, id: string): MapNode[] {
  if (root.id === id) return [root];
  for (const c of root.children) {
    const p = pathTo(c, id);
    if (p.length) return [root, ...p];
  }
  return [];
}

export function isAncestor(root: MapNode, ancestorId: string, id: string): boolean {
  return pathTo(root, id).some((n) => n.id === ancestorId);
}

export function createNode(doc: MapDoc, text = ''): MapNode {
  return { id: newId(collectIds(doc.root)), text, attrs: {}, note: null, children: [] };
}

function expand(n: MapNode) {
  if (isCollapsed(n)) delete n.attrs.collapsed;
}

export function addChild(doc: MapDoc, parentId: string, node?: MapNode, index?: number): MapNode | null {
  const p = findNode(doc.root, parentId);
  if (!p) return null;
  const n = node ?? createNode(doc);
  expand(p);
  p.children.splice(index ?? p.children.length, 0, n);
  return n;
}

export function addSibling(doc: MapDoc, id: string, before = false): MapNode | null {
  const loc = findParent(doc.root, id);
  if (!loc) return addChild(doc, id); // 루트에서는 하위 주제 추가
  const n = createNode(doc);
  loc.parent.children.splice(loc.index + (before ? 0 : 1), 0, n);
  return n;
}

/** id 노드 자리에 새 노드를 넣고 id를 그 아래로 내린다 */
export function insertParent(doc: MapDoc, id: string): MapNode | null {
  const loc = findParent(doc.root, id);
  if (!loc) return null;
  const n = createNode(doc);
  const [old] = loc.parent.children.splice(loc.index, 1, n);
  n.children.push(old);
  return n;
}

/** 노드들을 삭제하고, 다음에 선택할 노드 ID를 돌려준다 */
export function removeNodes(doc: MapDoc, ids: string[]): string | null {
  let next: string | null = null;
  for (const id of ids) {
    const loc = findParent(doc.root, id);
    if (!loc) continue;
    const sibs = loc.parent.children;
    sibs.splice(loc.index, 1);
    next = sibs[loc.index]?.id ?? sibs[loc.index - 1]?.id ?? loc.parent.id;
  }
  if (next && !findNode(doc.root, next)) next = doc.root.id;
  return next;
}

export function moveSibling(doc: MapDoc, id: string, delta: -1 | 1): boolean {
  const loc = findParent(doc.root, id);
  if (!loc) return false;
  const j = loc.index + delta;
  const sibs = loc.parent.children;
  if (j < 0 || j >= sibs.length) return false;
  [sibs[loc.index], sibs[j]] = [sibs[j], sibs[loc.index]];
  return true;
}

/** id 노드를 newParentId의 index 위치로 옮긴다. 자기 하위로는 옮길 수 없다. */
export function moveNode(doc: MapDoc, id: string, newParentId: string, index: number): boolean {
  if (id === newParentId || isAncestor(doc.root, id, newParentId)) return false;
  const loc = findParent(doc.root, id);
  const target = findNode(doc.root, newParentId);
  if (!loc || !target) return false;
  const [n] = loc.parent.children.splice(loc.index, 1);
  if (loc.parent === target && loc.index < index) index--;
  expand(target);
  target.children.splice(Math.max(0, Math.min(index, target.children.length)), 0, n);
  return true;
}

export function setText(doc: MapDoc, id: string, text: string) {
  const n = findNode(doc.root, id);
  if (n) n.text = text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

export function setNote(doc: MapDoc, id: string, note: string | null) {
  const n = findNode(doc.root, id);
  if (n) n.note = note;
}

export function setAttr(doc: MapDoc, id: string, key: string, value: string | true | undefined) {
  const n = findNode(doc.root, id);
  if (!n) return;
  if (value === undefined) delete n.attrs[key];
  else n.attrs[key] = value;
}

export function toggleCollapsed(doc: MapDoc, id: string) {
  const n = findNode(doc.root, id);
  if (!n || n.children.length === 0) return;
  if (isCollapsed(n)) delete n.attrs.collapsed;
  else n.attrs.collapsed = true;
}

/** 깊이 depth 이하만 펼치고 나머지는 접는다 (depth 0 = 루트의 자식까지 보임) */
export function expandToLevel(doc: MapDoc, level: number) {
  const walk = (n: MapNode, d: number) => {
    if (n.children.length) {
      if (d >= level) n.attrs.collapsed = true;
      else delete n.attrs.collapsed;
    }
    n.children.forEach((c) => walk(c, d + 1));
  };
  walk(doc.root, 0);
}
