/* Service worker: guarda a "casca" do aplicativo para abrir sem internet. Não guarda dados. */
// O app de teste (/coletor/teste/) usa o prefixo coletor-teste-v; cada um apaga só os seus caches antigos.
const PREFIXO = /\/teste\//.test(self.location.pathname) ? 'coletor-teste-v' : 'coletor-v';
const VERSAO = PREFIXO + '1.9.8';
const ARQUIVOS = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-512-maskable.png'];

self.addEventListener('install', e => {
  // cache: 'reload' busca direto do servidor, sem pegar cópia antiga guardada pelo navegador
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO && k.startsWith(PREFIXO)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => { if (e.data === 'pular') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // servidor (Apps Script) nunca passa pelo cache
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(VERSAO).then(c => c.match('./index.html')).then(r => r || fetch(req)));
    return;
  }
  e.respondWith(caches.open(VERSAO).then(c => c.match(req, { ignoreSearch: true })).then(r => r || fetch(req)));
});
