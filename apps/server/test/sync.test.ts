import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PutRow, Remote, RemoteRow, SyncEngine } from '@mindmap/core';
import { createSyncEngine, hashBytes } from '../src/sync';
import { computeImpact, listTrash, purgeExpiredLocal, purgeTrash, restoreTrash } from '../src/trash';
import { Indexer } from '../src/indexer';
import { Vault } from '../src/vault';

/** 메모리에 두는 가짜 클라우드. updated_at 은 호출 순서대로 늘어나는 값 */
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
  blobName(hash: string, ext: string) {
    return `me/${hash}${ext}`;
  }
  async uploadBlob(name: string, bytes: Uint8Array) {
    this.blobs.set(name, bytes);
  }
  async downloadBlob(name: string) {
    const b = this.blobs.get(name);
    if (!b) throw new Error('없는 객체');
    return b;
  }
  /** 다른 기기(모바일)가 올린 것처럼 행을 바꾼다 */
  edit(rel: string, content: string) {
    return this.put({ path: rel, content, blob: null, hash: hashBytes(content), deleted: false });
  }
}

let root: string;
let vault: Vault;
let remote: FakeRemote;
let engine: SyncEngine;

const file = (rel: string) => path.join(root, ...rel.split('/'));
async function put(rel: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(file(rel)), { recursive: true });
  await fs.writeFile(file(rel), content);
}
const read = (rel: string) => fs.readFile(file(rel), 'utf8');
const exists = (rel: string) =>
  fs.access(file(rel)).then(
    () => true,
    () => false,
  );

const MAP = `---\nid: m1\ntitle: 맵\n---\n\n# 맵 ^root\n\n- 가 ^a\n- 나 ^b\n`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-sync-'));
  vault = new Vault(root);
  remote = new FakeRemote();
  engine = createSyncEngine(vault, remote);
});

