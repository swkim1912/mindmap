import { useEffect, useState } from 'react';
import { api, type Impact } from '../api';
import { useStore } from '../store';
import { useUi } from '../ui';
import { allFolders, askDelete, deleteEntry, moveEntry, newFolder, newMap, parentDir } from '../treeActions';
import type { TreeEntry } from '../types';

/** 맵/폴더 행의 메뉴. 넓은 화면에서는 커서 옆, 좁은 화면에서는 아래에서 올라오는 시트로 보인다. */
export function TreeMenu() {
  const menu = useUi((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useUi.getState().openMenu(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);
  if (!menu) return null;

  const { entry } = menu;
  const close = () => useUi.getState().openMenu(null);
  const dir = entry ? (entry.kind === 'dir' ? entry.path : parentDir(entry.path)) : '';
  const item = (label: string, fn: () => void, danger = false) => (
    <button
      key={label}
      className={danger ? 'danger' : ''}
      onClick={() => {
        close();
        fn();
      }}
    >
      {label}
    </button>
  );
  const items = [
    ...(!entry || entry.kind === 'dir' ? [item('새 맵', () => newMap(dir)), item('새 폴더', () => newFolder(dir))] : []),
    ...(entry
      ? [
          item('이름 바꾸기', () => useUi.getState().setRenaming(entry.path)),
          item('이동…', () => useUi.getState().setMoveFor(entry)),
          item('삭제', () => askDelete(entry), true),
        ]
      : []),
  ];
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 200));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 40 - items.length * 38));
  return (
    <div className="menu-backdrop" onPointerDown={close} onContextMenu={(e) => (e.preventDefault(), close())}>
      <div className="tree-menu" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()} role="menu">
        {entry && <div className="tree-menu-title">{entry.name}</div>}
        {items}
      </div>
    </div>
  );
}

/** 옮길 폴더를 고른다 */
export function MoveDialog() {
  const entry = useUi((s) => s.moveFor);
  const tree = useStore((s) => s.tree);
  const [dest, setDest] = useState<string | null>(null);
  useEffect(() => setDest(null), [entry]);
  if (!entry) return null;

  const close = () => useUi.getState().setMoveFor(null);
  const current = parentDir(entry.path);
  const invalid = (p: string) => p === current || (entry.kind === 'dir' && (p === entry.path || p.startsWith(entry.path + '/')));
  const options = [{ path: '', name: '(최상위)', depth: 0 }, ...allFolders(tree).map((f) => ({ ...f, depth: f.depth + 1 }))];

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal move" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="이동">
        <div className="modal-head">
          <h2>“{entry.name}” 옮기기</h2>
          <button onClick={close} aria-label="닫기" autoFocus>
            ✕
          </button>
        </div>
        <p className="hint">옮길 폴더를 고르세요. 링크와 복습 기록은 자동으로 따라갑니다.</p>
        <ul className="folder-pick">
          {options.map((f) => (
            <li key={f.path || '/'}>
              <button
                className={dest === f.path ? 'on' : ''}
                disabled={invalid(f.path)}
                style={{ paddingLeft: 10 + f.depth * 16 }}
                onClick={() => setDest(f.path)}
              >
                {f.path === '' ? '🗂' : '📁'} {f.name}
                {f.path === current && <small> 현재 위치</small>}
              </button>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button
            disabled={dest === null}
            onClick={() => {
              const d = dest!;
              close();
              void moveEntry(entry, d);
            }}
          >
            여기로 이동
          </button>
        </div>
      </div>
    </div>
  );
}

const plural = (n: number, unit: string) => (n > 0 ? `${unit} ${n}개` : '');

/** 삭제 전에 무엇이 함께 없어지고 어떤 링크가 끊어지는지 보여 준다 */
export function DeleteDialog() {
  const entry = useUi((s) => s.deleteFor);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState('');
  const [showLinks, setShowLinks] = useState(false);

  useEffect(() => {
    setImpact(null);
    setError('');
    setShowLinks(false);
    if (!entry) return;
    let alive = true;
    api
      .impact(entry.path)
      .then((i) => alive && setImpact(i))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [entry]);
  if (!entry) return null;

  const close = () => useUi.getState().setDeleteFor(null);
  const parts = impact ? [plural(impact.maps, '맵'), plural(impact.pages, '페이지'), plural(impact.images, '이미지'), plural(impact.others, '기타 파일')].filter(Boolean) : [];

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal delete" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="삭제">
        <div className="modal-head">
          <h2>“{entry.name}” 삭제</h2>
          <button onClick={close} aria-label="닫기">
            ✕
          </button>
        </div>
        {error ? (
          <p className="hint">{error}</p>
        ) : !impact ? (
          <p className="hint">확인하는 중…</p>
        ) : (
          <>
            <p>
              {entry.kind === 'dir' ? '폴더와 그 안의 ' : ''}
              {parts.length ? parts.join(' · ') : '빈 폴더'}
              {parts.length ? '를' : '를'} 휴지통으로 옮깁니다. 30일 동안 보관되며 언제든 복원할 수 있습니다.
            </p>
            {impact.links.count > 0 && (
              <div className="delete-links">
                <p>
                  ⚠ 이 항목을 가리키는 링크가 있는 파일이 <strong>{impact.links.count}개</strong> 있습니다. 삭제하면 그 링크는 끊어진
                  표시(취소선)가 되고, 복원하면 다시 연결됩니다.{' '}
                  <button className="linklike" onClick={() => setShowLinks((v) => !v)}>
                    {showLinks ? '접기' : '목록 보기'}
                  </button>
                </p>
                {showLinks && (
                  <ul>
                    {impact.links.sources.map((s) => (
                      <li key={s.path}>
                        {s.title} <small>{s.path}</small>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        <div className="modal-actions">
          <button onClick={close}>취소</button>
          <button
            className="danger"
            disabled={!impact && !error}
            autoFocus
            onClick={() => {
              close();
              void deleteEntry(entry as TreeEntry);
            }}
          >
            휴지통으로
          </button>
        </div>
      </div>
    </div>
  );
}
