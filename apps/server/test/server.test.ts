import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Indexer } from '../src/indexer';
import { buildMoveMap, rewriteLinksAfterMove } from '../src/linkmove';
import { StudyStore } from '../src/study';
import { Vault } from '../src/vault';

let root: string;
let vault: Vault;

async function put(rel: string, content: string) {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}
const read = (rel: string) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-vault-'));
  vault = new Vault(root);
  await put(
    '과목/운영체제.mm.md',
    `---\ntitle: 운영체제\n---\n\n# 운영체제 ^root\n\n- 스케줄링 [[과목/운영체제/pages/스케줄링]] {tags=시험} ^s1\n  > 📌 라운드 로빈은 ==시간 할당량== 이 핵심\n- 자료구조 연결 [[자료구조.mm#^h1|해시]] ^s2\n`,
  );
  await put('과목/운영체제/pages/스케줄링.md', `---\ntitle: 스케줄링\n---\n\nFCFS, SJF, RR. 관련: [[자료구조.mm]]\n`);
  await put('과목/자료구조.mm.md', `# 자료구조 ^root\n\n- 해시 테이블 ^h1\n- 트리 ^t1\n`);
  await put('AGENTS.md', '# 설명서 스케줄링\n');
});

describe('Indexer', () => {
  it('indexes maps and pages but not AGENTS.md', async () => {
    const ix = new Indexer(vault);
    void ix.start();
    await ix.ready;
    expect(ix.paths()).toEqual(['과목/운영체제.mm.md', '과목/운영체제/pages/스케줄링.md', '과목/자료구조.mm.md']);
  });

  it('searches node text, notes, page bodies, files and tags', async () => {
    const ix = new Indexer(vault);
    void ix.start();
    await ix.ready;
    const byKind = (q: string) => ix.search(q).map((h) => `${h.kind}:${h.title}`);
    expect(byKind('스케줄링')).toContain('node:스케줄링 스케줄링');
    expect(byKind('스케줄링')).toContain('page:스케줄링');
    expect(byKind('시간 할당량')).toEqual(['node:스케줄링 스케줄링']);
    expect(byKind('SJF')).toEqual(['page:스케줄링']);
    expect(byKind('#시험').length).toBe(1);
    expect(ix.search('').every((h) => h.kind !== 'node')).toBe(true);
  });

  it('finds backlinks to files and to specific nodes', async () => {
    const ix = new Indexer(vault);
    void ix.start();
    await ix.ready;
    const bl = ix.backlinks('과목/자료구조.mm.md');
    expect(bl.nodes.h1.map((s) => s.path)).toEqual(['과목/운영체제.mm.md']);
    expect(bl.nodes.h1[0].nodeText).toBe('자료구조 연결 해시');
    expect(bl.file.map((s) => s.path)).toEqual(['과목/운영체제/pages/스케줄링.md']);
    expect(ix.backlinks('과목/운영체제/pages/스케줄링.md').file.map((s) => s.path)).toEqual(['과목/운영체제.mm.md']);
  });

  it('picks up changes through update()', async () => {
    const ix = new Indexer(vault);
    void ix.start();
    await ix.ready;
    await put('과목/새로.mm.md', '# 새 맵 ^root\n\n- 양자역학 ^q\n');
    await ix.update('과목/새로.mm.md');
    expect(ix.search('양자역학')).toHaveLength(1);
    await fs.rm(path.join(root, '과목', '새로.mm.md'));
    await ix.update('과목/새로.mm.md');
    expect(ix.search('양자역학')).toHaveLength(0);
  });
});

describe('Indexer startup', () => {
  it('starts with an empty index when the vault folder does not exist yet', async () => {
    const ix = new Indexer(new Vault(path.join(root, '아직없음')));
    await ix.start();
    await ix.ready;
    expect(ix.paths()).toEqual([]);
  });
});

describe('Vault.rename', () => {
  it('moves the companion folder together with the map and refuses to overwrite', async () => {
    await vault.rename('과목/운영체제.mm.md', '과목/OS.mm.md');
    expect(await read('과목/OS/pages/스케줄링.md')).toContain('FCFS');
    await expect(vault.rename('과목/OS.mm.md', '과목/자료구조.mm.md')).rejects.toThrow();
    // 거절된 뒤에도 원래 위치에 그대로 있어야 한다
    expect(await read('과목/OS.mm.md')).toContain('운영체제');
  });

  it('moves a map and its companion folder to trash', async () => {
    await vault.trash('과목/운영체제.mm.md');
    await expect(read('과목/운영체제.mm.md')).rejects.toThrow();
    const trash = await fs.readdir(path.join(root, '.mindmap', 'trash'));
    expect(trash).toHaveLength(1);
    expect(await fs.readFile(path.join(root, '.mindmap', 'trash', trash[0], '과목', '운영체제', 'pages', '스케줄링.md'), 'utf8')).toContain('FCFS');
  });
});

