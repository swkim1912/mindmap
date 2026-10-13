import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCards, getTags, importMarkdown, looksLikeMapFormat, parseMap, serializeMap, type MapNode } from '../src';

const AI_MAP = `---
title: 운영체제
---

# 운영체제

- 프로세스 {tags=시험}
  > 📌 스레드는 스택만 따로 가진다.
  - 프로세스 :: 실행 중인 프로그램
  - 선점형: ==RR==, SRTF
- 메모리
`;

const PLAIN = `# 과목

## 1장
- 가
  - 가-1
- 나
`;

describe('looksLikeMapFormat', () => {
  it('포스트잇, 속성, 노드 ID, 루트 ID, 맵 frontmatter 중 하나라도 있으면 맵 형식', () => {
    expect(looksLikeMapFormat(AI_MAP)).toBe(true);
    expect(looksLikeMapFormat('# 제목 ^root\n- a\n')).toBe(true);
    expect(looksLikeMapFormat('# 제목\n- a ^k3d9\n')).toBe(true);
    expect(looksLikeMapFormat('# 제목\n- a {color=red}\n')).toBe(true);
    expect(looksLikeMapFormat('---\nid: map_x\n---\n# 제목\n- a\n')).toBe(true);
    expect(looksLikeMapFormat('---\nlayout: logic-right\n---\n# 제목\n- a\n')).toBe(true);
  });
  it('평범한 제목·목록 마크다운은 아니다', () => {
    expect(looksLikeMapFormat(PLAIN)).toBe(false);
    expect(looksLikeMapFormat('---\ntitle: 페이지\n---\n# 제목\n- 수식 $x^2$ 와 E = mc ^2\n- 중괄호 {a} 중간\n')).toBe(false);
  });
});

