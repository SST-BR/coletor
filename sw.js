/* Service worker: guarda a "casca" do aplicativo para abrir sem internet. Não guarda dados. */
const VERSAO = 'coletor-v1.6.0';
const ARQUIVOS = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-512-maskable.png'];

self.addEventListener('install', e => {
  // cache: 'reload' busca direto do servidor, sem pegar cópia antiga guardada pelo navegador
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => { if (e.data === 'pular') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // servidor (Apps Script) nunca passa pelo cache
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then(r => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});
