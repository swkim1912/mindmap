import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { zipSync, strToU8 } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseMap, toOpml, toXMindFiles, type PutRow, type Remote, type RemoteRow } from '@mindmap/core';
import { api, setBackend } from '../src/api';
import { buildCloudBackend } from '../src/cloud/cloudBackend';
import { parseImport, safeName, saveImported } from '../src/portable';
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
});