describe('importMarkdown', () => {
  it('AI 가 쓴 맵 형식은 .md 여도 태그·메모·카드가 그대로 살아난다', () => {
    const r = importMarkdown(AI_MAP, '이름');
    expect(r.mode).toBe('map');
    expect(r.warnings).toBe(0);
    const proc = r.doc.root.children[0];
    expect(getTags(proc)).toEqual(['시험']);
    expect(proc.note).toBe('📌 스레드는 스택만 따로 가진다.'.replace('📌 ', ''));
    expect(buildCards(r.doc)).toHaveLength(2);
    expect(r.doc.meta.title).toBe('운영체제');
    expect(String(r.doc.meta.id)).toMatch(/^map_/);
  });
  it('가져온 맵은 직렬화해서 다시 읽어도 경고가 없고 모든 노드에 ID 가 있다', () => {
    const doc = importMarkdown(AI_MAP).doc;
    const again = parseMap(serializeMap(doc));
    expect(again.warnings).toEqual([]);
    const ids: string[] = [];
    const walk = (n: MapNode) => (ids.push(n.id), n.children.forEach(walk));
    walk(again.doc.root);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('일반 제목·목록은 구조만 가져온다', () => {
    const r = importMarkdown(PLAIN, '힌트');
    expect(r.mode).toBe('outline');
    expect(r.doc.root.text).toBe('과목');
    expect(r.doc.root.children[0].children.map((c) => c.text)).toEqual(['가', '나']);
  });
  it('forceMap: 형식 단서가 없어도 맵 형식으로 읽는다 (.mm.md 파일)', () => {
    expect(importMarkdown('# 제목\n\n- 가\n  - 나\n', '힌트', true).mode).toBe('map');
  });
  it('제목이 없으면 루트 글자나 힌트를 쓴다', () => {
    expect(importMarkdown('# 루트 ^root\n- a\n', '힌트').doc.meta.title).toBe('루트');
  });
});

/** AI 가이드 문서(docs/AI-GUIDE.md)의 완성 예시는 실제로 오류 없이 읽혀야 한다 */
describe('docs/AI-GUIDE.md', () => {
  const guide = fs.readFileSync(path.resolve(__dirname, '../../../docs/AI-GUIDE.md'), 'utf8');
  const blocks = [...guide.matchAll(/````markdown\r?\n([\s\S]*?)\r?\n````/g)].map((m) => m[1]);

  it('완성 예시 블록이 있다', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it.each(blocks.map((b, i) => [i + 1, b] as const))('예시 %i 은 경고 없이 맵으로 읽히고 맵 형식으로 인식된다', (_i, src) => {
    expect(looksLikeMapFormat(src)).toBe(true);
    const r = importMarkdown(src);
    expect(r.mode).toBe('map');
    expect(r.warnings).toBe(0);
    const again = parseMap(serializeMap(r.doc));
    expect(again.warnings).toEqual([]);
    expect(r.doc.root.children.length).toBeGreaterThan(1);
  });

  it('첫 번째 예시에는 카드(질문 :: 답, 빈칸), 태그, 메모, 링크가 모두 들어 있다', () => {
    const doc = importMarkdown(blocks[0]).doc;
    const cards = buildCards(doc);
    expect(cards.some((c) => c.kind === 'qa')).toBe(true);
    expect(cards.some((c) => c.kind === 'cloze')).toBe(true);
    const all: MapNode[] = [];
    const walk = (n: MapNode) => (all.push(n), n.children.forEach(walk));
    walk(doc.root);
    expect(all.some((n) => getTags(n).length > 0)).toBe(true);
    expect(all.some((n) => n.note)).toBe(true);
    expect(all.some((n) => n.attrs.color)).toBe(true);
  });

  it('두 번째 예시(6단계 정리)는 레벨 5까지 내려가고 레벨을 건너뛰지 않으며, 절차·부연·약어 병기가 들어 있다', () => {
    const doc = importMarkdown(blocks[1]).doc;
    expect(doc.meta.title).toBe('10주차: 객관적 성격검사');
    expect(doc.meta.layout).toBe('logic-right');
    let maxDepth = 0;
    const texts: string[] = [];
    const walk = (n: MapNode, depth: number) => {
      maxDepth = Math.max(maxDepth, depth);
      texts.push(n.text);
      expect(n.text.trim(), '빈 노드가 없어야 한다').not.toBe('');
      n.children.forEach((c) => walk(c, depth + 1));
    };
    walk(doc.root, 0);
    expect(maxDepth).toBe(5); // 레벨 0(루트) ~ 레벨 5
    expect(texts.some((t) => t.startsWith('1) 타당도 확인'))).toBe(true);
    expect(texts.some((t) => t.includes('\n(T점수 65는'))).toBe(true); // 같은 노드 안 줄바꿈
    expect(texts).toContain('자극추구(Novelty Seeking)');
    // 나열 분리: "4개 기질 척도로 구성" 아래에 4개가 각각 노드
    const group = (() => {
      let found: MapNode | null = null;
      const find = (n: MapNode) => (n.text === '4개 기질 척도로 구성' ? (found = n) : n.children.forEach(find));
      find(doc.root);
      return found as MapNode | null;
    })();
    expect(group?.children).toHaveLength(4);
  });

  it('가이드의 핵심 지시(전체 보존·6단계·분할 출력·누락 점검·제목 콜론)가 빠지지 않았다', () => {
    for (const phrase of ['전체 보존', '6단계 논리구조', '요약하지', '나눠서 출력', '누락 점검 보고', '큰따옴표로 감싸', '레벨을 건너뛰지']) {
      expect(guide, phrase).toContain(phrase);
    }
    // 옛 규칙(노드는 짧게, 가지 5~9개, 깊이 3~4단계)은 전체 보존 원칙과 충돌하므로 남아 있으면 안 된다
    for (const old of ['30자 안팎', '5~9개', '깊이 3~4단계']) expect(guide, old).not.toContain(old);
  });
});
