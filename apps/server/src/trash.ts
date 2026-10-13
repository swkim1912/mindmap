import fs from 'node:fs/promises';
import path from 'node:path';
import {
  affectedFiles,
  countKinds,
  expiryCutoffId,
  isMapPath,
  isSilentTrash,
  isTrashId,
  restoreMapping,
  summarizeTrash,
  type KindCounts,
  type TrashGroup,
} from '@mindmap/core';
import type { Indexer } from './indexer';
import { HttpError, renameWithRetry, type Vault } from './vault';

async function walkFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(p, base)));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

async function trashDirs(vault: Vault): Promise<string[]> {
  try {
    return (await fs.readdir(vault.trashDir, { withFileTypes: true })).filter((e) => e.isDirectory() && isTrashId(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/** 휴지통 목록 (최신순). 눈에 띄지 않는 임시 보관(x-)과 기한이 지난 묶음은 뺀다. */
export async function listTrash(vault: Vault): Promise<TrashGroup[]> {
  const out: TrashGroup[] = [];
  const cutoff = expiryCutoffId();
  for (const id of await trashDirs(vault)) {
    if (isSilentTrash(id) || id < cutoff) continue;
    const files = await walkFiles(path.join(vault.trashDir, id));
    if (files.length) out.push(summarizeTrash(id, files));
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** 휴지통 묶음을 원래 자리로 복원한다. 같은 이름이 있으면 "(복원)" 을 붙인다. */
export async function restoreTrash(vault: Vault, id: string): Promise<{ path: string; renamed: boolean }> {
  if (!isTrashId(id)) throw new HttpError(400, '올바르지 않은 휴지통 ID 입니다');
  const dir = path.join(vault.trashDir, id);
  let files: string[];
  try {
    files = await walkFiles(dir);
  } catch {
    throw new HttpError(404, '휴지통에 그 항목이 없습니다');
  }
  if (!files.length) throw new HttpError(404, '휴지통에 그 항목이 없습니다');
  const { moved, renamed } = restoreMapping(files, (p) => vault.exists(p));
  for (const [from, to] of moved) {
    const dest = vault.resolve(to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await renameWithRetry(path.join(dir, ...from.split('/')), dest);
  }
  await fs.rm(dir, { recursive: true, force: true });
  const target = summarizeTrash(id, files).path;
  return { path: moved.get(target) ?? target, renamed };
}

/** 묶음 하나(또는 전부)를 영구 삭제한다. 삭제한 묶음 ID 들을 돌려준다. */
export async function purgeTrash(vault: Vault, ids: string[] | 'all'): Promise<string[]> {
  const all = await trashDirs(vault);
  const targets = ids === 'all' ? all : all.filter((d) => ids.includes(d));
  for (const id of targets) await fs.rm(path.join(vault.trashDir, id), { recursive: true, force: true });
  return targets.filter((d) => !isSilentTrash(d));
}

/** 보관 기간(30일)이 지난 묶음을 지운다 (임시 보관 포함) */
export async function purgeExpiredLocal(vault: Vault): Promise<number> {
  const cutoff = expiryCutoffId();
  let n = 0;
  for (const id of await trashDirs(vault)) {
    const key = isSilentTrash(id) ? id.slice(2) : id;
    if (key < cutoff) {
      await fs.rm(path.join(vault.trashDir, id), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

export interface Impact extends KindCounts {
  path: string;
  kind: 'map' | 'folder' | 'file';
  links: { count: number; sources: { path: string; title: string }[] };
}

/** 삭제하면 무엇이 함께 없어지고, 어떤 링크가 끊어지는지 */
export async function computeImpact(vault: Vault, indexer: Indexer, target: string): Promise<Impact> {
  vault.resolve(target);
  const all = await vault.listFiles();
  const affected = affectedFiles(all, target);
  if (!affected.length) throw new HttpError(404, '대상이 없습니다');
  const set = new Set(affected);
  await indexer.ready;
  const seen = new Map<string, string>();
  for (const p of affected) {
    if (!p.endsWith('.md')) continue;
    const bl = indexer.backlinks(p);
    for (const s of [...bl.file, ...Object.values(bl.nodes).flat()]) {
      if (!set.has(s.path) && !seen.has(s.path)) seen.set(s.path, s.title);
    }
  }
  return {
    path: target,
    kind: isMapPath(target) ? 'map' : target.endsWith('.md') ? 'file' : 'folder',
    ...countKinds(affected),
    links: { count: seen.size, sources: [...seen].slice(0, 20).map(([p, title]) => ({ path: p, title })) },
  };
}
