import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import {
  addChild,
  mergeMaps,
  moveNode,
  parseFragment,
  parseMap,
  removeNodes,
  serializeFragment,
  serializeMap,
  findNode,
  collectIds,
} from '../src';

const SAMPLE = `---
id: map_k2x9
title: 운영체제
layout: mindmap
---

# 운영체제 ^root

- 프로세스 관리 ^a1b2
  - 프로세스 vs 스레드 {color=red tags=시험} ^c3d4
    > 📌 스레드는 코드/데이터/힙을 공유하고,
    > 스택만 따로 가진다.
    - 프로세스 :: 실행 중인 프로그램, 독립된 메모리 공간 ^e5f6
    - 스레드 :: 프로세스 내 실행 흐름 ^g7h8
  - CPU 스케줄링 [[운영체제/pages/스케줄링]] {collapsed} ^i9j0
    - 선점형: ==RR==, SRTF ^k1l2
- 메모리 관리 ^m3n4
  - 페이징과 연결: [[자료구조.mm#^x7y8|해시 테이블]] ^o5p6
- 페이지 교체 수식 $EAT = (1-p)\\cdot ma + p \\cdot t$ ^q7r8
`;

describe('parseMap', () => {
  it('parses structure, ids, attrs and notes', () => {
    const { doc, warnings, normalized } = parseMap(SAMPLE);
    expect(warnings).toEqual([]);
    expect(normalized).toBe(false);
    expect(doc.meta.title).toBe('운영체제');
    expect(doc.root.text).toBe('운영체제');
    expect(doc.root.children.map((c) => c.id)).toEqual(['a1b2', 'm3n4', 'q7r8']);
    const pv = findNode(doc.root, 'c3d4')!;
    expect(pv.text).toBe('프로세스 vs 스레드');
    expect(pv.attrs).toEqual({ color: 'red', tags: '시험' });
    expect(pv.note).toBe('스레드는 코드/데이터/힙을 공유하고,\n스택만 따로 가진다.');
    expect(pv.children).toHaveLength(2);
    expect(findNode(doc.root, 'i9j0')!.attrs).toEqual({ collapsed: true });
    expect(findNode(doc.root, 'q7r8')!.text).toBe('페이지 교체 수식 $EAT = (1-p)\\cdot ma + p \\cdot t$');
  });

  it('round-trips canonical files byte-for-byte', () => {
    expect(serializeMap(parseMap(SAMPLE).doc)).toBe(SAMPLE);
  });

  it('assigns ids to nodes written without them (AI edits)', () => {
    const src = `# 영어\n\n- 단어\n  - apple :: 사과\n* 문법\n    1. 시제\n`;
    const { doc, normalized } = parseMap(src);
    expect(normalized).toBe(true);
    expect(doc.root.id).toBe('root');
    expect(doc.root.children.map((c) => c.text)).toEqual(['단어', '문법']);
    expect(doc.root.children[1].children[0].text).toBe('시제');
    const ids = [...collectIds(doc.root)];
    expect(new Set(ids).size).toBe(ids.length);
    // 정규화 후에는 안정적
    const again = parseMap(serializeMap(doc));
    expect(again.normalized).toBe(false);
    expect(again.doc).toEqual(doc);
  });

  it('fixes duplicate ids', () => {
    const { doc, warnings } = parseMap(`# r ^root\n- a ^x1\n- b ^x1\n`);
    expect(doc.root.children[0].id).toBe('x1');
    expect(doc.root.children[1].id).not.toBe('x1');
    expect(warnings[0].message).toContain('중복');
  });

  it('handles tabs and 4-space indentation', () => {
    const { doc } = parseMap(`# r\n- a\n\t- b\n\t\t- c\n    - d\n`);
    const a = doc.root.children[0];
    expect(a.children.map((c) => c.text)).toEqual(['b', 'd']);
    expect(a.children[0].children[0].text).toBe('c');
  });

  it('creates root when heading is missing and keeps stray lines', () => {
    const { doc, warnings } = parseMap(`---\ntitle: 제목\n---\n그냥 문단\n- a\n`);
    expect(doc.root.text).toBe('제목');
    expect(doc.extra).toEqual(['그냥 문단']);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not treat braces in text as attrs', () => {
    const { doc } = parseMap(`# r\n- 집합 {1, 2}\n- 함수 f{x} ^ab12\n`);
    expect(doc.root.children[0].text).toBe('집합 {1, 2}');
    expect(doc.root.children[1].text).toBe('함수 f{x}');
  });

  it('preserves broken frontmatter', () => {
    const src = `---\ntitle: [oops\n---\n\n# r ^root\n`;
    const { doc, warnings } = parseMap(src);
    expect(warnings.length).toBe(1);
    expect(serializeMap(doc)).toBe(src);
  });
});

