import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PutRow, Remote, RemoteRow } from '@mindmap/core';
import { ApiError, type VaultEvent } from '../src/api';
import { buildCloudBackend, buildTree, type CloudBackend } from '../src/cloud/cloudBackend';
import { hashBytes } from '../src/cloud/idbStore';

class FakeRemote implements Remote {
  rows = new Map<string, RemoteRow>();
  blobs = new Map<string, Uint8Array>();
  private tick = 0;
  async listSince(cursor: string | null) {
    return [...this.rows.values()].filter((r) => !cursor || r.updated_at > cursor);
  }
  async put(row: PutRow) {
    this.rows.set(row.path, { ...row, updated_at: String(++this.tick).padStart(8, '0') });
  }
  blobName = (hash: string, ext: string) => `me/${hash}${ext}`;
  async uploadBlob(name: string, bytes: Uint8Array) {
    this.blobs.set(name, bytes);
  }
  async downloadBlob(name: string) {
    return this.blobs.get(name)!;
  }
  async edit(path: string, content: string) {
    const hash = await hashBytes(new TextEncoder().encode(content));
    await this.put({ path, content, blob: null, hash, deleted: false });
  }
}

let remote: FakeRemote;
let b: CloudBackend;
let events: VaultEvent[];

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  remote = new FakeRemote();
  b = await buildCloudBackend(remote);
  events = [];
  b.subscribe((e) => events.push(e), () => {});
});

describe('모바일 클라우드 백엔드', () => {
  it('해시가 PC(Node)의 SHA-1 앞 16자리와 같다', async () => {
    expect(await hashBytes(new TextEncoder().encode('abc'))).toBe('a9993e364706816a');
  });

  it('맵을 만들고 저장하면 동기화로 클라우드에 올라간다', async () => {
    const { path } = await b.api.createMap('과목', '운영체제');
    expect(path).toBe('과목/운영체제.mm.md');
    const { content, hash } = await b.api.read(path);
    const next = content.replace('운영체제', '운영체제 수정');
    await b.api.write(path, next, hash);
    await b.engine.run();
    expect(remote.rows.get(path)?.content).toBe(next);
    await expect(b.api.tree()).resolves.toEqual([
      { name: '과목', path: '과목', kind: 'dir', children: [{ name: '운영체제', path: '과목/운영체제.mm.md', kind: 'map' }] },
    ]);
  });

  it('기준 해시가 오래되면 409 와 현재 내용을 돌려준다', async () => {
    const { path } = await b.api.createMap('', '맵');
    const { hash } = await b.api.read(path);
    await b.api.write(path, '# 새 내용 ^root\n', hash);
    const err = await b.api.write(path, '# 또 다른 ^root\n', hash).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.body.content).toBe('# 새 내용 ^root\n');
  });

  it('PC 쪽 변경을 받아 오면 이벤트가 나가고 검색·역링크가 갱신된다', async () => {
    await remote.edit('a.mm.md', '# 가 ^root\n\n- 해시 테이블 ^h1\n');
    await remote.edit('b.mm.md', '# 나 ^root\n\n- 연결 [[a.mm#^h1]] ^x1\n');
    await b.engine.run();
    expect(events.some((e) => e.type === 'tree')).toBe(true);
    expect(events.some((e) => e.type === 'file' && e.path === 'a.mm.md')).toBe(true);
    const hits = await b.api.search('해시');
    expect(hits.some((h) => h.path === 'a.mm.md' && h.nodeId === 'h1')).toBe(true);
    const back = await b.api.backlinks('a.mm.md');
    expect(back.nodes.h1?.[0].path).toBe('b.mm.md');
  });

  it('오프라인 편집과 PC 편집이 다른 노드면 합쳐진다', async () => {
    const base = '---\nid: m\ntitle: 맵\n---\n\n# 맵 ^root\n\n- 가 ^a\n- 나 ^b\n';
    await remote.edit('맵.mm.md', base);
    await b.engine.run();
    const { hash } = await b.api.read('맵.mm.md');
    await b.api.write('맵.mm.md', base.replace('- 가 ^a', '- 가(모바일) ^a'), hash); // 오프라인 편집
    await remote.edit('맵.mm.md', base.replace('- 나 ^b', '- 나(PC) ^b'));
    await b.engine.run();
    const { content } = await b.api.read('맵.mm.md');
    expect(content).toContain('가(모바일)');
    expect(content).toContain('나(PC)');
  });

  it('이미지를 올리면 assets 에 저장되고 상대 경로를 돌려주며 Storage 로 올라간다', async () => {
    const { path } = await b.api.createMap('과목', '맵');
    const ref = await b.api.upload(path, new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' }), 'png');
    expect(ref).toMatch(/^맵\/assets\/.+\.png$|^%/);
    await b.engine.run();
    const img = [...remote.rows.values()].find((r) => r.path.endsWith('.png'))!;
    expect(img.path.startsWith('과목/맵/assets/')).toBe(true);
    expect([...remote.blobs.get(img.blob!)!]).toEqual([9, 8, 7]);
  });

  it('복습 기록이 저장되고 동기화된다', async () => {
    await b.api.recordStudy('a.mm.md', [{ id: 'c1', known: true }]);
    const rec = (await b.api.study('a.mm.md')).c1;
    expect(rec.reviews).toBe(1);
    expect(rec.lastKnown).toBe(true);
    await b.engine.run();
    expect(remote.rows.get('.mindmap/study.json')?.content).toContain('"c1"');
  });

  it('폴더 관리는 모바일에서 막혀 있다', async () => {
    await expect(b.api.rename('a', 'b')).rejects.toThrow('PC에서');
    expect(b.canManage).toBe(false);
  });

  it('buildTree 는 맵이 없는 폴더를 만들지 않고 정렬한다', () => {
    const t = buildTree(['z.mm.md', 'f/b.mm.md', 'f/a.mm.md', 'f/a/pages/p.md']);
    expect(t.map((e) => e.name)).toEqual(['f', 'z']);
    expect(t[0].children?.map((e) => e.name)).toEqual(['a', 'b']);
  });
});
