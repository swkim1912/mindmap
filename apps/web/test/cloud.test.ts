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

  it('PC 전용 기능(이전 버전)은 모바일에서 막혀 있다', async () => {
    await expect(b.api.restore('a', 'b', null)).rejects.toThrow('PC에서');
    expect(b.canManage).toBe(false);
  });

  it('buildTree 는 맵이 없는 폴더를 만들지 않고 정렬한다', () => {
    const t = buildTree(['z.mm.md', 'f/b.mm.md', 'f/a.mm.md', 'f/a/pages/p.md']);
    expect(t.map((e) => e.name)).toEqual(['f', 'z']);
    expect(t[0].children?.map((e) => e.name)).toEqual(['a', 'b']);
  });

  describe('폴더·이름 변경·휴지통', () => {
    const MAPSRC = (t: string, extra = '') => `# ${t} ^root\n\n- 가 ^a\n${extra}`;

    it('빈 폴더를 만들면 트리에 보이고 동기화 목록에 올라가며, 맵을 넣으면 목록에서 빠진다', async () => {
      await b.api.createFolder('과목/새 폴더');
      let tree = await b.api.tree();
      expect(tree[0]).toMatchObject({ name: '과목', kind: 'dir' });
      expect(tree[0].children![0]).toMatchObject({ name: '새 폴더', kind: 'dir', children: [] });
      await b.engine.run();
      expect(JSON.parse(remote.rows.get('.mindmap/folders.json')!.content!)).toEqual(['과목/새 폴더']);
      await b.api.createMap('과목/새 폴더', '맵');
      await b.engine.run();
      expect(JSON.parse(remote.rows.get('.mindmap/folders.json')!.content!)).toEqual([]);
      tree = await b.api.tree();
      expect(tree[0].children![0].children![0].kind).toBe('map');
    });

    it('잘못된 폴더 이름과 중복은 거절한다', async () => {
      await expect(b.api.createFolder('a:b')).rejects.toThrow('쓸 수 없습니다');
      await b.api.createFolder('x');
      await expect(b.api.createFolder('x')).rejects.toMatchObject({ status: 409 });
    });

    it('맵 이름을 바꾸면 딸린 파일·다른 맵의 링크·복습 기록이 따라간다', async () => {
      await b.api.createMap('', '원본');
      const a = await b.api.read('원본.mm.md');
      await b.api.write('원본.mm.md', MAPSRC('원본'), a.hash);
      await b.api.createPage('원본/pages/p.md', '페이지');
      await b.api.createMap('', '다른');
      const o = await b.api.read('다른.mm.md');
      await b.api.write('다른.mm.md', MAPSRC('다른', '- 연결 [[원본.mm#^a]] ^l1' + '\n'), o.hash);
      await b.api.recordStudy('원본.mm.md', [{ id: 'a', known: true }]);
      await b.engine.run(); // 한 번 동기화된 뒤의 이동이어야 삭제 표시가 올라간다

      await b.api.rename('원본.mm.md', '새이름.mm.md');
      const paths = (await b.api.files()).sort();
      expect(paths).toEqual(['다른.mm.md', '새이름.mm.md', '새이름/pages/p.md']);
      expect((await b.api.read('다른.mm.md')).content).toContain('[[새이름.mm#^a]]');
      expect((await b.api.study('새이름.mm.md')).a.reviews).toBe(1);
      await expect(b.api.read('원본.mm.md')).rejects.toMatchObject({ status: 404 });
      await b.engine.run();
      expect(remote.rows.get('원본.mm.md')?.deleted).toBe(true);
      expect(remote.rows.get('새이름.mm.md')?.deleted).toBe(false);
      expect(remote.rows.get('원본/pages/p.md')?.trash_id).toBeNull(); // 이동은 휴지통 항목이 아니다
    });

    it('폴더를 옮기고, 이미 있는 이름이나 자기 안으로의 이동은 거절한다', async () => {
      await b.api.createMap('과목', '맵1');
      await b.api.createMap('과목/하위', '맵2');
      await b.api.createFolder('보관');
      await b.api.rename('과목', '보관/과목');
      expect((await b.api.files()).sort()).toEqual(['보관/과목/맵1.mm.md', '보관/과목/하위/맵2.mm.md']);
      await b.api.createMap('', '충돌');
      await expect(b.api.rename('보관', '보관/과목/보관')).rejects.toMatchObject({ status: 400 });
      await b.api.createMap('', '충돌2');
      await expect(b.api.rename('충돌2.mm.md', '충돌.mm.md')).rejects.toMatchObject({ status: 409 });
      await expect(b.api.rename('충돌2.mm.md', 'a:b.mm.md')).rejects.toMatchObject({ status: 400 });
    });

    it('삭제하면 휴지통으로 가고, 클라우드에 내용과 묶음 ID 가 올라가며, 복원하면 돌아온다', async () => {
      const { path } = await b.api.createMap('과목', '지울맵');
      const r = await b.api.read(path);
      await b.api.write(path, MAPSRC('지울맵'), r.hash);
      await b.api.createPage('과목/지울맵/pages/p.md', '페이지');
      await b.engine.run();
      const { trashId } = await b.api.trash(path);
      expect(trashId).toBeTruthy();
      expect(await b.api.files()).toEqual([]);

      const list = await b.api.trashList();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: trashId, path, kind: 'map', maps: 1, pages: 1 });

      await b.engine.run();
      const row = remote.rows.get(path)!;
      expect(row).toMatchObject({ deleted: true, trash_id: trashId });
      expect(row.content).toContain('지울맵');

      const back = await b.api.trashRestore(trashId);
      expect(back).toEqual({ path, renamed: false });
      expect((await b.api.read(path)).content).toContain('지울맵');
      expect(await b.api.trashList()).toEqual([]);
      await b.engine.run();
      expect(remote.rows.get(path)).toMatchObject({ deleted: false, trash_id: null });
    });

    it('영구 삭제하면 목록에서 사라지고 클라우드 정리를 요청한다', async () => {
      const purged: string[][] = [];
      remote.purgeTrash = async (ids) => void purged.push(ids);
      const { path } = await b.api.createMap('', '맵');
      const { trashId } = await b.api.trash(path);
      await b.api.trashPurge({ id: trashId });
      expect(await b.api.trashList()).toEqual([]);
      await expect(b.api.trashRestore(trashId)).rejects.toMatchObject({ status: 404 });
      expect(purged).toEqual([[trashId]]);
    });

    it('다른 기기에서 지운 파일은 이 기기 휴지통에도 나타나 복원할 수 있다', async () => {
      const ID = '2099-01-01T00-00-00-000Z';
      const content = MAPSRC('남이 지움');
      await remote.put({ path: '남.mm.md', content, blob: null, hash: 'zz', deleted: true, trash_id: ID });
      await b.engine.run();
      expect(await b.api.files()).toEqual([]);
      const list = await b.api.trashList();
      expect(list.map((g) => g.path)).toEqual(['남.mm.md']);
      await b.api.trashRestore(ID);
      expect((await b.api.read('남.mm.md')).content).toBe(content);
    });

    it('삭제 전에 함께 없어지는 항목과 끊어질 링크를 알려 준다', async () => {
      await b.api.createMap('', '대상');
      await b.api.createPage('대상/pages/p.md', '페이지');
      await b.api.createMap('', '참조');
      const o = await b.api.read('참조.mm.md');
      await b.api.write('참조.mm.md', MAPSRC('참조', '- 연결 [[대상.mm]] ^l1' + '\n'), o.hash);
      const imp = await b.api.impact('대상.mm.md');
      expect(imp).toMatchObject({ kind: 'map', maps: 1, pages: 1 });
      expect(imp.links).toEqual({ count: 1, sources: [{ path: '참조.mm.md', title: expect.any(String) }] });
    });
  });
});
