import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useAux } from '../workspace';
import { useUi } from '../ui';
import { SignOutButton, SyncBadge } from './SyncBadge';
import { moveEntry, newFolder, newMap, parentDir, refreshTrashCount, renameEntry } from '../treeActions';
import type { TreeEntry } from '../types';

/** 지금 끌고 있는 항목 (드래그 중에만) */
let dragging: TreeEntry | null = null;
const LONG_PRESS_MS = 500;
/** 터치 화면에서는 길게 누르기와 겹치므로 끌어서 옮기기는 마우스에서만 */
const FINE_POINTER = typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches;

function canDrop(dest: string): boolean {
  const d = dragging;
  if (!d || parentDir(d.path) === dest) return false;
  return !(d.kind === 'dir' && (dest === d.path || dest.startsWith(d.path + '/')));
}

export function Sidebar() {
  const tree = useStore((s) => s.tree);
  const trashCount = useUi((s) => s.trashCount);
  const [folder, setFolder] = useState('');
  const [rootDrop, setRootDrop] = useState(false);

  // 휴지통 개수 표시: 처음과 목록이 바뀐 뒤에 갱신
  useEffect(() => {
    const t = setTimeout(() => void refreshTrashCount(), 400);
    return () => clearTimeout(t);
  }, [tree]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand-row">
          <span className="brand">마인드맵</span>
          <button className="sidebar-hide-btn" onClick={() => useUi.getState().setSidebarHidden(true)} title="사이드바 접기" aria-label="사이드바 접기">
            «
          </button>
        </div>
        <div className="sidebar-actions">
          <button onClick={() => newMap(folder)} title="선택한 폴더에 새 맵">
            ＋ 맵
          </button>
          <button onClick={() => newFolder(folder)} title="선택한 폴더에 새 폴더">
            ＋ 폴더
          </button>
          <button onClick={() => useAux.getState().openDialog('portable')} title="가져오기 · AI로 맵 만들기 · 내보내기">
            ⇅
          </button>
        </div>
        <div className="sidebar-sync">
          <SyncBadge />
          <SignOutButton />
        </div>
      </div>
      <div
        className={`tree ${rootDrop ? 'drop-root' : ''}`}
        onClick={() => setFolder('')}
        onContextMenu={(e) => {
          e.preventDefault();
          useUi.getState().openMenu({ entry: null, x: e.clientX, y: e.clientY });
        }}
        onDragOver={(e) => {
          if (canDrop('')) {
            e.preventDefault();
            setRootDrop(true);
          }
        }}
        onDragLeave={() => setRootDrop(false)}
        onDrop={(e) => {
          e.preventDefault();
          setRootDrop(false);
          if (dragging && canDrop('')) void moveEntry(dragging, '');
        }}
      >
        {tree.length === 0 && <p className="empty">맵이 없습니다. ＋ 맵으로 만들어 보세요.</p>}
        {tree.map((e) => (
          <TreeItem key={e.path} entry={e} depth={0} folder={folder} setFolder={setFolder} />
        ))}
      </div>
      <div className="sidebar-foot">
        <button className="trash-btn" onClick={() => useAux.getState().openDialog('trash')} title="삭제한 맵과 폴더를 복원">
          🗑 휴지통{trashCount > 0 ? ` (${trashCount})` : ''}
        </button>
      </div>
    </aside>
  );
}

interface TreeItemProps {
  entry: TreeEntry;
  depth: number;
  folder: string;
  setFolder: (p: string) => void;
}

function TreeItem({ entry, depth, folder, setFolder }: TreeItemProps) {
  const [open, setOpen] = useState(true);
  const [dropOn, setDropOn] = useState(false);
  const current = useStore((s) => s.map?.path);
  const renaming = useUi((s) => s.renaming === entry.path);
  const isDir = entry.kind === 'dir';
  const active = isDir ? folder === entry.path : current === entry.path;

  // 길게 누르기(터치) → 메뉴. 메뉴가 열린 직후의 클릭은 무시한다.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const openMenu = (x: number, y: number) => {
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 600);
    useUi.getState().openMenu({ entry, x, y });
  };

  const activate = () => {
    if (isDir) {
      setOpen((o) => (folder === entry.path ? !o : true));
      setFolder(entry.path);
    } else {
      setFolder(parentDir(entry.path));
      void useStore.getState().openMap(entry.path);
      useUi.getState().setDrawer(false);
    }
  };

  return (
    <div>
      <div
        className={`tree-row ${active ? 'active' : ''} ${dropOn ? 'drop-on' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming && FINE_POINTER}
        onDragStart={(e) => {
          dragging = entry;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', entry.path);
        }}
        onDragEnd={() => {
          dragging = null;
          setDropOn(false);
        }}
        onDragOver={(e) => {
          if (isDir && canDrop(entry.path)) {
            e.preventDefault();
            e.stopPropagation();
            setDropOn(true);
          }
        }}
        onDragLeave={() => setDropOn(false)}
        onDrop={(e) => {
          setDropOn(false);
          if (isDir && dragging && canDrop(entry.path)) {
            e.preventDefault();
            e.stopPropagation();
            void moveEntry(dragging, entry.path);
          }
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (swallowClick.current || renaming) return;
          activate();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(e.clientX, e.clientY);
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return;
          const { clientX: x, clientY: y } = e;
          cancelPress();
          press.current = { x, y, timer: setTimeout(() => (cancelPress(), openMenu(x, y)), LONG_PRESS_MS) };
        }}
        onPointerMove={(e) => {
          if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
      >
        <span className="tree-icon">{isDir ? (open ? '▾' : '▸') : '◉'}</span>
        {renaming ? <RenameInput entry={entry} /> : <span className="tree-name">{entry.name}</span>}
        {!renaming && (
          <button
            className="tree-more"
            title="이름 바꾸기 · 이동 · 삭제"
            aria-label={`${entry.name} 메뉴`}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(r.left, r.bottom);
            }}
          >
            ⋯
          </button>
        )}
      </div>
      {isDir &&
        open &&
        entry.children?.map((c) => <TreeItem key={c.path} entry={c} depth={depth + 1} folder={folder} setFolder={setFolder} />)}
    </div>
  );
}

/** 그 자리에서 이름을 고친다. Enter/바깥 클릭 = 적용, Esc = 취소 */
function RenameInput({ entry }: { entry: TreeEntry }) {
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    useUi.getState().setRenaming(null);
    if (value !== null) void renameEntry(entry, value);
  };
  return (
    <input
      className="tree-rename"
      defaultValue={entry.name}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(e.currentTarget.value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
