import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import type { TreeEntry } from '../types';

const MAP_EXT = '.mm.md';

function parentDir(path: string) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

async function run(fn: () => Promise<unknown>) {
  try {
    await fn();
    await useStore.getState().loadTree();
  } catch (e) {
    useStore.getState().toast((e as Error).message, 'error');
  }
}

export function Sidebar() {
  const tree = useStore((s) => s.tree);
  const [folder, setFolder] = useState('');

  const newMap = () => {
    const name = prompt(`새 맵 이름${folder ? ` (폴더: ${folder})` : ''}`);
    if (!name?.trim()) return;
    void run(async () => {
      const { path } = await api.createMap(folder, name);
      await useStore.getState().openMap(path);
    });
  };
  const newFolder = () => {
    const name = prompt(`새 폴더 이름${folder ? ` (상위: ${folder})` : ''}`);
    if (!name?.trim()) return;
    void run(() => api.createFolder([folder, name.trim()].filter(Boolean).join('/')));
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">마인드맵</span>
        <div className="sidebar-actions">
          <button onClick={newMap} title="선택한 폴더에 새 맵">＋ 맵</button>
          <button onClick={newFolder} title="선택한 폴더에 새 폴더">＋ 폴더</button>
        </div>
      </div>
      <div className="tree" onClick={() => setFolder('')}>
        {tree.length === 0 && <p className="empty">맵이 없습니다. ＋ 맵으로 만들어 보세요.</p>}
        {tree.map((e) => (
          <TreeItem key={e.path} entry={e} depth={0} folder={folder} setFolder={setFolder} />
        ))}
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
  const current = useStore((s) => s.map?.path);
  const isDir = entry.kind === 'dir';
  const active = isDir ? folder === entry.path : current === entry.path;
  const containsCurrent = !!current && (current === entry.path || (isDir && current.startsWith(entry.path + '/')));

  const rename = (e: React.MouseEvent) => {
    e.stopPropagation();
    const name = prompt('새 이름', entry.name);
    if (!name?.trim() || name === entry.name) return;
    const to = [parentDir(entry.path), name.trim() + (isDir ? '' : MAP_EXT)].filter(Boolean).join('/');
    void run(async () => {
      await useStore.getState().save();
      await api.rename(entry.path, to);
      if (containsCurrent) await useStore.getState().openMap(to + current!.slice(entry.path.length));
    });
  };

  const remove = (e: React.MouseEvent) => {
    e.stopPropagation();
    const what = isDir ? `"${entry.name}" 폴더와 그 안의 모든 맵` : `"${entry.name}" 맵`;
    if (!confirm(`${what}을 휴지통(.mindmap/trash)으로 옮길까요?`)) return;
    void run(async () => {
      if (containsCurrent) await useStore.getState().openMap(null);
      await api.trash(entry.path);
    });
  };

  return (
    <div>
      <div
        className={`tree-row ${active ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(e) => {
          e.stopPropagation();
          if (isDir) {
            setOpen((o) => (folder === entry.path ? !o : true));
            setFolder(entry.path);
          } else {
            setFolder(parentDir(entry.path));
            void useStore.getState().openMap(entry.path);
          }
        }}
      >
        <span className="tree-icon">{isDir ? (open ? '▾' : '▸') : '◉'}</span>
        <span className="tree-name">{entry.name}</span>
        <span className="tree-tools">
          <button onClick={rename} title="이름 바꾸기">✎</button>
          <button onClick={remove} title="휴지통으로">🗑</button>
        </span>
      </div>
      {isDir &&
        open &&
        entry.children?.map((c) => <TreeItem key={c.path} entry={c} depth={depth + 1} folder={folder} setFolder={setFolder} />)}
    </div>
  );
}
