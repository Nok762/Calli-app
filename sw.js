// sw.js — service worker offline-first.
//
// Stratégie : à l'installation on met TOUT l'app-shell en cache (HTML, CSS, JS,
// données, icônes), puis on répond cache-first. En usage normal, aucune requête
// réseau n'est nécessaire : l'app fonctionne 100 % hors ligne.
//
// Pour déployer une mise à jour : incrémenter VERSION. Le nouveau worker
// s'installe avec un cache neuf, et l'ancien cache est purgé à l'activation.
const VERSION = 'v14';
const CACHE = `callisthenie-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/router.js',
  './js/db.js',
  './js/seed.js',
  './js/skills.js',
  './js/pr.js',
  './js/libelles.js',
  './js/moteur/adaptation.js',
  './js/moteur/generateur.js',
  './js/ui/composants.js',
  './js/ui/vue-dashboard.js',
  './js/ui/vue-skills.js',
  './js/ui/vue-seance.js',
  './js/ui/vue-historique.js',
  './js/ui/vue-exercices.js',
  './js/ui/vue-programmes.js',
  './data/exercices.seed.json',
  './data/skills.config.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './fonts/barlow-condensed-600.woff2',
  './fonts/barlow-condensed-700.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // { cache: 'reload' } force le passage par le réseau : sans ça, le
      // precache peut resservir d'anciens fichiers depuis le cache HTTP du
      // navigateur et une mise à jour serait précachée avec du code périmé.
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((enCache) =>
      enCache ||
      fetch(e.request).then((rep) => {
        // Ressource même-origine récupérée en ligne : on la met en cache pour
        // les prochaines fois (utile si un asset manquait au precache).
        if (rep.ok && new URL(e.request.url).origin === location.origin) {
          const clone = rep.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return rep;
      }).catch(() =>
        // Hors ligne et pas en cache : pour une navigation on retombe sur le shell.
        e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()
      )
    )
  );
});
