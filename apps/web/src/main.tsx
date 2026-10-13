import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import './p2.css';
import './p3.css';
import './portable.css';
import './mobile.css';
import { App } from './App';
import { CloudGate } from './cloud/CloudGate';

/** PC 서버가 응답하면 로컬 모드, 아니면(정적 호스팅된 모바일 앱) 클라우드 모드 */
async function isLocalServer(): Promise<boolean> {
  if (new URLSearchParams(location.search).has('cloud')) return false;
  try {
    const res = await fetch('/api/info', { cache: 'no-store' });
    return res.ok && (res.headers.get('content-type') ?? '').includes('json');
  } catch {
    return false;
  }
}

const local = await isLocalServer();
if (!local && 'serviceWorker' in navigator) {
  // 오프라인에서 앱을 열고, 이미지(/api/asset)를 기기 저장소에서 꺼내 주기 위해 필요하다
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('서비스 워커 등록 실패:', e));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {local ? (
      <App />
    ) : (
      <CloudGate>
        <App />
      </CloudGate>
    )}
  </StrictMode>,
);
