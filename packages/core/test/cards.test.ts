import { describe, expect, it } from 'vitest';
import {
  applyResult,
  buildCards,
  collectTags,
  hideItems,
  nextHidden,
  parseMap,
  shuffled,
  splitQA,
  subtreeIds,
} from '../src';

const SRC = `# 운영체제 ^root

- 프로세스 ^p1
  - 프로세스 :: 실행 중인 프로그램 ^qa1
  - 스레드 {tags=시험} ^th
    - 스택은 ==독립==, 힙은 ==공유== ^cz1
    > 📌 TLB는 ==주소 변환== 캐시
- 메모리 {tags=중요} ^m1
  - 페이징 ^pg
    - 내부 단편화 ^pg1
    - 외부 단편화 ^pg2
`;

const doc = parseMap(SRC).doc;

describe('buildCards', () => {
  it('makes QA, cloze (one per blank) and note-cloze cards', () => {
    const cards = buildCards(doc);
    // 포스트잇(> 📌)은 `스레드` 노드에 붙어 있어서 그 노드의 카드로 만들어진다
    expect(cards.map((c) => c.id)).toEqual(['qa1', 'th#n0', 'cz1#c0', 'cz1#c1']);
    const [qa, , c0, c1] = cards;
    expect(qa).toMatchObject({ kind: 'qa', front: '프로세스', back: '실행 중인 프로그램' });
    expect(qa.trail).toEqual(['운영체제', '프로세스']);
    expect(c0.front).toBe('스택은 [ … ], 힙은 공유');
    expect(c0.back).toBe('스택은 ==독립==, 힙은 공유');
    expect(c1.front).toBe('스택은 독립, 힙은 [ … ]');
  });

  it('makes cards from blanks inside sticky notes', () => {
    const d = parseMap(`# r ^root\n\n- 스레드 ^t\n  > 📌 TLB는 ==주소 변환== 캐시\n`).doc;
    const [c] = buildCards(d);
    expect(c).toMatchObject({ id: 't#n0', front: 'TLB는 [ … ] 캐시', back: 'TLB는 ==주소 변환== 캐시' });
    expect(c.trail).toEqual(['r', '스레드']);
  });

  it('adds node→children cards only when asked, skipping nodes that already have cards', () => {
    const ids = buildCards(doc, { includeChildren: true }).map((c) => c.id);
    expect(ids).toContain('pg@kids');
    expect(ids).toContain('root@kids');
    expect(ids).not.toContain('cz1@kids');
    expect(ids).not.toContain('qa1@kids');
    const pg = buildCards(doc, { includeChildren: true }).find((c) => c.id === 'pg@kids')!;
    expect(pg.back).toBe('- 내부 단편화\n- 외부 단편화');
    const p1 = buildCards(doc, { includeChildren: true }).find((c) => c.id === 'p1@kids')!;
    expect(p1.back).toBe('- 프로세스\n- 스레드'); // QA 자식은 질문 부분만
  });

  it('limits by subtree and by (inherited) tag', () => {
    expect(buildCards(doc, { rootId: 'th' }).map((c) => c.id)).toEqual(['th#n0', 'cz1#c0', 'cz1#c1']);
    expect(buildCards(doc, { tag: '시험' }).map((c) => c.id)).toEqual(['th#n0', 'cz1#c0', 'cz1#c1']);
    expect(buildCards(doc, { tag: '중요', includeChildren: true }).map((c) => c.id)).toEqual(['m1@kids', 'pg@kids']);
    expect(buildCards(doc, { rootId: '없음' })).toEqual([]);
    expect(collectTags(doc)).toEqual(['시험', '중요']);
  });

  it('splits QA only on the first separator and ignores empty sides', () => {
    expect(splitQA('a :: b :: c')).toEqual({ q: 'a', a: 'b :: c' });
    expect(splitQA('a ::')).toBeNull();
    expect(splitQA('no sep')).toBeNull();
  });
});

describe('hide mode items', () => {
  it('lists nodes, blanks and notes in document order, excluding the scope node itself', () => {
    // 범위의 기준 노드(th) 자신의 텍스트는 보이지만, 그 노드의 포스트잇과 하위는 가려진다
    expect(hideItems(doc, 'th').map((i) => i.key)).toEqual(['m:th', 'n:cz1', 'c:cz1#0', 'c:cz1#1']);
    expect(hideItems(doc, 'root').map((i) => i.key).slice(0, 5)).toEqual(['n:p1', 'n:qa1', 'n:th', 'm:th', 'n:cz1']);
    expect([...subtreeIds(doc.root, 'm1')].sort()).toEqual(['m1', 'pg', 'pg1', 'pg2']);
  });

  it('includes sticky notes and advances to the next unrevealed item, wrapping around', () => {
    const items = hideItems(doc, 'root');
    const revealed = new Set<string>();
    expect(nextHidden(items, revealed, null)?.key).toBe('n:p1');
    revealed.add('n:p1');
    revealed.add('n:qa1');
    expect(nextHidden(items, revealed, 'qa1')?.key).toBe('n:th');
    expect(nextHidden(items, revealed, 'pg1')?.key).toBe('n:pg1');
    items.forEach((i) => revealed.add(i.key));
    expect(nextHidden(items, revealed, 'th')).toBeNull();
    expect(items.some((i) => i.kind === 'note' && i.nodeId === 'th')).toBe(true);
  });
});

describe('study records', () => {
  it('tracks streaks and resets on a miss', () => {
    let r = applyResult(undefined, true, 't1');
    r = applyResult(r, true, 't2');
    expect(r).toEqual({ reviews: 2, correct: 2, streak: 2, last: 't2', lastKnown: true });
    r = applyResult(r, false, 't3');
    expect(r).toMatchObject({ reviews: 3, correct: 2, streak: 0, lastKnown: false });
  });

  it('shuffles without mutating and keeps all items', () => {
    const src = [1, 2, 3, 4, 5, 6];
    const out = shuffled(src, () => 0.3);
    expect(src).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...out].sort()).toEqual(src);
  });
});
