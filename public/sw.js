const CACHE_NAME = 'bagstock-static-v3';

// Sadece CDN varlıkları cache'le (değişmeyen harici kaynaklar)
const STATIC_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

// Install: sadece CDN varlıklarını cache'le
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// Activate: eski cache'leri temizle, hemen devral
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch stratejisi:
// - API istekleri → her zaman ağdan (cache YOK)
// - Uygulama dosyaları (HTML/JS/CSS) → her zaman ağdan (cache YOK)
// - CDN varlıkları → önce cache, yoksa ağdan
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API ve uygulama dosyaları: her zaman ağdan al, cache kullanma
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname === '/'
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // CDN varlıkları (Chart.js vb.): cache-first
  if (url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Diğer her şey: ağdan al
  event.respondWith(fetch(event.request));
});
