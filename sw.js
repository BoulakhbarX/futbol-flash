/* =====================================================================
   FÚTBOL FLASH STUDIO · offline support for the phone app
   Keeps every app file on the device, so the app opens instantly and works
   with no signal. Not used by the PC Studio (Start Futbol Flash.bat).

   After uploading changed files, change VERSION: installed apps then download
   the new files and switch to them the next time they're opened.
   ===================================================================== */
const VERSION = '2026-10-21.2';
const CACHE = `ff-studio-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/templates.css',
  'css/editor.css',
  'js/app.js',
  'vendor/fonts.css',
  'vendor/html-to-image.js',
  'vendor/fonts/anton-latin.woff2',
  'vendor/fonts/anton-latin-ext.woff2',
  'vendor/fonts/montserrat-latin.woff2',
  'vendor/fonts/montserrat-latin-ext.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' skips the browser's HTTP cache, so an update never mixes old and new files
    await cache.addAll(FILES.map(file => new Request(file, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('ff-studio-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// App files come from the device copy; anything else goes to the network as usual
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true })
      || (request.mode === 'navigate' ? await cache.match('index.html') : undefined);
    return hit || fetch(request);
  })());
});