describe('SyncEngine', () => {
  it('로컬 파일을 올리고, 이미지는 Storage 로 보낸다', async () => {
    await put('과목/맵.mm.md', MAP);
    await put('과목/맵/assets/a.png', Buffer.from([1, 2, 3, 4]));
    const st = await engine.run();
    expect(st.state).toBe('idle');
    expect(st.pushed).toBe(3); // 맵, 이미지, 빈 폴더 목록
    expect(remote.rows.get('과목/맵.mm.md')?.content).toBe(MAP);
    const img = remote.rows.get('과목/맵/assets/a.png')!;
    expect(img.content).toBeNull();
    expect(Buffer.from(remote.blobs.get(img.blob!)!)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('변화가 없으면 두 번째는 아무것도 하지 않는다', async () => {
    await put('맵.mm.md', MAP);
    await engine.run();
    const st = await engine.run();
    expect(st.pushed + st.pulled + st.merged).toBe(0);
  });

  it('클라우드의 새 파일과 수정을 받아 온다', async () => {
    await put('맵.mm.md', MAP);
    await engine.run();
    await remote.edit('맵.mm.md', MAP.replace('- 나 ^b', '- 나(수정) ^b'));
    await remote.edit('새.md', '# 새 페이지\n');
    const st = await engine.run();
    expect(st.pulled).toBe(2);
    expect(await read('맵.mm.md')).toContain('나(수정)');
    expect(await read('새.md')).toBe('# 새 페이지\n');
  });

  it('삭제를 서로 전달한다 (받는 쪽은 휴지통으로)', async () => {
    await put('a.md', 'A');
    await put('b.md', 'B');
    await engine.run();
    await fs.rm(file('a.md'));
    await engine.run();
    expect(remote.rows.get('a.md')?.deleted).toBe(true);

    await remote.put({ path: 'b.md', content: null, blob: null, hash: '', deleted: true });
    await engine.run();
    expect(await exists('b.md')).toBe(false);
    expect(await exists('.mindmap/trash')).toBe(true);
  });

  it('양쪽에서 다른 노드를 고치면 노드 단위로 병합한다', async () => {
    await put('맵.mm.md', MAP);
    await engine.run();
    await put('맵.mm.md', MAP.replace('- 가 ^a', '- 가(PC) ^a'));
    await remote.edit('맵.mm.md', MAP.replace('- 나 ^b', '- 나(모바일) ^b'));
    const st = await engine.run();
    expect(st.merged).toBe(1);
    expect(st.conflicts).toBe(0);
    const merged = await read('맵.mm.md');
    expect(merged).toContain('가(PC)');
    expect(merged).toContain('나(모바일)');
    expect(remote.rows.get('맵.mm.md')?.content).toBe(merged);
  });

  it('같은 노드를 양쪽에서 고치면 로컬을 남기고 클라우드 내용은 충돌 사본으로 보존한다', async () => {
    await put('맵.mm.md', MAP);
    await engine.run();
    await put('맵.mm.md', MAP.replace('- 가 ^a', '- 가-PC ^a'));
    await remote.edit('맵.mm.md', MAP.replace('- 가 ^a', '- 가-모바일 ^a'));
    const st = await engine.run();
    expect(st.conflicts).toBe(1);
    expect(await read('맵.mm.md')).toContain('가-PC');
    expect(await read('맵 (충돌 사본).mm.md')).toContain('가-모바일');
  });

  it('일반 페이지가 양쪽에서 바뀌면 로컬을 남기고 사본을 만든다', async () => {
    await put('p.md', '원본');
    await engine.run();
    await put('p.md', 'PC에서');
    await remote.edit('p.md', '모바일에서');
    await engine.run();
    expect(await read('p.md')).toBe('PC에서');
    expect(await read('p (충돌 사본).md')).toBe('모바일에서');
    expect(remote.rows.get('p.md')?.content).toBe('PC에서');
  });

  it('한쪽은 지우고 다른 쪽은 고쳤으면 고친 쪽을 살린다', async () => {
    await put('p.md', '원본');
    await engine.run();
    await fs.rm(file('p.md'));
    await remote.edit('p.md', '모바일에서 수정');
    await engine.run();
    expect(await read('p.md')).toBe('모바일에서 수정');
  });

  it('상태 파일이 없어도(재설치) 같은 내용이면 변화로 보지 않는다', async () => {
    await put('맵.mm.md', MAP);
    await engine.run();
    await fs.rm(path.join(root, '.mindmap'), { recursive: true, force: true });
    const again = createSyncEngine(vault, remote);
    const st = await again.run();
    expect(st.state).toBe('idle');
    expect(st.conflicts + st.merged).toBe(0);
    expect(await exists('맵 (충돌 사본).mm.md')).toBe(false);
  });

  it('원격 오류는 상태에 기록되고 다음에 다시 시도한다', async () => {
    await put('a.md', 'A');
    const orig = remote.put.bind(remote);
    remote.put = async () => {
      throw new Error('네트워크 오류');
    };
    let st = await engine.run();
    expect(st.state).toBe('error');
    remote.put = orig;
    st = await engine.run();
    expect(st.state).toBe('idle');
    expect(remote.rows.get('a.md')?.content).toBe('A');
  });

  it('복습 기록(study.json)은 카드별로 더 최근 기록을 채택해 합친다', async () => {
    const rec = (n: number, last: string) => ({ reviews: n, correct: n, streak: n, last, lastKnown: true });
    const pc = { 'a.mm.md': { x: rec(1, '2026-01-01'), y: rec(5, '2026-03-01') } };
    const mobile = { 'a.mm.md': { x: rec(3, '2026-02-01'), z: rec(2, '2026-02-02') } };
    await put('.mindmap/study.json', JSON.stringify({ 'a.mm.md': { x: rec(1, '2026-01-01') } }));
    await engine.run();
    expect(remote.rows.get('.mindmap/study.json')).toBeTruthy();
    await put('.mindmap/study.json', JSON.stringify(pc));
    await remote.edit('.mindmap/study.json', JSON.stringify(mobile));
    await engine.run();
    const merged = JSON.parse(await read('.mindmap/study.json'))['a.mm.md'];
    expect(merged.x.reviews).toBe(3); // 모바일 기록이 더 최근
    expect(merged.y.reviews).toBe(5); // PC 에만 있음
    expect(merged.z.reviews).toBe(2); // 모바일에만 있음
  });

  it('이상한 경로의 행은 무시한다', async () => {
    await remote.edit('../밖.md', 'x');
    await remote.edit('.hidden/a.md', 'x');
    const st = await engine.run();
    expect(st.state).toBe('idle');
    expect(st.pulled).toBe(0);
  });
});

describe('휴지통과 폴더 동기화', () => {
  let root2: string;
  let vault2: Vault;
  let engine2: SyncEngine;
  const file2 = (rel: string) => path.join(root2, ...rel.split('/'));
  const exists2 = (rel: string) => fs.access(file2(rel)).then(() => true, () => false);

  beforeEach(async () => {
    root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-sync2-'));
    vault2 = new Vault(root2);
    engine2 = createSyncEngine(vault2, remote);
  });

  it('앱에서 지우면 내용과 묶음 ID 가 함께 올라가고, 다른 기기 휴지통에도 같은 묶음으로 들어간다', async () => {
    await put('과목/맵.mm.md', MAP);
    await put('과목/맵/pages/p.md', '# 페이지');
    await engine.run();
    await engine2.run();
    expect(await read('과목/맵.mm.md')).toBe(MAP);

    const id = await vault.trash('과목/맵.mm.md'); // 맵과 딸린 폴더가 한 묶음
    await engine.run();
    const row = remote.rows.get('과목/맵.mm.md')!;
    expect(row.deleted).toBe(true);
    expect(row.trash_id).toBe(id);
    expect(row.content).toBe(MAP); // 내용이 남아 있어야 복원할 수 있다
    expect(remote.rows.get('과목/맵/pages/p.md')?.trash_id).toBe(id);

    await engine2.run();
    expect(await exists2('과목/맵.mm.md')).toBe(false);
    const groups = await listTrash(vault2);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id, path: '과목/맵.mm.md', kind: 'map', maps: 1, pages: 1 });
  });

  it('이 기기에 원래 없던 파일도 삭제 표시의 내용으로 휴지통에 보관된다', async () => {
    await put('a.mm.md', MAP);
    await engine.run();
    await vault.trash('a.mm.md');
    await engine.run();
    await engine2.run(); // 처음 받는 기기
    expect(await exists2('a.mm.md')).toBe(false);
    const groups = await listTrash(vault2);
    expect(groups).toHaveLength(1);
    const r = await restoreTrash(vault2, groups[0].id);
    expect(r).toEqual({ path: 'a.mm.md', renamed: false });
    expect(await fs.readFile(file2('a.mm.md'), 'utf8')).toBe(MAP);
  });

  it('복원하면 다시 올라가고 삭제 표시가 풀린다', async () => {
    await put('a.mm.md', MAP);
    await engine.run();
    const id = await vault.trash('a.mm.md');
    await engine.run();
    await restoreTrash(vault, id);
    await engine.run();
    const row = remote.rows.get('a.mm.md')!;
    expect(row.deleted).toBe(false);
    expect(row.trash_id).toBeNull();
    await engine2.run();
    expect(await fs.readFile(file2('a.mm.md'), 'utf8')).toBe(MAP);
  });

  it('이름 변경(이동)은 다른 기기 휴지통 목록에 나타나지 않는다', async () => {
    await put('a.mm.md', MAP);
    await engine.run();
    await engine2.run();
    await vault.rename('a.mm.md', 'b.mm.md');
    await engine.run();
    await engine2.run();
    expect(await exists2('b.mm.md')).toBe(true);
    expect(await exists2('a.mm.md')).toBe(false);
    expect(await listTrash(vault2)).toEqual([]);
  });

  it('빈 폴더가 다른 기기에 만들어지고, 지우면 따라 지워진다', async () => {
    await fs.mkdir(file('빈 폴더/하위'), { recursive: true });
    await put('채워진/맵.mm.md', MAP);
    await engine.run();
    expect(JSON.parse(remote.rows.get('.mindmap/folders.json')!.content!)).toEqual(['빈 폴더', '빈 폴더/하위']);
    await engine2.run();
    expect(await exists2('빈 폴더/하위')).toBe(true);

    await fs.rm(file('빈 폴더'), { recursive: true });
    await engine.run();
    await engine2.run();
    expect(await exists2('빈 폴더')).toBe(false);
    expect(await exists2('채워진/맵.mm.md')).toBe(true);
  });

  it('맵에 딸린 빈 폴더는 빈 폴더 목록에 넣지 않는다', async () => {
    await put('맵.mm.md', MAP);
    await fs.mkdir(file('맵/assets'), { recursive: true });
    await engine.run();
    expect(JSON.parse(remote.rows.get('.mindmap/folders.json')!.content!)).toEqual([]);
  });
});

describe('휴지통 관리', () => {
  it('같은 이름이 이미 있으면 (복원) 을 붙이고, 묶음을 영구 삭제하며, 기한이 지난 것은 정리한다', async () => {
    await put('맵.mm.md', MAP);
    await put('맵/assets/a.png', Buffer.from([1]));
    const id = await vault.trash('맵.mm.md');
    await put('맵.mm.md', '# 새로 만든 같은 이름 ^root\n'); // 같은 이름이 생김
    const r = await restoreTrash(vault, id);
    expect(r).toEqual({ path: '맵 (복원).mm.md', renamed: true });
    expect(await exists('맵 (복원)/assets/a.png')).toBe(true);
    expect(await read('맵.mm.md')).toContain('새로 만든');

    const id2 = await vault.trash('맵 (복원).mm.md');
    expect(await listTrash(vault)).toHaveLength(1);
    await purgeTrash(vault, [id2]);
    expect(await listTrash(vault)).toHaveLength(0);

    const old = '2020-01-01T00-00-00-000Z';
    await vault.trash('맵.mm.md', old);
    expect(await purgeExpiredLocal(vault)).toBe(1);
  });

  it('삭제 전 영향: 함께 없어지는 파일 수와 외부에서 오는 링크', async () => {
    await put('과목/운영체제.mm.md', '# 운영체제 ^root\n- 스케줄링 [[과목/운영체제/pages/스케줄링]] ^s1\n');
    await put('과목/운영체제/pages/스케줄링.md', '내용');
    await put('과목/운영체제/assets/a.png', Buffer.from([1]));
    await put('다른.mm.md', '# 다른 ^root\n- 연결 [[과목/운영체제.mm]] ^x1\n');
    const idx = new Indexer(vault);
    await idx.start();
    const imp = await computeImpact(vault, idx, '과목/운영체제.mm.md');
    expect(imp).toMatchObject({ kind: 'map', maps: 1, pages: 1, images: 1 });
    expect(imp.links.count).toBe(1); // 맵 안에서 자기 페이지를 가리키는 링크는 세지 않음
    expect(imp.links.sources[0].path).toBe('다른.mm.md');
    const folder = await computeImpact(vault, idx, '과목');
    expect(folder).toMatchObject({ kind: 'folder', maps: 1, pages: 1, images: 1 });
    expect(folder.links.count).toBe(1);
  });
});
