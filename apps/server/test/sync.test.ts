import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PutRow, Remote, RemoteRow, SyncEngine } from '@mindmap/core';
import { createSyncEngine, hashBytes } from '../src/sync';
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
    expect(st.pushed).toBe(2);
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
