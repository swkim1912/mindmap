import {
  addChild,
  addSibling,
  collectIds,
  findNode,
  getLayout,
  insertParent,
  isAncestor,
  moveSibling,
  parseFragment,
  removeNodes,
  serializeFragment,
  toggleCollapsed,
  type MapDoc,
  type MapNode,
} from '@mindmap/core';
import { useStore } from './store';

const st = () => useStore.getState();

/** 선택된 노드 중 다른 선택 노드의 하위가 아닌 것만 (문서 순서 유지) */
export function topLevelSelection(): MapNode[] {
  const { map, selected } = st();
  if (!map) return [];
  const root = map.doc.root;
  return selected
    .filter((id) => !selected.some((o) => o !== id && isAncestor(root, o, id)))
    .map((id) => findNode(root, id))
    .filter((n): n is MapNode => !!n);
}

function addAndEdit(fn: (d: MapDoc) => MapNode | null) {
  let created = null as string | null;
  st().apply((d) => {
    created = fn(d)?.id ?? null;
  });
  if (created) st().startEdit(created, true);
}

export const commands = {
  addChild() {
    const p = st().primary;
    if (p) addAndEdit((d) => addChild(d, p));
  },
  addSibling(before = false) {
    const p = st().primary;
    if (p) addAndEdit((d) => addSibling(d, p, before));
  },
  insertParent() {
    const { primary, map } = st();
    if (primary && map && primary !== map.doc.root.id) addAndEdit((d) => insertParent(d, primary));
  },
  edit() {
    const p = st().primary;
    if (p) st().startEdit(p);
  },
  remove() {
    const { map } = st();
    if (!map) return;
    const ids = topLevelSelection()
      .map((n) => n.id)
      .filter((id) => id !== map.doc.root.id);
    if (!ids.length) return;
    let next = null as string | null;
    st().apply((d) => {
      next = removeNodes(d, ids);
    });
    if (next) st().select(next);
  },
  move(delta: -1 | 1) {
    const p = st().primary;
    if (p) st().apply((d) => void moveSibling(d, p, delta));
  },
  toggleCollapse() {
    const { map, selected } = st();
    if (!map) return;
    // 마인드맵 레이아웃에서는 중심 주제를 접으면 다시 펼칠 버튼이 없으므로 제외
    const ids = getLayout(map.doc) === 'mindmap' ? selected.filter((id) => id !== map.doc.root.id) : selected;
    st().apply((d) => ids.forEach((id) => toggleCollapsed(d, id)));
  },
  copyText(): string | null {
    const nodes = topLevelSelection();
    return nodes.length ? serializeFragment(nodes) : null;
  },
  paste(text: string) {
    const { primary, map } = st();
    if (!primary || !map || !text.trim()) return;
    const nodes = parseFragment(text, collectIds(map.doc.root));
    if (!nodes.length) return;
    st().apply((d) => nodes.forEach((n) => addChild(d, primary, n)));
    st().select(nodes[0].id);
  },
};
