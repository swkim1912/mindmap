import fs from 'node:fs/promises';
import {
  FileLookup,
  isMapPath,
  linkTargetFor,
  mapCompanionDir,
  replaceLinkTarget,
  rewriteLinks,
} from '@mindmap/core';
import type { Vault } from './vault';

/** 이름 변경/이동 한 번에 대한 "옛 경로 → 새 경로" 대응 */
export function buildMoveMap(oldFiles: string[], from: string, to: string): Map<string, string> {
  const m = new Map<string, string>();
  const dirs: [string, string][] = [];
  if (from.endsWith('.md')) {
    m.set(from, to);
    // 맵이면 딸린 폴더(pages/, assets/)도 같이 이동된다
    if (isMapPath(from) && isMapPath(to)) dirs.push([mapCompanionDir(from), mapCompanionDir(to)]);
  } else {
    dirs.push([from, to]);
  }
  for (const f of oldFiles) {
    for (const [a, b] of dirs) if (f.startsWith(a + '/')) m.set(f, b + f.slice(a.length));
  }
  return m;
}

/**
 * 파일 이동 후, 이동된 파일을 가리키던 `[[링크]]` 의 대상을 새 경로로 고쳐 쓴다.
 * oldFiles 는 이동 전의 전체 .md 목록, moved 는 buildMoveMap 결과.
 * 이동 후 디스크에서 파일을 읽으므로 반드시 rename 이 끝난 뒤에 호출한다.
 */
export async function rewriteLinksAfterMove(
  vault: Vault,
  oldFiles: string[],
  moved: Map<string, string>,
): Promise<string[]> {
  if (!moved.size) return [];
  const lookup = new FileLookup(oldFiles);
  const changed: string[] = [];
  for (const oldPath of oldFiles) {
    const newPath = moved.get(oldPath) ?? oldPath;
    const abs = vault.resolve(newPath);
    let src: string;
    try {
      src = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const out = rewriteLinks(src, (link) => {
      const r = lookup.resolve(link, oldPath);
      const dest = r && moved.get(r.path);
      if (!dest) return null;
      return replaceLinkTarget(link, linkTargetFor(dest));
    });
    if (out !== src) {
      await vault.writeRaw(newPath, out);
      changed.push(newPath);
    }
  }
  return changed;
}
