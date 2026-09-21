/* Service worker do Leilão.
   Estratégia: rede primeiro, cache como reserva. Assim o jogo abre offline
   (modo local) depois da primeira visita, mas sempre pega a versão mais nova
   quando há rede. O WebSocket (/ws) não passa por aqui. */
const VERSAO = "leilao-v1";
const ARQUIVOS = [
  "./",
  "./index.html",
  "./app.js",
  "./data.js",
  "./style.css",
  "./sala.js",
  "./play.html",
  "./play.js",
  "./play.css",
  "./manifest.webmanifest",
  "./vendor/qrcode.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches
      .open(VERSAO)
      .then((cache) => Promise.allSettled(ARQUIVOS.map((a) => cache.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // fontes do Google etc. seguem direto
  if (url.pathname.endsWith("/ws")) return;

  ev.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.ok) {
          const copia = resp.clone();
          caches.open(VERSAO).then((cache) => cache.put(req, copia));
        }
        return resp;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
  );
});
