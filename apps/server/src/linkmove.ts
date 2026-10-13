import fs from 'node:fs/promises';
import { buildMoveMap, rewriteLinksAfterMove as rewriteWithIO } from '@mindmap/core';
import type { Vault } from './vault';

export { buildMoveMap };

/**
 * 파일 이동 후, 이동된 파일을 가리키던 `[[링크]]` 의 대상을 새 경로로 고쳐 쓴다.
 * oldFiles 는 이동 전의 전체 .md 목록, moved 는 buildMoveMap 결과.
 * 이동 후 디스크에서 파일을 읽으므로 반드시 rename 이 끝난 뒤에 호출한다.
 */
export function rewriteLinksAfterMove(vault: Vault, oldFiles: string[], moved: Map<string, string>): Promise<string[]> {
  return rewriteWithIO(
    {
      read: (p) => fs.readFile(vault.resolve(p), 'utf8').catch(() => null),
      write: (p, content) => vault.writeRaw(p, content),
    },
    oldFiles,
    moved,
  );
}
