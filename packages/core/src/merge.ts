import type { MapDoc, MapNode } from './model';

interface Flat {
  node: MapNode;
  parent: string | null;
  attrsKey: string;
}

function flatten(doc: MapDoc): Map<string, Flat> {
  const m = new Map<string, Flat>();
  const walk = (n: MapNode, parent: string | null) => {
    m.set(n.id, { node: n, parent, attrsKey: JSON.stringify(n.attrs) });
    n.children.forEach((c) => walk(c, n.id));
  };
  walk(doc.root, null);
  return m;
}

const FIELDS = ['text', 'note', 'attrs', 'parent'] as const;
type Field = (typeof FIELDS)[number];

function fieldValue(f: Flat, k: Field): unknown {
  if (k === 'attrs') return f.attrsKey;
  if (k === 'parent') return f.parent;
  return f.node[k];
}

function changed(a: Flat | undefined, b: Flat): boolean {
  if (!a) return true;
  return FIELDS.some((k) => fieldValue(a, k) !== fieldValue(b, k));
}

function childIds(m: Map<string, Flat>, id: string): string[] {
  return m.get(id)?.node.children.map((c) => c.id) ?? [];
}

function sameSeq(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export interface MergeResult {
  doc: MapDoc;
  /** 양쪽에서 같은 노드를 서로 다르게 바꾼 경우 (내 쪽 값이 채택됨) */
  conflicts: string[];
}

/**
 * 노드 ID 기준 3-way 병합. base = 마지막으로 디스크에서 읽은 버전,
 * ours = 앱에서 편집한 버전, theirs = 디스크의 새 버전(AI 편집 등).
 * 한쪽만 바꾼 필드는 그 변경을 채택하고, 양쪽이 다르게 바꾸면 ours를 채택한다.
 */
export function mergeMaps(base: MapDoc, ours: MapDoc, theirs: MapDoc): MergeResult {
  const B = flatten(base);
  const O = flatten(ours);
  const T = flatten(theirs);
  const conflicts: string[] = [];
  const rootId = ours.root.id;

  interface Merged {
    text: string;
    note: string | null;
    attrs: MapNode['attrs'];
    parent: string | null;
  }
  const result = new Map<string, Merged>();

  const pick = <V>(id: string, k: Field, b: Flat | undefined, o: Flat, t: Flat): V => {
    const ov = fieldValue(o, k);
    const tv = fieldValue(t, k);
    if (ov === tv) return ov as V;
    const bv = b ? fieldValue(b, k) : undefined;
    if (ov === bv) return tv as V;
    if (tv === bv) return ov as V;
    conflicts.push(`${id}.${k}`);
    return ov as V;
  };

  const fromFlat = (f: Flat): Merged => ({
    text: f.node.text,
    note: f.node.note,
    attrs: f.node.attrs,
    parent: f.parent,
  });

  const ids = new Set([...O.keys(), ...T.keys()]);
  for (const id of ids) {
    const b = B.get(id);
    const o = O.get(id);
    const t = T.get(id);
    if (o && t) {
      const attrsKey = pick<string>(id, 'attrs', b, o, t);
      result.set(id, {
        text: pick(id, 'text', b, o, t),
        note: pick(id, 'note', b, o, t),
        attrs: JSON.parse(attrsKey),
        parent: id === rootId ? null : pick(id, 'parent', b, o, t),
      });
    } else if (o) {
      // theirs에서 삭제됐거나 ours에서 추가됨
      if (!b) result.set(id, fromFlat(o));
      else if (changed(b, o)) {
        conflicts.push(`${id}.deleted`);
        result.set(id, fromFlat(o));
      }
    } else if (t) {
      if (!b) result.set(id, fromFlat(t));
      else if (changed(b, t)) {
        conflicts.push(`${id}.deleted`);
        result.set(id, fromFlat(t));
      }
    }
  }

  // 부모가 삭제된 노드가 남아 있으면 부모를 되살린다
  for (let again = true; again; ) {
    again = false;
    for (const m of result.values()) {
      if (m.parent && !result.has(m.parent)) {
        const src = O.get(m.parent) ?? T.get(m.parent);
        if (src) result.set(m.parent, fromFlat(src));
        else m.parent = rootId;
        again = true;
      }
    }
  }

  // 순환 방지: 이동이 엇갈려 순환이 생기면 ours의 부모로, 그래도 안 되면 루트로
  const hasCycle = (id: string) => {
    const seen = new Set<string>();
    for (let cur: string | null = id; cur; cur = result.get(cur)?.parent ?? null) {
      if (seen.has(cur)) return true;
      seen.add(cur);
    }
    return false;
  };
  for (const [id, m] of result) {
    if (id !== rootId && hasCycle(id)) {
      m.parent = O.get(id)?.parent ?? rootId;
      if (hasCycle(id)) m.parent = rootId;
    }
  }

  // 자식 순서 결정
  const kids = new Map<string, Set<string>>();
  for (const [id, m] of result) {
    if (!m.parent) continue;
    if (!kids.has(m.parent)) kids.set(m.parent, new Set());
    kids.get(m.parent)!.add(id);
  }
  const orderFor = (pid: string): string[] => {
    const set = kids.get(pid) ?? new Set<string>();
    const ob = childIds(B, pid);
    const oo = childIds(O, pid);
    const ot = childIds(T, pid);
    const [primary, secondary] = sameSeq(oo, ob) ? [ot, oo] : [oo, ot];
    const order = primary.filter((x) => set.has(x));
    const placed = new Set(order);
    for (let i = 0; i < secondary.length; i++) {
      const x = secondary[i];
      if (!set.has(x) || placed.has(x)) continue;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = order.indexOf(secondary[j]);
        if (k >= 0) {
          at = k + 1;
          break;
        }
      }
      order.splice(at, 0, x);
      placed.add(x);
    }
    for (const x of set) if (!placed.has(x)) order.push(x);
    return order;
  };

  const build = (id: string): MapNode => {
    const m = result.get(id)!;
    return {
      id,
      text: m.text,
      note: m.note,
      attrs: m.attrs,
      children: orderFor(id).map(build),
    };
  };

  const mergeRecord = (b: Record<string, unknown>, o: Record<string, unknown>, t: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) {
      const [bv, ov, tv] = [b[k], o[k], t[k]].map((v) => JSON.stringify(v));
      const v = ov === tv ? o[k] : ov === bv ? t[k] : o[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  };

  const doc: MapDoc = {
    meta: mergeRecord(base.meta, ours.meta, theirs.meta),
    rawFrontmatter: ours.rawFrontmatter === base.rawFrontmatter ? theirs.rawFrontmatter : ours.rawFrontmatter,
    root: build(rootId),
    extra: sameSeq(ours.extra, base.extra) ? theirs.extra : ours.extra,
  };
  return { doc, conflicts };
}
