// Catches the engine's cross-origin requests to Roblox (from the page and its
// workers) and hands them to a player window, which sends them over Wisp.
// Scramjet's controller side: routes the sign-in browser's proxied requests
// (paths under its prefix) to the tab that owns them.
importScripts("/player/sj/controller.sw.js");

const ROBLOX = /(^|\.)(roblox\.com|rbxcdn\.com)$/i;
const TIMEOUT_MS = 60000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function cors(headers, reqHeaders) {
  headers.set("Access-Control-Allow-Origin", self.location.origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  const names = [...headers.keys()].filter((k) => !k.startsWith("access-control-"));
  headers.set("Access-Control-Expose-Headers", names.join(", "));
  if (reqHeaders) {
    headers.set("Access-Control-Allow-Headers", reqHeaders);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  return headers;
}

async function relayClient(clientId) {
  const own = clientId && (await self.clients.get(clientId));
  if (own && own.type === "window") return own;
  // Only player windows run the relay; the sign-in browser does not.
  const wins = await self.clients.matchAll({ type: "window" });
  return wins.find((c) => readyClients.has(c.id));
}

const readyClients = new Set();
self.addEventListener("message", (e) => {
  if (e.data?.type === "relay-ready" && e.source) readyClients.add(e.source.id);
});

async function handle(event) {
  const req = event.request;
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: cors(new Headers(), req.headers.get("access-control-request-headers") || "*"),
    });
  }
  const client = await relayClient(event.clientId);
  if (!client) return new Response("no player window to relay through", { status: 502 });

  const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
  const { port1, port2 } = new MessageChannel();
  const reply = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("relay timeout")), TIMEOUT_MS);
    port1.onmessage = (m) => { clearTimeout(t); resolve(m.data); };
  });
  client.postMessage(
    { type: "relay", url: req.url, method: req.method, headers: [...req.headers], body },
    [port2, ...(body ? [body] : [])],
  );
  try {
    const r = await reply;
    if (r.error) return new Response(r.error, { status: 502, headers: cors(new Headers()) });
    const nullBody = [101, 204, 205, 304].includes(r.status);
    return new Response(nullBody ? null : r.body, {
      status: r.status,
      statusText: r.statusText,
      headers: cors(new Headers(r.headers)),
    });
  } catch (err) {
    return new Response(String(err), { status: 504, headers: cors(new Headers()) });
  }
}

// With ENGINE_SOURCE=github:…, engine data (wasm, content, flags) is fetched
// by the browser straight from jsDelivr (raw GitHub as fallback), not through
// our server. The engine's .js files still come from our server: workers must
// be same-origin, and WebClient.js carries the WebTransport shim.
// Files over 19 MB are stored as <name>.part00, .part01…; we rejoin them here.
let sourcePromise;
const engineSource = () => (sourcePromise ??= fetch("/player/engine-source.json")
  .then((r) => r.json()).catch(() => null));

async function fromBases(rel, bases, init) {
  let last;
  for (const base of bases) {
    try { last = await fetch(base + rel, { mode: "cors", credentials: "omit", ...init }); } catch { continue; }
    if (last.ok || last.status === 404) return last;
  }
  return last || new Response("engine source unreachable", { status: 502 });
}

async function joined(get, rel, known) {
  const parts = [];
  let total = 0;
  if (known) known.forEach((size, i) => { parts.push(`${rel}.part${String(i).padStart(2, "0")}`); total += size; });
  else for (let i = 0; ; i++) {
    const p = `${rel}.part${String(i).padStart(2, "0")}`;
    const head = await get(p, { method: "HEAD" });
    if (!head.ok) break;
    parts.push(p);
    total += Number(head.headers.get("content-length") || 0);
  }
  if (!parts.length) return null;
  const body = new ReadableStream({
    async start(controller) {
      try {
        for (const p of parts) {
          const r = await get(p);
          if (!r.ok) throw new Error(`${p}: ${r.status}`);
          const reader = r.body.getReader();
          for (;;) { const { value, done } = await reader.read(); if (done) break; controller.enqueue(value); }
        }
        controller.close();
      } catch (e) { controller.error(e); }
    },
  });
  const headers = { "Content-Type": rel.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" };
  if (total) headers["Content-Length"] = String(total);
  return new Response(body, { status: 200, headers });
}

const TYPES = { wasm: "application/wasm", json: "application/json", txt: "text/plain", ttf: "font/ttf", otf: "font/otf", png: "image/png", ogg: "audio/ogg", mp3: "audio/mpeg" };
const typed = (res, rel) => {
  if (!res.ok) return res;
  const ext = rel.split(".").pop().toLowerCase();
  const h = new Headers(res.headers);
  if (TYPES[ext]) h.set("Content-Type", TYPES[ext]);
  return new Response(res.body, { status: res.status, headers: h });
};

// Engine data is versioned, so it's kept in Cache Storage per version: only
// the first load downloads it (the fonts alone are 28 MB).
async function cached(version, rel, make) {
  const cache = await caches.open(`webblox-engine-${version}`);
  const key = `/__engine/${rel}`;
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.ok) {
    const [a, b] = res.body.tee();
    cache.put(key, new Response(b, { headers: res.headers })).catch(() => {});
    return new Response(a, { status: res.status, headers: res.headers });
  }
  return res;
}

self.addEventListener("activate", (e) => e.waitUntil(engineSource().then((src) => src && caches.keys().then((keys) =>
  Promise.all(keys.filter((k) => k.startsWith("webblox-engine-") && k !== `webblox-engine-${src.version}`).map((k) => caches.delete(k)))))));

async function engineFile(req, rel) {
  const src = await engineSource();
  if (src && !rel.endsWith(".js")) return cached(src.version, rel, () => engineFromSource(src, rel));
  return engineLocal(req, rel);
}

async function engineFromSource(src, rel) {
  {
    const bases = [`${src.base}${src.version}/`, `${src.fallback}${src.version}/`];
    const get = (r, init) => fromBases(r, bases, init);
    // parts.json (written by the workflow) lists split files and part sizes.
    src.parts ??= get("parts.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    const known = (await src.parts)[decodeURIComponent(rel)];
    if (known) return joined(get, rel, known);
    const res = await get(rel);
    if (res.status !== 404) return typed(res, rel);
    return (await joined(get, rel)) || res;
  }
}

async function engineLocal(req, rel) {
  const res = await fetch(req);
  if (res.status !== 404) return res;
  const dir = req.url.slice(0, req.url.length - rel.length);
  return (await joined((r, init) => fetch(dir + r, init), rel)) || res;
}

async function flagsFile(req) {
  const src = await engineSource();
  if (!src) return fetch(req);
  return typed(await fromBases(`${src.version}.flags.json`, [src.base, src.fallback]), "flags.json");
}

self.addEventListener("fetch", (event) => {
  if ($scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
    return;
  }
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && event.request.method === "GET") {
    const m = /^\/player\/engine\/+(?:(?:r\d+|b[0-9a-f]+)\/+)?(.+)$/.exec(url.pathname);
    if (m) { event.respondWith(engineFile(event.request, decodeURIComponent(m[1]).split("/").map(encodeURIComponent).join("/"))); return; }
    if (url.pathname === "/player/flags.json") { event.respondWith(flagsFile(event.request)); return; }
  }
  if (url.origin !== self.location.origin && ROBLOX.test(url.hostname)) {
    event.respondWith(handle(event));
  }
});