describe('link rewriting on rename', () => {
  it('updates links when a map and its companion folder are renamed', async () => {
    const ix = new Indexer(vault);
    const oldFiles = await ix.freshPaths();
    await vault.rename('과목/운영체제.mm.md', '과목/OS.mm.md');
    const changed = await rewriteLinksAfterMove(vault, oldFiles, buildMoveMap(oldFiles, '과목/운영체제.mm.md', '과목/OS.mm.md'));
    expect(changed.sort()).toEqual(['과목/OS.mm.md']);
    expect(await read('과목/OS.mm.md')).toContain('[[과목/OS/pages/스케줄링]]');
    expect(await read('과목/OS.mm.md')).toContain('[[자료구조.mm#^h1|해시]]');
  });

  it('updates links from other files when a folder moves', async () => {
    const ix = new Indexer(vault);
    const oldFiles = await ix.freshPaths();
    await vault.rename('과목', '학교');
    const changed = await rewriteLinksAfterMove(vault, oldFiles, buildMoveMap(oldFiles, '과목', '학교'));
    expect(changed.length).toBe(2);
    expect(await read('학교/운영체제.mm.md')).toContain('[[학교/운영체제/pages/스케줄링]]');
    expect(await read('학교/운영체제.mm.md')).toContain('[[학교/자료구조.mm#^h1|해시]]');
    expect(await read('학교/운영체제/pages/스케줄링.md')).toContain('[[학교/자료구조.mm]]');
  });

  it('leaves unrelated and unresolved links alone', async () => {
    await put('과목/자료구조.mm.md', '# 자료구조 ^root\n\n- 외부 [[없는문서]] ^t1\n');
    const ix = new Indexer(vault);
    const oldFiles = await ix.freshPaths();
    await vault.rename('과목/운영체제.mm.md', '과목/OS.mm.md');
    await rewriteLinksAfterMove(vault, oldFiles, buildMoveMap(oldFiles, '과목/운영체제.mm.md', '과목/OS.mm.md'));
    expect(await read('과목/자료구조.mm.md')).toContain('[[없는문서]]');
  });
});

describe('StudyStore', () => {
  const file = () => path.join(root, '.mindmap', 'study.json');

  it('records results per map and card, and persists them', async () => {
    const st = new StudyStore(file());
    await st.record('과목/운영체제.mm.md', [{ id: 'a', known: true }, { id: 'b', known: false }]);
    await st.record('과목/운영체제.mm.md', [{ id: 'a', known: true }]);
    const rec = await new StudyStore(file()).get('과목/운영체제.mm.md'); // 새 인스턴스로 디스크에서 다시 읽기
    expect(rec.a).toMatchObject({ reviews: 2, correct: 2, streak: 2, lastKnown: true });
    expect(rec.b).toMatchObject({ reviews: 1, correct: 0, lastKnown: false });
    expect(await st.get('다른맵.mm.md')).toEqual({});
  });

  it('rejects malformed results', async () => {
    const st = new StudyStore(file());
    expect(() => st.record('x', [{ id: '', known: true }])).toThrow();
    expect(() => st.record('x', [{ id: 'a', known: 'yes' as unknown as boolean }])).toThrow();
    expect(() => st.record('x', new Array(501).fill({ id: 'a', known: true }))).toThrow();
  });

  it('keeps records when a map is renamed', async () => {
    const st = new StudyStore(file());
    await st.record('과목/운영체제.mm.md', [{ id: 'a', known: true }]);
    await st.moveMaps(new Map([['과목/운영체제.mm.md', '과목/OS.mm.md']]));
    expect(await st.get('과목/운영체제.mm.md')).toEqual({});
    expect((await st.get('과목/OS.mm.md')).a.reviews).toBe(1);
  });

  it('survives concurrent writes and a corrupted file', async () => {
    const st = new StudyStore(file());
    await Promise.all(Array.from({ length: 20 }, (_, i) => st.record('m', [{ id: `c${i}`, known: i % 2 === 0 }])));
    expect(Object.keys(await st.get('m'))).toHaveLength(20);
    await fs.writeFile(file(), '{ 깨진 json', 'utf8');
    const fresh = new StudyStore(file());
    expect(await fresh.get('m')).toEqual({});
    const files = await fs.readdir(path.join(root, '.mindmap'));
    expect(files.some((f) => f.startsWith('study.json.corrupt-'))).toBe(true);
  });
});

describe('버전 기록과 백업', () => {
  it('덮어쓸 때 이전 내용이 기록되고 목록·내용을 읽을 수 있다', async () => {
    const { listHistory, readHistory } = await import('../src/vault');
    const rel = '과목/자료구조.mm.md';
    const first = await vault.read(rel);
    const w1 = await vault.write(rel, first.content + '\n- 추가1 ^z1\n', first.hash);
    expect(await listHistory(vault, rel)).toHaveLength(1);
    // 5분 안의 두 번째 덮어쓰기는 보통 기록하지 않지만, 강제하면 남긴다
    await vault.write(rel, first.content + '\n- 추가2 ^z2\n', w1.hash, { forceSnapshot: true });
    const list = await listHistory(vault, rel);
    expect(list).toHaveLength(2);
    expect(await readHistory(vault, rel, list[1].name)).toBe(first.content);
    expect(await readHistory(vault, rel, list[0].name)).toContain('추가1');
    await expect(readHistory(vault, rel, '../../x.md')).rejects.toThrow();
  });

  it('백업 zip 에 맵·페이지가 들어가고 기록/휴지통은 빠진다', async () => {
    const { unzipSync } = await import('fflate');
    const { buildBackup } = await import('../src/backup');
    const r = await vault.read('과목/운영체제.mm.md');
    await vault.write('과목/운영체제.mm.md', r.content + '\n- x ^q9\n', r.hash); // history 생성
    await put('.mindmap/study.json', '{}');
    await put('.mindmap/sync.json', '{}');
    const files = unzipSync(await buildBackup(vault));
    const names = Object.keys(files);
    expect(names).toContain('과목/운영체제.mm.md');
    expect(names).toContain('과목/운영체제/pages/스케줄링.md');
    expect(names).toContain('.mindmap/study.json');
    expect(names.some((n) => n.includes('history') || n.includes('sync.json') || n.includes('trash'))).toBe(false);
    expect(new TextDecoder().decode(files['과목/자료구조.mm.md'])).toContain('해시 테이블');
  });
});
