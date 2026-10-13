import { describe, expect, it } from 'vitest';
import {
  TRASH_DAYS,
  affectedFiles,
  buildMoveMap,
  countKinds,
  expiryCutoffId,
  isSilentTrash,
  isTrashExpired,
  isTrashId,
  mergeFolders,
  moveStudyKeys,
  newTrashId,
  parseFolders,
  restoreMapping,
  summarizeTrash,
  trashDaysLeft,
  trashTarget,
  trashTime,
  validateName,
} from '../src';

describe('validateName', () => {
  it('정상 이름은 통과', () => {
    for (const n of ['운영체제', 'a b', '2026 기말 (정리)', 'x.y']) expect(validateName(n)).toBeNull();
  });
  it('빈 이름, 금지 문자, 점 시작/끝, 예약어, 너무 긴 이름은 거절', () => {
    for (const n of ['', '   ', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', '.숨김', '끝점.', '..', 'CON', 'nul.txt', 'x'.repeat(81)]) {
      expect(validateName(n), JSON.stringify(n)).not.toBeNull();
    }
  });
});

const FILES = ['과목/운영체제.mm.md', '과목/운영체제/pages/p.md', '과목/운영체제/assets/a.png', '과목/자료구조.mm.md', '루트.mm.md'];

describe('이동 계획', () => {
  it('맵을 옮기면 딸린 폴더 파일도 함께', () => {
    const m = buildMoveMap(FILES, '과목/운영체제.mm.md', '보관/OS.mm.md');
    expect([...m]).toEqual([
      ['과목/운영체제.mm.md', '보관/OS.mm.md'],
      ['과목/운영체제/pages/p.md', '보관/OS/pages/p.md'],
      ['과목/운영체제/assets/a.png', '보관/OS/assets/a.png'],
    ]);
  });
  it('폴더를 옮기면 안의 모든 파일', () => {
    expect(buildMoveMap(FILES, '과목', '보관/과목').size).toBe(4);
  });
  it('affectedFiles: 삭제 대상이 건드리는 파일들', () => {
    expect(affectedFiles(FILES, '과목/운영체제.mm.md')).toHaveLength(3);
    expect(affectedFiles(FILES, '과목')).toHaveLength(4);
    expect(affectedFiles(FILES, '없는경로')).toEqual([]);
  });
  it('countKinds', () => {
    expect(countKinds(FILES)).toEqual({ maps: 3, pages: 1, images: 1, others: 0 });
  });
});

describe('휴지통 ID', () => {
  it('시각을 담고 있어 되돌려 읽을 수 있고, 문자열 순서가 시간 순서다', () => {
    const a = newTrashId(new Date('2026-10-13T14:02:11.123Z'));
    const b = newTrashId(new Date('2026-10-14T00:00:00.000Z'));
    expect(a).toBe('2026-10-13T14-02-11-123Z');
    expect(trashTime(a)?.toISOString()).toBe('2026-10-13T14:02:11.123Z');
    expect(a < b).toBe(true);
    expect(isTrashId(a)).toBe(true);
    expect(isTrashId('x-' + a)).toBe(true);
    expect(isSilentTrash('x-' + a)).toBe(true);
    expect(isTrashId('../etc')).toBe(false);
  });
  it('보관 기간', () => {
    const now = new Date('2026-10-13T00:00:00Z');
    const fresh = newTrashId(new Date('2026-10-12T00:00:00Z'));
    const old = newTrashId(new Date(now.getTime() - (TRASH_DAYS + 1) * 86_400_000));
    expect(trashDaysLeft(fresh, now)).toBe(TRASH_DAYS - 1);
    expect(isTrashExpired(fresh, now)).toBe(false);
    expect(isTrashExpired(old, now)).toBe(true);
    expect(old < expiryCutoffId(now)).toBe(true);
    expect(fresh < expiryCutoffId(now)).toBe(false);
  });
});

describe('휴지통 묶음 해석', () => {
  it('맵 + 딸린 폴더 = 맵', () => {
    expect(trashTarget(FILES.slice(0, 3))).toEqual({ path: '과목/운영체제.mm.md', kind: 'map' });
  });
  it('여러 맵이 든 폴더 = 공통 폴더', () => {
    expect(trashTarget(FILES.slice(0, 4))).toEqual({ path: '과목', kind: 'folder' });
  });
  it('파일 하나', () => {
    expect(trashTarget(['a/p.md'])).toEqual({ path: 'a/p.md', kind: 'file' });
  });
  it('summarizeTrash', () => {
    const g = summarizeTrash('2026-10-13T14-02-11-123Z', FILES.slice(0, 3), new Date('2026-10-13T15:00:00Z'));
    expect(g).toMatchObject({ path: '과목/운영체제.mm.md', kind: 'map', maps: 1, pages: 1, images: 1, daysLeft: 30 });
  });
});

describe('restoreMapping', () => {
  const group = FILES.slice(0, 3);
  it('충돌이 없으면 그대로', () => {
    const r = restoreMapping(group, () => false);
    expect(r.renamed).toBe(false);
    expect(r.moved.get('과목/운영체제.mm.md')).toBe('과목/운영체제.mm.md');
  });
  it('원래 자리에 같은 이름이 있으면 (복원) 을 붙여 딸린 폴더까지 함께', () => {
    const r = restoreMapping(group, (p) => p === '과목/운영체제.mm.md');
    expect(r.renamed).toBe(true);
    expect([...r.moved.values()]).toEqual(['과목/운영체제 (복원).mm.md', '과목/운영체제 (복원)/pages/p.md', '과목/운영체제 (복원)/assets/a.png']);
  });
  it('딸린 파일만 겹쳐도 비켜 놓고, (복원) 도 있으면 번호를 올린다', () => {
    const taken = new Set(['과목/운영체제/pages/p.md', '과목/운영체제 (복원).mm.md']);
    const r = restoreMapping(group, (p) => taken.has(p));
    expect(r.moved.get('과목/운영체제.mm.md')).toBe('과목/운영체제 (복원 2).mm.md');
  });
});

describe('빈 폴더 목록과 복습 기록 이동', () => {
  it('parse/merge', () => {
    expect(parseFolders('["b","a","a",3,""]')).toEqual(['a', 'b']);
    expect(parseFolders('깨짐')).toEqual([]);
    expect(JSON.parse(mergeFolders('["a"]', '["b","a"]'))).toEqual(['a', 'b']);
  });
  it('moveStudyKeys: 맵 경로 키를 옮기고 바뀐 게 없으면 null', () => {
    const json = JSON.stringify({ 'a.mm.md': { c1: { reviews: 1 } }, 'z.mm.md': {} });
    const out = JSON.parse(moveStudyKeys(json, new Map([['a.mm.md', 'b.mm.md']]))!);
    expect(out['b.mm.md'].c1.reviews).toBe(1);
    expect(out['a.mm.md']).toBeUndefined();
    expect(moveStudyKeys(json, new Map([['없음.mm.md', 'x.mm.md']]))).toBeNull();
    expect(moveStudyKeys('깨짐', new Map([['a', 'b']]))).toBeNull();
  });
});
