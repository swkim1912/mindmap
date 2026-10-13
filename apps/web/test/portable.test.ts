import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { zipSync, strToU8 } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseMap, toOpml, toXMindFiles, type PutRow, type Remote, type RemoteRow } from '@mindmap/core';
import { api, setBackend } from '../src/api';
import { buildCloudBackend } from '../src/cloud/cloudBackend';
import { parseImport, parseImportDetailed, parseImportText, safeName, saveImported, stripOuterFence } from '../src/portable';
import { mapToSvg } from '../src/svgExport';

class NullRemote implements Remote {
  async listSince(): Promise<RemoteRow[]> {
    return [];
  }
  async put(_r: PutRow) {}
  blobName = (h: string, e: string) => h + e;
  async uploadBlob() {}
  async downloadBlob(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

const SRC = `---
id: map_t
title: 운영체제
layout: logic-right
---

# 운영체제 ^root

- 프로세스 ^a
  - 프로세스 :: 실행 중인 프로그램 ^b
  - **굵게** 와 ==빈칸== & <태그> ^c
- 메모리 ^d
`;
const doc = parseMap(SRC).doc;

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  setBackend(await buildCloudBackend(new NullRemote()));
});

describe('SVG 내보내기', () => {
  it('모든 노드의 글자가 들어가고 특수문자가 이스케이프되며 마크다운 기호는 빠진다', () => {
    const { svg, width, height } = mapToSvg(doc);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    for (const t of ['운영체제', '프로세스', '메모리', '굵게 와 빈칸 &amp; &lt;태그&gt;']) expect(svg).toContain(t);
    expect(svg).not.toContain('**');
    expect(svg).not.toContain('==');
    expect(width).toBeGreaterThan(100);
    expect(height).toBeGreaterThan(50);
    expect((svg.match(/<path /g) ?? []).length).toBe(4); // 노드 5개 = 연결선 4개
  });
});

describe('가져오기', () => {
  const file = (name: string, data: string | Uint8Array) => new File([data as BlobPart], name);

  it('XMind 파일을 읽어 맵으로 만들고 저장한다', async () => {
    const files: Record<string, Uint8Array> = {};
    for (const [n, t] of Object.entries(toXMindFiles(doc))) files[n] = strToU8(t);
    const docs = await parseImport(file('공부.xmind', zipSync(files)));
    expect(docs).toHaveLength(1);
    const path = await saveImported('과목', docs[0]);
    expect(path).toBe('과목/운영체제.mm.md');
    const saved = parseMap((await api.read(path)).content);
    expect(saved.warnings).toEqual([]);
    expect(saved.doc.root.children.map((c) => c.text)).toEqual(['프로세스', '메모리']);
  });

  it('같은 이름이 있으면 번호를 붙인다', async () => {
    const [d] = await parseImport(file('a.opml', toOpml(doc)));
    expect(await saveImported('', d)).toBe('운영체제.mm.md');
    expect(await saveImported('', d)).toBe('운영체제 (2).mm.md');
  });

  it('옛 XMind 형식과 알 수 없는 형식은 이유를 알려 준다', async () => {
    await expect(parseImport(file('old.xmind', zipSync({ 'content.xml': strToU8('<x/>') })))).rejects.toThrow('옛 형식');
    await expect(parseImport(file('x.pdf', 'x'))).rejects.toThrow('지원하지 않는');
  });

  it('Markdown 목록 파일은 파일 이름이 맵 이름이 된다', async () => {
    const [d] = await parseImport(file('정리노트.md', '- 가\n  - 나\n'));
    expect(d.root.text).toBe('정리노트');
  });

  it('.mm.md 는 노드 ID 를 유지하고 맵 ID 만 새로 만든다', async () => {
    const [d] = await parseImport(file('운영체제.mm.md', SRC));
    expect(d.meta.id).not.toBe('map_t');
    expect(d.root.children[0].id).toBe('a');
  });

  it('safeName 은 금지 문자를 걷어 낸다', () => {
    expect(safeName('a/b:c*?"<>|d')).toBe('a b c d');
    expect(safeName('...')).toBe('맵');
  });

  it('확장자가 .md 여도 AI 가 쓴 맵 형식이면 태그·메모·카드가 살아난다', async () => {
    const ai = '---\ntitle: AI 맵\n---\n\n# AI 맵\n\n- 가 {tags=시험}\n  > 📌 메모\n  - 용어 :: 설명\n';
    const [r] = await parseImportDetailed(file('ai.md', ai));
    expect(r.mode).toBe('map');
    expect(r.doc.root.children[0].attrs.tags).toBe('시험');
    expect(r.doc.root.children[0].note).toContain('메모');
    const path = await saveImported('', r.doc);
    const saved = parseMap((await api.read(path)).content);
    expect(saved.warnings).toEqual([]);
    expect(saved.doc.root.children[0].children[0].text).toBe('용어 :: 설명');
  });
});

describe('붙여넣기 가져오기', () => {
  const MAP = '# 제목\n\n- 가 {tags=a}\n  - 나\n';
  it('코드블록 울타리가 같이 복사돼도 안쪽만 읽는다', () => {
    expect(stripOuterFence('````markdown\n' + MAP + '\n````')).toBe(MAP);
    expect(stripOuterFence('```\n' + MAP + '\n```\n')).toBe(MAP);
    expect(stripOuterFence(MAP)).toBe(MAP);
    // 안쪽에 백틱 3개짜리 코드블록이 있어도 바깥 4개 울타리만 걷어 낸다
    const inner = '# 제목\n- 가\n  > 📌 코드\n  > ```py\n  > x = 1\n  > ```\n';
    expect(stripOuterFence('````markdown\n' + inner + '````')).toContain('> ```py');
  });
  it('붙여넣은 글을 맵으로 만든다', () => {
    const r = parseImportText('````markdown\n' + MAP + '````');
    expect(r.mode).toBe('map');
    expect(r.doc.meta.title).toBe('제목');
  });
  it('비어 있으면 오류', () => {
    expect(() => parseImportText('   \n ')).toThrow('붙여넣은 내용이 없습니다');
  });
  it('일반 제목·목록을 붙여넣으면 구조만 가져온다', () => {
    expect(parseImportText('## 소제목\n- 가\n- 나\n').mode).toBe('outline');
  });
});
