/**
 * 암기용 카드 생성과 가리기 모드 항목 계산.
 *
 * 카드 규칙
 *   - `질문 :: 답`          → 질문/답 카드 (노드 하나당 1장)
 *   - `==빈칸==`            → 빈칸 하나당 1장 (같은 노드의 다른 빈칸은 그대로 보임)
 *   - 포스트잇 안의 `==빈칸==` → 빈칸 하나당 1장
 *   - (옵션) 노드 → 하위 항목 → "하위 항목을 떠올려 보세요" 카드
 */
import type { MapDoc, MapNode } from './model';
import { getTags } from './model';
import { pathTo } from './ops';

export type CardKind = 'qa' | 'cloze' | 'children';

export interface Card {
  /** 기록에 쓰는 고유 키. 노드 ID 기반이라 노드를 옮겨도 유지된다 */
  id: string;
  nodeId: string;
  kind: CardKind;
  /** 앞면/뒷면 (인라인 Markdown. `==x==` 는 강조로 그려진다) */
  front: string;
  back: string;
  /** 위쪽 맥락: 조상 노드들의 텍스트 */
  trail: string[];
  tags: string[];
}

export interface CardOptions {
  /** 이 노드의 하위(자신 포함)만. 기본값은 맵 전체 */
  rootId?: string;
  /** 이 태그가 붙은 노드(또는 그 하위)만 */
  tag?: string | null;
  /** "노드 → 하위 항목" 카드도 만든다 */
  includeChildren?: boolean;
}

const CLOZE_RE = /==([^=\n]+)==/g;
const QA_SEP = ' :: ';
export const BLANK = '[ … ]';

export function splitQA(text: string): { q: string; a: string } | null {
  const i = text.indexOf(QA_SEP);
  if (i < 0) return null;
  const q = text.slice(0, i).trim();
  const a = text.slice(i + QA_SEP.length).trim();
  return q && a ? { q, a } : null;
}

export function countClozes(text: string): number {
  return [...text.matchAll(CLOZE_RE)].length;
}

