import { isCollapsed, type LayoutKind, type MapNode } from '@mindmap/core';

export interface Size {
  w: number;
  h: number;
}

export interface Box {
  id: string;
  node: MapNode;
  parentId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  /** 1 = 오른쪽, -1 = 왼쪽, 0 = 루트 */
  side: 1 | -1 | 0;
  /** 1단계 가지 번호 (색상용) */
  branch: number;
}

export interface Layout {
  boxes: Map<string, Box>;
  /** 화면 표시 순서 (깊이 우선) */
  order: Box[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const HGAP = { mindmap: 44, 'logic-right': 36 } as const;
const VGAP = (depth: number) => (depth <= 1 ? 18 : 8);

export function estimateSize(node: MapNode, depth: number): Size {
  const lines = node.text.split('\n');
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const font = depth === 0 ? 22 : depth === 1 ? 16 : 14;
  return { w: Math.min(360, 28 + longest * font * 0.9), h: 14 + lines.length * font * 1.5 };
}

export function computeLayout(
  root: MapNode,
  kind: LayoutKind,
  sizeOf: (n: MapNode, depth: number) => Size,
  /** 접혀 있어도 이번 화면에서는 펼쳐 보일 노드 (링크로 이동했을 때) */
  reveal: ReadonlySet<string> = new Set(),
): Layout {
  const boxes = new Map<string, Box>();
  const order: Box[] = [];
  const hgap = HGAP[kind];
  const heights = new Map<string, number>();
  const sizes = new Map<string, Size>();

  const visibleKids = (n: MapNode) => (isCollapsed(n) && !reveal.has(n.id) ? [] : n.children);

  const measure = (n: MapNode, depth: number): number => {
    const s = sizeOf(n, depth);
    sizes.set(n.id, s);
    const kids = visibleKids(n);
    let sum = 0;
    kids.forEach((c, i) => {
      sum += measure(c, depth + 1) + (i ? VGAP(depth + 1) : 0);
    });
    const h = Math.max(s.h, sum);
    heights.set(n.id, h);
    return h;
  };

  /** edgeX: side=1이면 노드의 왼쪽 끝, side=-1이면 오른쪽 끝 */
  const place = (n: MapNode, parentId: string, edgeX: number, top: number, side: 1 | -1, depth: number, branch: number) => {
    const s = sizes.get(n.id)!;
    const block = heights.get(n.id)!;
    const x = side === 1 ? edgeX : edgeX - s.w;
    const box: Box = { id: n.id, node: n, parentId, x, y: top + (block - s.h) / 2, w: s.w, h: s.h, depth, side, branch };
    boxes.set(n.id, box);
    order.push(box);
    placeChildren(n, box, side, top, block, depth, branch);
  };

  const placeChildren = (n: MapNode, box: Box, side: 1 | -1, top: number, block: number, depth: number, branch: number, kids = visibleKids(n)) => {
    let total = 0;
    kids.forEach((c, i) => (total += heights.get(c.id)! + (i ? VGAP(depth + 1) : 0)));
    let y = top + (block - total) / 2;
    const childEdge = side === 1 ? box.x + box.w + hgap : box.x - hgap;
    for (const c of kids) {
      place(c, n.id, childEdge, y, side, depth + 1, depth === 0 ? kids.indexOf(c) : branch);
      y += heights.get(c.id)! + VGAP(depth + 1);
    }
  };

  measure(root, 0);
  const rs = sizes.get(root.id)!;
  const rootBox: Box = { id: root.id, node: root, parentId: null, x: 0, y: 0, w: rs.w, h: rs.h, depth: 0, side: 0, branch: -1 };
  boxes.set(root.id, rootBox);
  order.push(rootBox);
  const kids = visibleKids(root);

  if (kind === 'logic-right') {
    const block = heights.get(root.id)!;
    rootBox.x = 0;
    rootBox.y = -rs.h / 2;
    placeChildren(root, rootBox, 1, -block / 2, block, 0, 0);
  } else {
    // 높이 합이 비슷하도록 앞쪽 가지는 오른쪽, 나머지는 왼쪽에 배치
    const total = kids.reduce((a, c) => a + heights.get(c.id)!, 0);
    let acc = 0;
    let split = 0;
    while (split < kids.length && (split === 0 || acc + heights.get(kids[split].id)! / 2 <= total / 2)) {
      acc += heights.get(kids[split].id)!;
      split++;
    }
    const right = kids.slice(0, split);
    const left = kids.slice(split);
    rootBox.x = -rs.w / 2;
    rootBox.y = -rs.h / 2;
    const blockOf = (arr: MapNode[]) => arr.reduce((a, c, i) => a + heights.get(c.id)! + (i ? VGAP(1) : 0), 0);
    const placeSide = (arr: MapNode[], side: 1 | -1) => {
      const block = blockOf(arr);
      let y = -block / 2;
      const edge = side === 1 ? rootBox.x + rootBox.w + hgap : rootBox.x - hgap;
      for (const c of arr) {
        place(c, root.id, edge, y, side, 1, kids.indexOf(c));
        y += heights.get(c.id)! + VGAP(1);
      }
    };
    placeSide(right, 1);
    placeSide(left, -1);
  }

  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const b of order) {
    bounds.minX = Math.min(bounds.minX, b.x);
    bounds.minY = Math.min(bounds.minY, b.y);
    bounds.maxX = Math.max(bounds.maxX, b.x + b.w);
    bounds.maxY = Math.max(bounds.maxY, b.y + b.h);
  }
  return { boxes, order, bounds };
}

/** 부모→자식 연결선 SVG path */
/** 2단계 이하 노드는 밑줄 스타일이라 선을 밑줄 높이에 붙인다 */
const anchorY = (b: Box) => (b.depth >= 2 ? b.y + b.h - 1 : b.y + b.h / 2);

export function edgePath(p: Box, c: Box, kind: LayoutKind): string {
  const side = c.side;
  const x1 = side === 1 ? p.x + p.w : p.x;
  const y1 = anchorY(p);
  const x2 = side === 1 ? c.x : c.x + c.w;
  const y2 = anchorY(c);
  if (kind === 'logic-right') {
    const mx = x1 + (x2 - x1) / 2;
    const r = Math.min(8, Math.abs(y2 - y1) / 2, Math.abs(mx - x1));
    if (r < 1) return `M${x1},${y1} H${x2}`;
    const dy = y2 > y1 ? r : -r;
    const dx = x2 > x1 ? r : -r;
    return `M${x1},${y1} H${mx - dx} Q${mx},${y1} ${mx},${y1 + dy} V${y2 - dy} Q${mx},${y2} ${mx + dx},${y2} H${x2}`;
  }
  const dx = (x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

/** 방향키 탐색 */
export function navigate(layout: Layout, fromId: string, dir: 'up' | 'down' | 'left' | 'right'): string | null {
  const from = layout.boxes.get(fromId);
  if (!from) return null;
  const cy = (b: Box) => b.y + b.h / 2;
  const cx = (b: Box) => b.x + b.w / 2;

  if (dir === 'left' || dir === 'right') {
    const want = dir === 'right' ? 1 : -1;
    const outward = from.side === 0 ? want : from.side === want ? 1 : -1;
    if (outward === 1 || from.side === 0) {
      // 바깥쪽 = 자식 중 세로로 가장 가까운 것
      const kids = layout.order.filter((b) => b.parentId === from.id && (from.side !== 0 || b.side === want));
      if (!kids.length) return null;
      return kids.reduce((best, b) => (Math.abs(cy(b) - cy(from)) < Math.abs(cy(best) - cy(from)) ? b : best)).id;
    }
    return from.parentId;
  }

  // 위/아래: 같은 쪽에서 세로 방향으로 가장 가까운 노드 (같은 깊이 우선)
  const sign = dir === 'down' ? 1 : -1;
  const cands = layout.order.filter((b) => b.id !== from.id && b.side === from.side && (cy(b) - cy(from)) * sign > 1);
  if (!cands.length) return null;
  const score = (b: Box) => Math.abs(cy(b) - cy(from)) + Math.abs(cx(b) - cx(from)) * 0.6 + (b.depth === from.depth ? 0 : 400);
  return cands.reduce((best, b) => (score(b) < score(best) ? b : best)).id;
}
