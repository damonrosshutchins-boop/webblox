// WebBlox dev server: serves the player (cross-origin isolated), the vendored
// engine, epoxy, and a Wisp endpoint at /wisp/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { createWtWs } from "./wt-relay.mjs";

// Game traffic (WebTransport) is tunneled over WebSocket at /wt-ws/.
const wtWs = createWtWs();
const wt = { mode: "websocket" };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Build id from the app files: stamped into app/engine URLs so caches in
// front of us (Cloudflare's Browser Cache TTL overrides no-cache) can't serve
// stale files after an update.
const BUILD = "b" + crypto.createHash("sha1").update(
  ["player", "."].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((n) => /\.(js|mjs|html|css)$/.test(n))
    .map((n) => { const st = fs.statSync(path.join(ROOT, d, n)); return `${d}/${n}:${st.size}:${st.mtimeMs}`; })).join("|"),
).digest("hex").slice(0, 10);
// Points app-file references at the current build (sw.js keeps its URL: the
// browser already revalidates service worker scripts).
const stamp = (text) => text
  .replace(/(["'])\/player\/((?!sw\.js)[\w-]+\.(?:js|css))(?:\?v=\d+)?\1/g, `$1/player/$2?b=${BUILD}$1`)
  .replaceAll("__BUILD__", BUILD);
const PORT = Number(process.env.PORT || 8080);
// Where engine files come from when they aren't in vendor/ locally:
//   ENGINE_SOURCE=github:<owner>/<repo>[@branch]  raw GitHub (GITHUB_TOKEN for a private repo)
//   ENGINE_SOURCE=https://<host>/<path>/vendor/   any static mirror of the same layout
//   otherwise                                     Roblox's CDN
// Either way this server fetches them; the browser only ever talks to us.
const CURRENT = path.join(ROOT, "vendor/CURRENT");
const CDN_ONLY = !!process.env.CDN_ONLY; // ignore local vendor/ (testing)
const ENGINE_SOURCE = process.env.ENGINE_SOURCE || "";
const GH = /^github:([^@]+)(?:@(.+))?$/.exec(ENGINE_SOURCE);
const GH_RAW = GH && `https://raw.githubusercontent.com/${GH[1]}/${GH[2] || "main"}/vendor/`;
// A plain http(s) base is a static mirror (GitHub Pages, S3, ...). It sends
// CORS headers, so the browser can load engine data from it directly.
const MIRROR = !GH && /^https?:\/\//.test(ENGINE_SOURCE)
  ? ENGINE_SOURCE.replace(/\/?$/, "/")
  : null;
const UPSTREAM = GH_RAW || MIRROR;
const upstreamHeaders = GH && process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {};
const upstreamText = async (u) => { const r = await fetch(u, { headers: upstreamHeaders }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.text(); };
const VERSION = fs.existsSync(CURRENT) && !CDN_ONLY ? fs.readFileSync(CURRENT, "utf8").trim()
  : UPSTREAM ? (await upstreamText(UPSTREAM + "CURRENT")).trim()
  : (await (await fetch("https://clientsettings.roblox.com/v2/client-version/WebClientApp")).json()).clientVersionUpload;
const CDN = UPSTREAM ? `${UPSTREAM}${VERSION}/` : `https://setup.rbxcdn.com/webclient/${VERSION}-RobloxWebClient/`;
console.log(`engine source: ${GH ? `github ${GH[1]}` : MIRROR || "Roblox CDN"} (local vendor/ first${CDN_ONLY ? ", disabled" : ""})`);
const cdnCache = new Map();
async function fromCdn(rel) {
  if (!cdnCache.has(rel)) cdnCache.set(rel, fetch(CDN + rel, { headers: upstreamHeaders }).then(async (r) => {
    if (!r.ok) throw new Error(`upstream ${r.status} for ${rel}`);
    return Buffer.from(await r.arrayBuffer());
  }).catch((e) => { cdnCache.delete(rel); throw e; }));
  return cdnCache.get(rel);
}
const ENGINE_DIR = path.join(ROOT, "vendor", VERSION);
const FLAGS_FILE = path.join(ROOT, "vendor", `${VERSION}.flags.json`);
const EPOXY_DIR = path.join(ROOT, "node_modules/@mercuryworkshop/epoxy-tls/full");
const SJ_DIR = path.join(ROOT, "node_modules/@mercuryworkshop/scramjet/dist");
const SJC_DIR = path.join(ROOT, "node_modules/@mercuryworkshop/scramjet-controller/dist");
// The sign-in browser hosts arbitrary proxied sites in an iframe, so it is not
// cross-origin isolated. It shares the origin (and IndexedDB) with the player.
const NOT_ISOLATED = new Set(["browser.html"]);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".ttf": "font/ttf", ".otf": "font/otf",
  ".txt": "text/plain", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".svg": "image/svg+xml",
};

function isolationHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function sendFile(res, file, extra = {}) {
  const resolved = path.resolve(file);
  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      ...extra,
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

// Joins `rel` under `base`, refusing anything that escapes it.
function safeJoin(base, rel) {
  const p = path.resolve(base, "." + path.posix.normalize("/" + rel));
  return p.startsWith(path.resolve(base) + path.sep) ? p : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }

  if (p === "/") { res.writeHead(302, { Location: "/player/" }); res.end(); return; }
  if (!p.startsWith("/player/")) { res.writeHead(404); res.end(); return; }

  const rel = p.slice("/player/".length);
  if (!NOT_ISOLATED.has(rel)) isolationHeaders(res);
  let file;
  if (rel === "" ) file = path.join(ROOT, "player/index.html");
  else if (rel === "flags.json") file = FLAGS_FILE;
  else if (rel === "wt.json") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(wt)); return; }
  else if (rel === "engine-source.json") {
    // Tells the service worker to load engine data straight from the CDN
    // (jsDelivr for GitHub, the mirror itself otherwise), no proxy in between.
    const jsd = GH && `https://cdn.jsdelivr.net/gh/${GH[1]}@${GH[2] || "main"}/vendor/`;
    const body = UPSTREAM ? { base: jsd || MIRROR, fallback: GH_RAW || MIRROR, version: VERSION } : null;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }); res.end(JSON.stringify(body)); return;
  }
  else if (rel === "version.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(VERSION); return; }
  else if (rel.startsWith("engine/")) file = safeJoin(ENGINE_DIR, rel.slice(7).replace(/^\/*(r\d+|b[0-9a-f]+)\//, ""));
  else if (rel.startsWith("lib/")) file = safeJoin(EPOXY_DIR, rel.slice(4));
  else if (rel.startsWith("sj/controller.")) file = safeJoin(SJC_DIR, rel.slice(3));
  else if (rel.startsWith("sj/")) file = safeJoin(SJ_DIR, rel.slice(3));
  else file = safeJoin(path.join(ROOT, "player"), rel);
  if (!file) { res.writeHead(400); res.end(); return; }

  // The engine opens WebTransport from worker threads, so the relay shim has
  // to live inside the engine script that every thread loads.
  if (rel.startsWith("engine/")) {
    const engineRel = path.relative(ENGINE_DIR, file).split(path.sep).join("/");
    // Split by the GitHub Action into <name>.part00, .part01… (19 MB each):
    // 404 the whole file so the service worker fetches and rejoins the parts.
    if (!fs.existsSync(file) && fs.existsSync(file + ".part00")) { res.writeHead(404); res.end(); return; }
    if (!UPSTREAM && /\.part\d+$/.test(file) && !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const local = !CDN_ONLY && fs.existsSync(file);
    if (/\.js$/.test(engineRel)) {
      (local ? Promise.resolve(fs.readFileSync(file)) : fromCdn(engineRel)).then((code) => {
        let body = code;
        if (engineRel === "WebClient.js") {
          const shim = fs.readFileSync(path.join(ROOT, "player/wt-shim.js"), "utf8");
          body = Buffer.concat([Buffer.from(shim + "\n"), code]);
        }
        res.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": body.length, "Cache-Control": "no-store" });
        res.end(body);
      }).catch((e) => { res.writeHead(502); res.end(String(e.message)); });
      return;
    }
    if (!local) {
      // Proxied: the server fetches from upstream (GitHub or Roblox's CDN), caches it under
      // vendor/<version>/, and streams it on. The browser never hits the CDN.
      const enc = engineRel.split("/").map(encodeURIComponent).join("/");
      fetch(CDN + enc, { headers: upstreamHeaders }).then(async (r) => {
        // A 404 passes through: for split files the service worker then asks for the parts.
        if (!r.ok) { res.writeHead(r.status === 404 ? 404 : 502); res.end(`upstream ${r.status}`); return; }
        res.writeHead(200, {
          "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
          // Only when uncompressed: fetch() decodes gzip, so a compressed length would be wrong.
          ...(r.headers.get("content-length") && !r.headers.get("content-encoding") ? { "Content-Length": r.headers.get("content-length") } : {}),
          "Cache-Control": "public, max-age=86400",
        });
        let out = null, tmp = null;
        if (!CDN_ONLY) { fs.mkdirSync(path.dirname(file), { recursive: true }); tmp = `${file}.tmp${process.pid}`; out = fs.createWriteStream(tmp); }
        for await (const chunk of r.body) { res.write(chunk); out?.write(chunk); }
        res.end();
        out?.end(() => fs.rename(tmp, file, () => {}));
      }).catch((e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message)); });
      return;
    }
  }
  if (rel === "flags.json" && (CDN_ONLY || !fs.existsSync(FLAGS_FILE))) {
    (UPSTREAM ? upstreamText(`${UPSTREAM}${VERSION}.flags.json`)
      : fetch("https://clientsettingscdn.roblox.com/v2/settings/application/WebClientApp").then((r) => r.text()))
      .then((t) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }); res.end(t); })
      .catch((e) => { res.writeHead(502); res.end(String(e.message)); });
    return;
  }

  // The app's own files change often; the engine, epoxy and Scramjet are pinned.
  const pinned = /^(engine|lib|sj)\//.test(rel);
  const extra = { "Cache-Control": pinned ? "public, max-age=86400" : "no-cache" };
  if (rel === "sw.js") extra["Service-Worker-Allowed"] = "/player/";
  if (!pinned && /\.(js|html|css)$/.test(file) && fs.existsSync(file)) {
    const body = Buffer.from(stamp(fs.readFileSync(file, "utf8")));
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()], "Content-Length": body.length, ...extra,
      // HTML is the entry point and must never be cached; stamped files can be.
      "Cache-Control": /\.html$/.test(file) || /(^|\/)sw\.js$/.test(file) ? "no-store" : "public, max-age=31536000, immutable" });
    res.end(body);
    return;
  }
  sendFile(res, file, extra);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
  else if (req.url.startsWith("/wt-ws/")) wtWs(req, socket, head);
  else socket.end();
});

server.listen(PORT, () => console.log(`build ${BUILD}; WebBlox on http://localhost:${PORT}/player/  (engine ${VERSION})`));