describe('serializeMap', () => {
  it('round-trips multi-line text, special lines, quoted attrs and empty nodes', () => {
    const { doc } = parseMap(`# r ^root\n- x ^aaaa\n`);
    const d2 = produce(doc, (d) => {
      const n = d.root.children[0];
      n.text = '첫 줄\n- 목록처럼 보이는 줄\n> 인용처럼\n\\백슬래시';
      n.attrs = { color: '#ff0000', label: 'two words', done: true };
      n.note = '메모\n\n- 메모 안 목록';
      n.children.push({ id: 'bbbb', text: '', attrs: {}, note: null, children: [] });
    });
    const text = serializeMap(d2);
    const back = parseMap(text);
    expect(back.warnings).toEqual([]);
    expect(back.doc).toEqual(d2);
  });
});

describe('fragments', () => {
  it('copies and pastes subtrees with new ids', () => {
    const { doc } = parseMap(SAMPLE);
    const frag = serializeFragment([findNode(doc.root, 'c3d4')!]);
    expect(frag).not.toContain('^');
    const taken = collectIds(doc.root);
    const nodes = parseFragment(frag, taken);
    expect(nodes[0].text).toBe('프로세스 vs 스레드');
    expect(nodes[0].children).toHaveLength(2);
    expect(nodes[0].id).not.toBe('c3d4');
  });

  it('turns plain lines into sibling nodes', () => {
    const nodes = parseFragment('사과\n\n바나나\n', new Set());
    expect(nodes.map((n) => n.text)).toEqual(['사과', '바나나']);
  });
});

