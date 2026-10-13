import { describe, expect, it } from 'vitest';
import {
  buildCards,
  fromMarkdownOutline,
  fromOpml,
  fromXMindContent,
  parseMap,
  serializeMap,
  toAnkiCsv,
  toFreeMind,
  toOpml,
  toXMindFiles,
} from '../src';

const SRC = `---
id: map_t
title: 운영체제
layout: mindmap
---

# 운영체제 ^root

- 프로세스 {tags=시험,중요} ^a
  > 📌 스레드는 스택만 따로 가진다.
  > 둘째 줄 "따옴표" & <태그>
  - 프로세스 :: 실행 중인 프로그램 ^b
  - 선점형: ==RR==, SRTF ^c
- 메모리 ^d
`;
const doc = parseMap(SRC).doc;

type N = { text: string; note: string | null; attrs: Record<string, unknown>; children: N[] };
const strip = (n: N): unknown => ({ t: n.text, note: n.note, tags: n.attrs.tags ?? null, c: n.children.map(strip) });

describe('OPML', () => {
  it('내보낸 뒤 다시 가져오면 구조·메모·태그가 같다', () => {
    const back = fromOpml(toOpml(doc));
    expect(strip(back.root as N)).toEqual(strip(doc.root as N));
    expect(back.meta.title).toBe('운영체제');
  });
  it('최상위가 여러 개면 제목을 루트로 삼는다', () => {
    const d = fromOpml('<opml><head><title>할 일</title></head><body><outline text="가"/><outline text="나"><outline text="다 &amp; 라"/></outline></body></opml>');
    expect(d.root.text).toBe('할 일');
    expect(d.root.children.map((c) => c.text)).toEqual(['가', '나']);
    expect(d.root.children[1].children[0].text).toBe('다 & 라');
  });
  it('outline 이 없으면 오류', () => {
    expect(() => fromOpml('<opml><body></body></opml>')).toThrow();
  });
  it('가져온 맵은 직렬화 후 다시 파싱해도 노드 ID 가 유일하다', () => {
    const d = fromOpml(toOpml(doc));
    const again = parseMap(serializeMap(d));
    expect(again.warnings).toEqual([]);
    const ids: string[] = [];
    const walk = (n: N & { id: string }) => (ids.push(n.id), n.children.forEach((c) => walk(c as never)));
    walk(again.doc.root as never);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('XMind', () => {
  it('content.json 으로 내보내고 가져오면 같다', () => {
    const files = toXMindFiles(doc);
    expect(Object.keys(files).sort()).toEqual(['content.json', 'manifest.json', 'metadata.json']);
    const [back] = fromXMindContent(files['content.json']);
    expect(strip(back.root as N)).toEqual(strip(doc.root as N));
  });
  it('여러 시트를 각각의 맵으로', () => {
    const json = JSON.stringify([
      { title: 'A', rootTopic: { title: 'A', children: { attached: [{ title: 'a1' }] } } },
      { title: 'B', rootTopic: { title: 'B' } },
    ]);
    const docs = fromXMindContent(json);
    expect(docs.map((d) => d.meta.title)).toEqual(['A', 'B']);
    expect(docs[0].root.children[0].text).toBe('a1');
  });
  it('이상한 파일은 오류', () => {
    expect(() => fromXMindContent('not json')).toThrow();
    expect(() => fromXMindContent('{}')).toThrow();
  });
});

describe('FreeMind', () => {
  it('XML 특수문자를 이스케이프하고 좌우로 나눈다', () => {
    const xml = toFreeMind(doc);
    expect(xml).toContain('<map version="1.0.1">');
    expect(xml).toContain('TEXT="프로세스 :: 실행 중인 프로그램"');
    expect(xml).toContain('&quot;따옴표&quot; &amp; &lt;태그&gt;');
    expect(xml).toContain('POSITION="right"');
    expect(xml).toContain('POSITION="left"');
  });
});

describe('Markdown 가져오기', () => {
  it('제목과 목록을 단계로 바꾼다', () => {
    const d = fromMarkdownOutline('# 과목\n\n## 1장\n- 가\n  - 가-1\n- 나\n\n## 2장\n본문 설명입니다.\n- 다\n');
    expect(d.root.text).toBe('과목');
    const [c1, c2] = d.root.children;
    expect(c1.text).toBe('1장');
    expect(c1.children.map((c) => c.text)).toEqual(['가', '나']);
    expect(c1.children[0].children[0].text).toBe('가-1');
    expect(c2.note).toBe('본문 설명입니다.');
    expect(c2.children[0].text).toBe('다');
  });
  it('제목 없는 목록은 힌트를 루트로, 4칸 들여쓰기와 번호 목록도 읽는다', () => {
    const d = fromMarkdownOutline('1. 가\n    - 가1\n2. 나\n', '메모');
    expect(d.root.text).toBe('메모');
    expect(d.root.children.map((c) => c.text)).toEqual(['가', '나']);
    expect(d.root.children[0].children[0].text).toBe('가1');
  });
  it('내용이 없으면 오류', () => {
    expect(() => fromMarkdownOutline('\n\n')).toThrow();
  });
});

describe('Anki CSV', () => {
  it('앞면·뒷면·태그를 탭으로 구분하고 빈칸은 굵게', () => {
    const csv = toAnkiCsv(buildCards(doc));
    const lines = csv.trim().split('\n');
    expect(lines.slice(0, 3)).toEqual(['#separator:tab', '#html:true', '#tags column:3']);
    expect(lines).toHaveLength(3 + 2);
    const qa = lines.find((l) => l.includes('실행 중인 프로그램'))!;
    expect(qa.split('\t')).toHaveLength(3);
    expect(qa).toContain('시험 중요');
    const cloze = lines.find((l) => l.includes('<b>RR</b>'))!;
    expect(cloze).toContain('[ … ]');
  });
});
