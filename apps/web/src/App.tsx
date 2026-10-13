import { useEffect } from 'react';
import { useStore } from './store';
import { useAux } from './workspace';
import { subscribe } from './api';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { MapCanvas } from './components/MapCanvas';
import { HelpDialog } from './components/HelpDialog';
import { PageModal } from './components/PageModal';
import { QuickFind } from './components/QuickFind';
import { BacklinksDialog } from './components/BacklinksDialog';

function pathFromHash() {
  const h = decodeURI(location.hash.slice(1));
  return h || null;
}

export function App() {
  const hasMap = useStore((s) => !!s.map);
  const mapPath = useStore((s) => s.map?.path);
  const toasts = useStore((s) => s.toasts);

  useEffect(() => {
    const st = useStore.getState();
    void st.loadTree();
    void useAux.getState().loadFiles();
    const p = pathFromHash();
    if (p) void st.openMap(p);
    const unsub = subscribe(
      (e) => {
        useStore.getState().onVaultEvent(e);
        useAux.getState().onVaultEvent(e);
      },
      () => {
        void useStore.getState().loadTree();
        void useStore.getState().recheckFile();
        void useAux.getState().loadFiles();
        void useAux.getState().loadBacklinks();
      },
    );
    const onHash = () => {
      const p = pathFromHash();
      if (p && p !== useStore.getState().map?.path) void useStore.getState().openMap(p);
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) {
        void useStore.getState().save();
        e.preventDefault();
      }
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      unsub();
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Toolbar />
        {hasMap ? (
          <MapCanvas key={mapPath} />
        ) : (
          <div className="welcome">
            <h1>마인드맵</h1>
            <p>왼쪽에서 맵을 고르거나 ＋ 맵으로 새로 만드세요.</p>
            <p className="hint">F1을 누르면 단축키를 볼 수 있습니다.</p>
          </div>
        )}
      </main>
      <HelpDialog />
      <PageModal />
      <QuickFind />
      <BacklinksDialog />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
