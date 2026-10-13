import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import chokidar from 'chokidar';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { assetsDirFor, baseName, dirOf, newMapSource, relativePath } from '@mindmap/core';
import { HttpError, MAP_EXT, Vault, hashContent, isHiddenRel } from './vault';
import { Indexer } from './indexer';
import { StudyStore } from './study';
import { buildMoveMap, rewriteLinksAfterMove } from './linkmove';
import { SAMPLE_MAP, SAMPLE_MAP_2, SAMPLE_PAGE } from './sample';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const vaultRoot = path.resolve(argValue('--vault') ?? process.env.MINDMAP_VAULT ?? path.join(repoRoot, 'vault'));
const port = Number(argValue('--port') ?? process.env.MINDMAP_PORT ?? 4321);
const vault = new Vault(vaultRoot);
const indexer = new Indexer(vault);
const study = new StudyStore(path.join(vault.internalDir, 'study.json'));

async function initVault() {
  const fresh = !existsSync(vaultRoot);
  await fs.mkdir(vault.internalDir, { recursive: true });
  // AI용 포맷 설명서. 앱이 만든 것(제목이 같은 것)만 최신 내용으로 갱신하고, 직접 고친 파일은 건드리지 않는다.
  const agents = path.join(vaultRoot, 'AGENTS.md');
  const latest = await fs.readFile(path.join(repoRoot, 'docs', 'FORMAT.md'), 'utf8');
  if (!existsSync(agents)) await fs.writeFile(agents, latest, 'utf8');
  else {
    const cur = await fs.readFile(agents, 'utf8');
    if (cur !== latest && cur.startsWith('# 마인드맵 Vault 파일 포맷')) await fs.writeFile(agents, latest, 'utf8');
  }
  if (fresh) {
    const sample = path.join(vaultRoot, '예시');
    await fs.mkdir(path.join(sample, '운영체제', 'pages'), { recursive: true });
    await fs.writeFile(path.join(sample, `운영체제${MAP_EXT}`), SAMPLE_MAP, 'utf8');
    await fs.writeFile(path.join(sample, '운영체제', 'pages', '스케줄링.md'), SAMPLE_PAGE, 'utf8');
    await fs.writeFile(path.join(sample, `자료구조${MAP_EXT}`), SAMPLE_MAP_2, 'utf8');
  }
}

// ---- 실시간 이벤트 (SSE) ----
type VaultEvent = { type: 'file'; path: string; hash: string | null } | { type: 'tree' };
const listeners = new Set<(e: VaultEvent) => void>();
const broadcast = (e: VaultEvent) => listeners.forEach((l) => l(e));

let treeTimer: NodeJS.Timeout | undefined;
const treeChanged = () => {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(() => broadcast({ type: 'tree' }), 150);
};

let watcher: ReturnType<typeof chokidar.watch> | null = null;
let opQueue: Promise<unknown> = Promise.resolve();

/**
 * 폴더를 옮기는 동안 파일 감시를 잠시 멈춘다.
 * Windows 는 감시 중인 폴더의 이름을 바꾸거나 옮기는 것을 허용하지 않는다 (EPERM).
 */
function withWatcherPaused<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const w = watcher;
    watcher = null;
    await w?.close();
    try {
      return await fn();
    } finally {
      startWatcher();
      treeChanged();
    }
  };
  const result = opQueue.then(run, run);
  opQueue = result.catch(() => {});
  return result;
}

function startWatcher() {
  watcher = chokidar.watch(vaultRoot, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const rel = path.relative(vaultRoot, p);
      return rel !== '' && isHiddenRel(rel);
    },
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });
  const onFile = async (abs: string, removed: boolean) => {
    if (!abs.endsWith('.md')) return;
    const rel = vault.toRel(abs);
    void indexer.update(rel);
    let hash: string | null = null;
    if (!removed) {
      try {
        hash = hashContent(await fs.readFile(abs, 'utf8'));
      } catch {
        return;
      }
    }
    broadcast({ type: 'file', path: rel, hash });
  };
  watcher
    .on('add', (p) => (onFile(p, false), treeChanged()))
    .on('change', (p) => onFile(p, false))
    .on('unlink', (p) => (onFile(p, true), treeChanged()))
    .on('addDir', treeChanged)
    .on('unlinkDir', treeChanged)
    .on('error', (e) => console.error('[watch]', e));
}

// ---- HTTP API ----
const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...(err.body as object) }, err.status);
  console.error(err);
  return c.json({ error: String(err) }, 500);
});

app.get('/api/info', (c) => c.json({ vault: vaultRoot }));
app.get('/api/tree', async (c) => c.json(await vault.tree()));
app.get('/api/file', async (c) => c.json(await vault.read(c.req.query('path') ?? '')));

