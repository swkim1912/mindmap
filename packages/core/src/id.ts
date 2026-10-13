import type { MapNode } from './model';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(len = 4): string {
  let s = '';
  // 첫 글자는 영문자로 해서 숫자로만 된 ID를 피한다
  s += ALPHABET[Math.floor(Math.random() * 26)];
  for (let i = 1; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/** taken에 없는 새 ID를 만들고 taken에 추가한다 */
export function newId(taken: Set<string>): string {
  for (let len = 4; ; len++) {
    for (let tries = 0; tries < 20; tries++) {
      const id = randomId(len);
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  }
}

export const ID_RE = /^[A-Za-z0-9_-]+$/;

export function collectIds(root: MapNode, into = new Set<string>()): Set<string> {
  into.add(root.id);
  for (const c of root.children) collectIds(c, into);
  return into;
}
