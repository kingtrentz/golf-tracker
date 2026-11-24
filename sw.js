/* Golf service worker: makes the site installable and shows push alerts.
   Network first: the page always comes fresh when there's signal (cache "no-cache", since GitHub Pages
   says max-age=600); the last copy is only a fallback with no signal. Versioned app files (?v=) also keep
   a last copy so the app still opens on a course with no bars. Data (Supabase) and photos aren't touched. */
const CACHE = "golf-shell-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin) return;
  const page = r.mode === "navigate";
  const asset = !page && /\.(js|css|png|webp)$/.test(u.pathname) && u.searchParams.has("v");
  if (!page && !asset) return;
  const key = page ? u.origin + u.pathname : u.href;
  e.respondWith((async () => {
    try {
      const res = page ? await fetch(u.href, {cache: "no-cache", credentials: "same-origin"}) : await fetch(r);
      if (res.ok) {
        const c = res.clone();
        caches.open(CACHE).then(async cc => {
          if (asset) for (const old of await cc.keys()) { const o = new URL(old.url); if (o.pathname === u.pathname && o.href !== u.href) await cc.delete(old); }
          await cc.put(key, c);
        }).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key) || (page && await caches.match(new URL("index.html", self.registration.scope).href));
      if (hit) return hit;
      throw err;
    }
  })());
});
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {title: "Golf", body: e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.title || "Golf", {
    body: d.body || "", tag: d.tag || undefined, icon: "icon-192.png", badge: "icon-192.png",
    data: {url: new URL(d.url || "index.html", self.registration.scope).href}
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    if (url.startsWith(self.registration.scope)) for (const c of await self.clients.matchAll({type: "window", includeUncontrolled: true})) {
      try { await c.navigate(url); return c.focus(); } catch (_) {}
    }
    return self.clients.openWindow(url);
  })());
});