/** i번째 빈칸만 가리거나(front) 강조(back)하고, 나머지 빈칸은 평문으로 보여 준다 */
function clozeFace(text: string, index: number, face: 'front' | 'back'): string {
  let i = -1;
  return text.replace(CLOZE_RE, (_m, inner: string) => {
    i++;
    if (i !== index) return inner;
    return face === 'front' ? BLANK : `==${inner}==`;
  });
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

function childLabel(child: MapNode): string {
  const t = firstLine(child.text);
  return splitQA(t)?.q ?? t;
}

export function buildCards(doc: MapDoc, opts: CardOptions = {}): Card[] {
  const cards: Card[] = [];
  const rootId = opts.rootId ?? doc.root.id;
  const trailToRoot = pathTo(doc.root, rootId);
  if (!trailToRoot.length) return cards;
  const start = trailToRoot[trailToRoot.length - 1];
  const ancestors = trailToRoot.slice(0, -1);
  const inheritedTags = ancestors.flatMap((n) => getTags(n));
  const baseTrail = ancestors.map((n) => firstLine(n.text));
  const wantTag = opts.tag ? opts.tag.trim() : '';

  const walk = (n: MapNode, trail: string[], tags: string[]) => {
    const own = getTags(n);
    const allTags = own.length ? [...tags, ...own] : tags;
    const ok = !wantTag || allTags.includes(wantTag);
    if (ok) {
      const common = { nodeId: n.id, trail, tags: allTags };
      const qa = splitQA(n.text);
      const clozes = countClozes(n.text);
      if (qa) {
        cards.push({ ...common, id: n.id, kind: 'qa', front: qa.q, back: qa.a });
      } else if (clozes > 0) {
        for (let i = 0; i < clozes; i++) {
          cards.push({
            ...common,
            id: `${n.id}#c${i}`,
            kind: 'cloze',
            front: clozeFace(n.text, i, 'front'),
            back: clozeFace(n.text, i, 'back'),
          });
        }
      } else if (opts.includeChildren && n.children.length > 0) {
        cards.push({
          ...common,
          id: `${n.id}@kids`,
          kind: 'children',
          front: firstLine(n.text) || '(빈 주제)',
          back: n.children.map((c) => `- ${childLabel(c)}`).join('\n'),
        });
      }
      const noteClozes = n.note ? countClozes(n.note) : 0;
      for (let i = 0; i < noteClozes; i++) {
        cards.push({
          ...common,
          id: `${n.id}#n${i}`,
          kind: 'cloze',
          trail: [...trail, firstLine(n.text)],
          front: clozeFace(n.note!, i, 'front'),
          back: clozeFace(n.note!, i, 'back'),
        });
      }
    }
    for (const c of n.children) walk(c, [...trail, firstLine(n.text)], allTags);
  };

  walk(start, baseTrail, inheritedTags);
  return cards;
}

/** 맵에서 쓰인 모든 태그 (카드 범위 선택용) */
export function collectTags(doc: MapDoc): string[] {
  const set = new Set<string>();
  const walk = (n: MapNode) => {
    getTags(n).forEach((t) => set.add(t));
    n.children.forEach(walk);
  };
  walk(doc.root);
  return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
}

// ---------- 가리기 모드 ----------

/**
 * 가리기 모드에서 하나씩 드러낼 수 있는 항목의 키.
 *   n:<노드ID>        노드 텍스트 (범위의 기준 노드 자신은 항상 보임)
 *   c:<노드ID>#<번호>  노드 텍스트 안의 빈칸
 *   m:<노드ID>        포스트잇
 */
export interface HideItem {
  key: string;
  nodeId: string;
  kind: 'node' | 'cloze' | 'note';
}

export function subtreeIds(root: MapNode, scopeId: string): Set<string> {
  const trail = pathTo(root, scopeId);
  const ids = new Set<string>();
  if (!trail.length) return ids;
  const walk = (n: MapNode) => {
    ids.add(n.id);
    n.children.forEach(walk);
  };
  walk(trail[trail.length - 1]);
  return ids;
}

export function hideItems(doc: MapDoc, scopeId: string): HideItem[] {
  const trail = pathTo(doc.root, scopeId);
  if (!trail.length) return [];
  const items: HideItem[] = [];
  const walk = (n: MapNode) => {
    if (n.id !== scopeId) items.push({ key: `n:${n.id}`, nodeId: n.id, kind: 'node' });
    const clozes = countClozes(n.text);
    for (let i = 0; i < clozes; i++) items.push({ key: `c:${n.id}#${i}`, nodeId: n.id, kind: 'cloze' });
    if (n.note && n.note.trim()) items.push({ key: `m:${n.id}`, nodeId: n.id, kind: 'note' });
    n.children.forEach(walk);
  };
  walk(trail[trail.length - 1]);
  return items;
}

/**
 * 다음에 드러낼 항목. fromNodeId 이후(문서 순서)에서 아직 안 드러난 첫 항목을 찾고,
 * 없으면 처음부터 다시 찾는다. 모두 드러났으면 null.
 */
export function nextHidden(items: HideItem[], revealed: ReadonlySet<string>, fromNodeId: string | null): HideItem | null {
  const from = fromNodeId ? items.findIndex((it) => it.nodeId === fromNodeId) : -1;
  const pending = (it: HideItem) => !revealed.has(it.key);
  for (let i = Math.max(from, 0); i < items.length; i++) if (pending(items[i])) return items[i];
  return items.find(pending) ?? null;
}

// ---------- 학습 기록 ----------

export interface StudyRecord {
  reviews: number;
  correct: number;
  /** 연속으로 맞힌 횟수 */
  streak: number;
  /** 마지막 복습 시각 (ISO) */
  last: string;
  lastKnown: boolean;
}

export function applyResult(prev: StudyRecord | undefined, known: boolean, at: string): StudyRecord {
  return {
    reviews: (prev?.reviews ?? 0) + 1,
    correct: (prev?.correct ?? 0) + (known ? 1 : 0),
    streak: known ? (prev?.streak ?? 0) + 1 : 0,
    last: at,
    lastKnown: known,
  };
}

/** 카드를 무작위로 섞는다 (원본은 건드리지 않음) */
export function shuffled<T>(list: readonly T[], random: () => number = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
