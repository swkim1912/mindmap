/* 마인드맵 서비스 워커
 * - 앱 화면(HTML/JS/CSS)을 저장해 두어 오프라인에서도 열린다.
 * - /api/asset?path=... 요청은 기기 저장소(IndexedDB)에 있는 이미지로 대신 응답한다.
 */
const CACHE = 'mindmap-shell-v1';
const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

function readAsset(path) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('mindmap-cloud');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('files')) return resolve(null);
      const req = db.transaction('files', 'readonly').objectStore('files').get(path);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    };
  });
}

async function assetResponse(url) {
  const path = url.searchParams.get('path') || '';
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const type = TYPES[ext];
  if (!type) return new Response('이미지 파일만 제공합니다', { status: 400 });
  const rec = await readAsset(path).catch(() => null);
  if (!rec) return new Response('없는 파일입니다', { status: 404 });
  return new Response(rec.bytes, {
    headers: {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase 등 외부 요청은 건드리지 않는다

  if (url.pathname === '/api/asset') return e.respondWith(assetResponse(url));
  if (url.pathname.startsWith('/api/')) return;

  // 파일 이름에 해시가 붙은 정적 파일은 저장해 둔 것을 먼저 쓴다
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // 그 외(HTML, 아이콘 등)는 네트워크 우선, 실패하면 저장본
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === 'navigate' ? '/' : req).then((hit) => hit || Response.error())),
  );
});
