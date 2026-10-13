import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import chokidar from 'chokidar';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { newMapSource } from '@mindmap/core';
import { HttpError, MAP_EXT, Vault, hashContent, isHiddenRel } from './vault';
import { SAMPLE_MAP } from './sample';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const vaultRoot = path.resolve(argValue('--vault') ?? process.env.MINDMAP_VAULT ?? path.join(repoRoot, 'vault'));
const port = Number(argValue('--port') ?? process.env.MINDMAP_PORT ?? 4321);
const vault = new Vault(vaultRoot);

async function initVault() {
  const fresh = !existsSync(vaultRoot);
  await fs.mkdir(vault.internalDir, { recursive: true });
  const agents = path.join(vaultRoot, 'AGENTS.md');
  if (!existsSync(agents)) await fs.copyFile(path.join(repoRoot, 'docs', 'FORMAT.md'), agents);
  if (fresh) {
    await fs.mkdir(path.join(vaultRoot, '예시'), { recursive: true });
    await fs.writeFile(path.join(vaultRoot, '예시', `운영체제${MAP_EXT}`), SAMPLE_MAP, 'utf8');
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

function startWatcher() {
  const watcher = chokidar.watch(vaultRoot, {
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
  await vault.rename(from, to);
  return c.json({ ok: true });
});

app.post('/api/trash', async (c) => {
  const { path: rel } = await c.req.json<{ path: string }>();
  await vault.trash(rel);
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
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`\n  마인드맵 서버: http://localhost:${info.port}`);
  console.log(`  Vault: ${vaultRoot}\n`);
});
