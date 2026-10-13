import { validateName } from '@mindmap/core';
import { api } from './api';
import { useStore } from './store';
import { useUi } from './ui';
import type { TreeEntry } from './types';

const MAP_EXT = '.mm.md';

export const parentDir = (path: string) => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};
export const baseOf = (e: TreeEntry) => e.name;
const joinPath = (...parts: string[]) => parts.filter(Boolean).join('/');
const toast = (m: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }) =>
  useStore.getState().toast(m, kind, action);

/** 작업을 실행하고 트리와 휴지통 표시를 새로 고친다. 실패하면 이유를 알려 준다. */
async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    await useStore.getState().loadTree();
    void refreshTrashCount();
    return r;
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}

export async function refreshTrashCount() {
  try {
    useUi.getState().setTrashCount((await api.trashList()).length);
  } catch {
    /* 표시만 못 갱신 */
  }
}

/** 열려 있는 맵이 이 항목 안에 있는가 */
function containsCurrent(entry: TreeEntry) {
  const cur = useStore.getState().map?.path;
  return !!cur && (cur === entry.path || (entry.kind === 'dir' && cur.startsWith(entry.path + '/')));
}

export function newMap(dir: string) {
  const name = prompt(`새 맵 이름${dir ? ` (폴더: ${dir})` : ''}`);
  if (!name?.trim()) return;
  const err = validateName(name);
  if (err) return toast(err, 'error');
  void run(async () => {
    const { path } = await api.createMap(dir, name.trim());
    await useStore.getState().openMap(path);
  });
}

export function newFolder(dir: string) {
  const name = prompt(`새 폴더 이름${dir ? ` (상위: ${dir})` : ''}`);
  if (!name?.trim()) return;
  const err = validateName(name);
  if (err) return toast(err, 'error');
  void run(() => api.createFolder(joinPath(dir, name.trim())));
}

/** 이름 바꾸기: 새 이름 검사 후 실행. 열려 있던 맵은 새 경로로 다시 연다. */
export async function renameEntry(entry: TreeEntry, newName: string) {
  const name = newName.trim();
  if (!name || name === entry.name) return;
  const err = validateName(name);
  if (err) return toast(err, 'error');
  const to = joinPath(parentDir(entry.path), name + (entry.kind === 'dir' ? '' : MAP_EXT));
  await moveTo(entry, to);
}

/** destDir 폴더 안으로 옮긴다 ('' = 최상위) */
export async function moveEntry(entry: TreeEntry, destDir: string) {
  if (parentDir(entry.path) === destDir) return;
  if (entry.kind === 'dir' && (destDir === entry.path || destDir.startsWith(entry.path + '/'))) {
    return toast('폴더를 자기 안으로 옮길 수 없습니다', 'error');
  }
  const leaf = entry.kind === 'dir' ? entry.name : entry.name + MAP_EXT;
  await moveTo(entry, joinPath(destDir, leaf));
}

async function moveTo(entry: TreeEntry, to: string) {
  const st = useStore.getState();
  const cur = st.map?.path;
  const inside = containsCurrent(entry);
  await run(async () => {
    await st.save();
    await api.rename(entry.path, to);
    if (inside && cur) await useStore.getState().openMap(to + cur.slice(entry.path.length));
  });
}

/** 삭제 확인창을 연다 (영향 범위를 보여 주고 확인받는다) */
export function askDelete(entry: TreeEntry) {
  useUi.getState().setDeleteFor(entry);
}

/** 휴지통으로 옮기고, 잠시 동안 "되돌리기"를 보여 준다 */
export async function deleteEntry(entry: TreeEntry) {
  const inside = containsCurrent(entry);
  await run(async () => {
    if (inside) await useStore.getState().openMap(null);
    const { trashId } = await api.trash(entry.path);
    toast(
      `"${entry.name}" 을(를) 휴지통으로 옮겼습니다`,
      'info',
      trashId ? { label: '되돌리기', run: () => void restoreGroup(trashId) } : undefined,
    );
  });
}

export async function restoreGroup(id: string, open = false) {
  await run(async () => {
    const r = await api.trashRestore(id);
    toast(r.renamed ? `"${r.path}" 로 복원했습니다 (같은 이름이 있어 이름을 바꿨습니다)` : '복원했습니다');
    if (open && r.path.endsWith(MAP_EXT)) await useStore.getState().openMap(r.path);
  });
}

/** 트리의 모든 폴더 경로 (이동 대화상자용) */
export function allFolders(tree: TreeEntry[]): { path: string; name: string; depth: number }[] {
  const out: { path: string; name: string; depth: number }[] = [];
  const walk = (list: TreeEntry[], depth: number) => {
    for (const e of list) {
      if (e.kind !== 'dir') continue;
      out.push({ path: e.path, name: e.name, depth });
      walk(e.children ?? [], depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}
