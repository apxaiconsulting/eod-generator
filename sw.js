/* Bump VERSION on every deploy so clients pick up the new files. */
const VERSION = 'eod-v5';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./instructions.md','./manifest.webmanifest','./icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
/* Network first, cache as the offline fallback. Only same-origin GETs:
   the AI request is a POST to another origin and is never touched. */
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    /* no-cache = always revalidate with the server, so a deploy shows up on the
       next load instead of after the browser's 10 minute HTTP cache expires. */
    fetch(e.request, { cache:'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