describe('mergeMaps', () => {
  const base = parseMap(SAMPLE).doc;

  it('combines independent edits from both sides', () => {
    const ours = produce(base, (d) => {
      findNode(d.root, 'a1b2')!.text = '프로세스 관리 (내 수정)';
      addChild(d, 'm3n4', { id: 'our1', text: '내 노드', attrs: {}, note: null, children: [] });
    });
    const theirs = produce(base, (d) => {
      findNode(d.root, 'm3n4')!.text = '메모리 관리 (AI 수정)';
      addChild(d, 'm3n4', { id: 'ai01', text: 'AI 노드', attrs: {}, note: null, children: [] });
      removeNodes(d, ['q7r8']);
    });
    const { doc, conflicts } = mergeMaps(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(findNode(doc.root, 'a1b2')!.text).toBe('프로세스 관리 (내 수정)');
    expect(findNode(doc.root, 'm3n4')!.text).toBe('메모리 관리 (AI 수정)');
    expect(findNode(doc.root, 'm3n4')!.children.map((c) => c.id)).toEqual(['o5p6', 'ai01', 'our1']);
    expect(findNode(doc.root, 'q7r8')).toBeNull();
  });

  it('prefers ours on true conflicts and reports them', () => {
    const ours = produce(base, (d) => void (findNode(d.root, 'a1b2')!.text = 'A'));
    const theirs = produce(base, (d) => void (findNode(d.root, 'a1b2')!.text = 'B'));
    const { doc, conflicts } = mergeMaps(base, ours, theirs);
    expect(findNode(doc.root, 'a1b2')!.text).toBe('A');
    expect(conflicts).toEqual(['a1b2.text']);
  });

  it('keeps a deleted parent when the other side added a child to it', () => {
    const ours = produce(base, (d) => void removeNodes(d, ['m3n4']));
    const theirs = produce(base, (d) =>
      void addChild(d, 'o5p6', { id: 'ai02', text: 'x', attrs: {}, note: null, children: [] }),
    );
    const { doc } = mergeMaps(base, ours, theirs);
    expect(findNode(doc.root, 'ai02')).not.toBeNull();
    expect(findNode(doc.root, 'm3n4')).not.toBeNull();
  });

  it('applies moves and avoids cycles', () => {
    const ours = produce(base, (d) => void moveNode(d, 'a1b2', 'm3n4', 0));
    const theirs = produce(base, (d) => void moveNode(d, 'm3n4', 'a1b2', 0));
    const { doc } = mergeMaps(base, ours, theirs);
    // 모든 노드가 루트에서 도달 가능해야 함
    expect(collectIds(doc.root).size).toBe(collectIds(base.root).size);
  });
});

describe('ops', () => {
  it('refuses to move a node into its own subtree', () => {
    const { doc } = parseMap(SAMPLE);
    const after = produce(doc, (d) => void moveNode(d, 'a1b2', 'e5f6', 0));
    expect(after).toBe(doc);
  });
});

import {
  assetsDirFor,
  extractLinks,
  formatWikiLink,
  linkTargetFor,
  relativePath,
  resolveLink,
  rewriteLinks,
} from '../src';

describe('links', () => {
  const files = [
    '예시/운영체제.mm.md',
    '예시/운영체제/pages/스케줄링.md',
    '예시/자료구조.mm.md',
    '영어/pages/스케줄링.md',
    '영어/필수단어.mm.md',
  ];

  it('parses link variants', () => {
    const [a, b, c] = extractLinks('x [[a/b]] y [[자료구조.mm#^x7y8|해시]] [[#^q1]]');
    expect(a).toMatchObject({ target: 'a/b', anchor: null, label: null });
    expect(b).toMatchObject({ target: '자료구조.mm', anchor: '^x7y8', label: '해시' });
    expect(c).toMatchObject({ target: '', anchor: '^q1' });
    expect(formatWikiLink({ target: 't.mm', nodeId: 'n1', label: 'L' })).toBe('[[t.mm#^n1|L]]');
  });

  it('resolves exact, partial and name-only targets', () => {
    const r = (t: string, from = '예시/운영체제.mm.md') => {
      const [l] = extractLinks(`[[${t}]]`);
      return resolveLink(l, from, files);
    };
    expect(r('예시/운영체제/pages/스케줄링')?.path).toBe('예시/운영체제/pages/스케줄링.md');
    expect(r('운영체제/pages/스케줄링')?.path).toBe('예시/운영체제/pages/스케줄링.md');
    expect(r('자료구조.mm#^x7y8')).toEqual({ path: '예시/자료구조.mm.md', nodeId: 'x7y8' });
    expect(r('필수단어.mm')?.path).toBe('영어/필수단어.mm.md');
    expect(r('없는파일')).toBeNull();
    // 같은 이름이 둘이면 가까운 쪽
    expect(r('스케줄링', '영어/필수단어.mm.md')?.path).toBe('영어/pages/스케줄링.md');
    expect(r('스케줄링', '예시/운영체제.mm.md')?.path).toBe('예시/운영체제/pages/스케줄링.md');
    expect(r('#^root')).toEqual({ path: '예시/운영체제.mm.md', nodeId: 'root' });
    expect(r('../영어/필수단어.mm')?.path).toBe('영어/필수단어.mm.md');
  });

  it('rewrites links and computes helper paths', () => {
    const out = rewriteLinks('a [[x|L]] b [[y#^n]]', (l) => (l.target === 'x' ? `[[z|${l.label}]]` : null));
    expect(out).toBe('a [[z|L]] b [[y#^n]]');
    expect(linkTargetFor('a/b.mm.md')).toBe('a/b.mm');
    expect(linkTargetFor('a/p.md')).toBe('a/p');
    expect(assetsDirFor('예시/운영체제.mm.md')).toBe('예시/운영체제/assets');
    expect(assetsDirFor('예시/운영체제/pages/p.md')).toBe('예시/운영체제/assets');
    expect(relativePath('예시/운영체제/pages', '예시/운영체제/assets/a.png')).toBe('../assets/a.png');
  });
});