app.put('/api/file', async (c) => {
  const { path: rel, content, baseHash } = await c.req.json<{ path: string; content: string; baseHash: string | null }>();
  if (typeof content !== 'string') throw new HttpError(400, 'content가 필요합니다');
  return c.json(await vault.write(rel, content, baseHash ?? null));
});

app.post('/api/maps', async (c) => {
  const { dir = '', name } = await c.req.json<{ dir?: string; name: string }>();
  const rel = await vault.createMap(dir, name, newMapSource(name.trim()));
  return c.json({ path: rel });
});

app.post('/api/folders', async (c) => {
  const { path: rel } = await c.req.json<{ path: string }>();
  await vault.createFolder(rel);
  return c.json({ ok: true });
});

app.post('/api/rename', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  const oldFiles = await indexer.freshPaths();
  await withWatcherPaused(() => vault.rename(from, to));
  // 이동된 파일을 가리키던 [[링크]] 를 새 경로로 고친다
  const moved = buildMoveMap(oldFiles, from, to);
  const updated = await rewriteLinksAfterMove(vault, oldFiles, moved);
  await study.moveMaps(moved);
  await indexer.rebuild();
  return c.json({ ok: true, updatedLinks: updated.length });
});

/** 복습 기록: GET 으로 한 맵의 카드별 기록을, POST 로 복습 결과를 보낸다 */
app.get('/api/study', async (c) => {
  const rel = c.req.query('path') ?? '';
  vault.resolve(rel);
  return c.json(await study.get(rel));
});

app.post('/api/study', async (c) => {
  const { path: rel, results } = await c.req.json<{ path: string; results: { id: string; known: boolean }[] }>();
  vault.resolve(rel);
  await study.record(rel, results);
  return c.json({ ok: true });
});

app.get('/api/files', async (c) => {
  await indexer.ready;
  return c.json(indexer.paths());
});

app.get('/api/search', async (c) => {
  await indexer.ready;
  return c.json(indexer.search(c.req.query('q') ?? '', Math.min(200, Number(c.req.query('limit')) || 50)));
});

app.get('/api/backlinks', async (c) => {
  await indexer.ready;
  return c.json(indexer.backlinks(c.req.query('path') ?? ''));
});

/** 팝업 페이지 만들기. path 는 `.md` (맵 파일 `.mm.md` 제외) */
app.post('/api/pages', async (c) => {
  const { path: rel, title } = await c.req.json<{ path: string; title: string }>();
  if (!rel?.endsWith('.md') || rel.endsWith(MAP_EXT)) throw new HttpError(400, '페이지 경로는 .md 로 끝나야 합니다');
  await vault.createFile(rel, `---
title: ${JSON.stringify(title ?? baseName(rel).replace(/\.md$/, ''))}
---

`);
  return c.json({ path: rel });
});

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};
const MAX_UPLOAD = 25 * 1024 * 1024;

/** 이미지 업로드. from 파일에 딸린 assets/ 폴더에 저장하고, from 기준 상대 경로를 돌려준다 */
app.post('/api/upload', async (c) => {
  const from = c.req.query('from') ?? '';
  const ext = (c.req.query('ext') ?? 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!IMAGE_TYPES[ext]) throw new HttpError(400, `지원하지 않는 이미지 형식: ${ext}`);
  vault.resolve(from);
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (!buf.length) throw new HttpError(400, '빈 파일입니다');
  if (buf.length > MAX_UPLOAD) throw new HttpError(400, '이미지는 25MB 이하여야 합니다');
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rel = `${assetsDirFor(from)}/${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  await vault.writeRaw(rel, buf);
  const ref = encodeURI(relativePath(dirOf(from), rel)).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return c.json({ path: rel, ref });
});

app.get('/api/asset', async (c) => {
  const rel = c.req.query('path') ?? '';
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
  const type = IMAGE_TYPES[ext];
  if (!type) throw new HttpError(400, '이미지 파일만 제공합니다');
  const buf = await vault.readBuffer(rel);
  return c.body(new Uint8Array(buf), 200, {
    'content-type': type,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  });
});

app.post('/api/trash', async (c) => {
  const { path: rel } = await c.req.json<{ path: string }>();
  await withWatcherPaused(() => vault.trash(rel));
  await indexer.rebuild();
  return c.json({ ok: true });
});

app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    const send = (e: VaultEvent) => void stream.writeSSE({ data: JSON.stringify(e) });
    listeners.add(send);
    const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 25_000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    listeners.delete(send);
  }),
);

// 빌드된 웹 UI 제공 (npm start)
const dist = path.join(repoRoot, 'apps', 'web', 'dist');
if (existsSync(dist)) {
  const root = path.relative(process.cwd(), dist);
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));
}

await initVault();
startWatcher();
void indexer.start();
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`\n  마인드맵 서버: http://localhost:${info.port}`);
  console.log(`  Vault: ${vaultRoot}\n`);
});
