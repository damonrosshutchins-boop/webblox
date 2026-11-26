// Page side of the relay: answers the service worker's requests by sending
// them over Wisp with epoxy (TLS ends here), with a localStorage cookie jar
// and the header/body rewrites Roblox needs to accept the web client.
import epoxyInit, { EpoxyClient, EpoxyClientOptions } from "/player/lib/epoxy-bundled.js";
import { installProxyShims } from "/player/shims.js";

const JAR_KEY = "webblox.cookies";
const PINNED_FLAGS = "/v2/settings/application/WebClientApp";

// ---- cookie jar ------------------------------------------------------------
// Stored as { "<domain>|<path>|<name>": { value, expires } }.
function loadJar() {
  try { return JSON.parse(localStorage.getItem(JAR_KEY)) || {}; } catch { return {}; }
}
function saveJar(jar) { localStorage.setItem(JAR_KEY, JSON.stringify(jar)); }

export function setCookie(domain, name, value, { path = "/", expires = null } = {}) {
  const jar = loadJar();
  jar[`${domain.replace(/^\./, "")}|${path}|${name}`] = { value, expires };
  saveJar(jar);
}
export function getCookie(name) {
  for (const [k, v] of Object.entries(loadJar())) if (k.endsWith(`|${name}`)) return v.value;
  return null;
}
export function clearCookies() { localStorage.removeItem(JAR_KEY); }

function cookieHeader(url) {
  const now = Date.now();
  const out = [];
  const jar = loadJar();
  let dirty = false;
  for (const [k, v] of Object.entries(jar)) {
    const [domain, path, name] = k.split("|");
    if (v.expires && v.expires < now) { delete jar[k]; dirty = true; continue; }
    const hostOk = url.hostname === domain || url.hostname.endsWith("." + domain);
    if (hostOk && url.pathname.startsWith(path)) out.push(`${name}=${v.value}`);
  }
  if (dirty) saveJar(jar);
  return out.join("; ");
}

function storeSetCookie(url, line) {
  const [pair, ...attrs] = line.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  if (eq < 1) return;
  const name = pair.slice(0, eq), value = pair.slice(eq + 1);
  let domain = url.hostname, path = "/", expires = null;
  for (const a of attrs) {
    const [k, ...rest] = a.split("="); const val = rest.join("=");
    const key = k.toLowerCase();
    if (key === "domain" && val) domain = val.replace(/^\./, "");
    else if (key === "path" && val) path = val;
    else if (key === "max-age") expires = Date.now() + Number(val) * 1000;
    else if (key === "expires" && expires === null) expires = Date.parse(val) || null;
  }
  // Only accept cookies for the responding host or a parent of it.
  if (!(url.hostname === domain || url.hostname.endsWith("." + domain))) return;
  const jar = loadJar();
  const key = `${domain}|${path}|${name}`;
  if (expires !== null && expires <= Date.now()) delete jar[key];
  else jar[key] = { value, expires };
  saveJar(jar);
}

// ---- rewrites --------------------------------------------------------------
function rewriteUserAgent(ua, url) {
  return ua
    .replace(/Roblox\/Web\b.*?\bDesktop\b/, "Roblox/WinInet")
    .replace(/\s*Browser\/\S+/g, "")
    .trim();
}

const params = new URLSearchParams(location.search);
const targetGameId = params.get("gameId");

function rewriteJoinRequest(url, body) {
  if (url.hostname !== "gamejoin.roblox.com" || !targetGameId) return { url, body };
  if (!/\/v1\/join-game$/.test(url.pathname)) return { url, body };
  try {
    const json = JSON.parse(new TextDecoder().decode(body));
    json.gameId = targetGameId;
    const u = new URL(url); u.pathname = u.pathname.replace(/join-game$/, "join-game-instance");
    return { url: u, body: new TextEncoder().encode(JSON.stringify(json)).buffer };
  } catch { return { url, body }; }
}

// Finds a key anywhere in an object, case-insensitively.
function deepFind(obj, re) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj)) if (re.test(k) && v != null && typeof v !== "object") return v;
  for (const v of Object.values(obj)) { const r = deepFind(v, re); if (r !== undefined) return r; }
  return undefined;
}
const hex = (v) => (typeof v === "number" ? v.toString(16)
  : /^[A-Za-z0-9+/]+={0,2}$/.test(String(v)) && /[^0-9a-f]/i.test(String(v)) // base64
    ? [...atob(String(v))].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
  : /^\d+$/.test(String(v)) ? BigInt(v).toString(16)
  : String(v).replace(/[^0-9a-f]/gi, "").toLowerCase());
const ipHex = (ip, bump = 0) => {
  const o = ip.split(".").map(Number); o[3] += bump;
  return o.map((n) => n.toString(16).padStart(2, "0")).join("");
};

function patchJoinResponse(url, buf) {
  if (url.hostname !== "gamejoin.roblox.com") return buf;
  let json;
  try { json = JSON.parse(new TextDecoder().decode(buf)); } catch { return buf; }
  const js = json?.joinScript;
  if (js) window.__webbloxLastJoin = js; // for debugging
  if (!js || js.gameFqdn) return buf;
  try {
    const token = deepFind(js, /^netstack.?token(value)?$/i);
    const machine = js.MachineAddress, port = js.NetStackPort ?? js.ServerPort;
    const udmux = js.UdmuxEndpoints?.[0]?.Address;
    if (token == null || !machine || port == null || !udmux) {
      console.warn("[webblox] can't build gameFqdn, fields missing", { token, machine, port, udmux });
      return buf;
    }
    const machineHex = /^\d+\.\d+\.\d+\.\d+$/.test(machine) ? ipHex(machine) : hex(machine);
    js.gameFqdn = `${hex(token)}-${machineHex}-${Number(port).toString(16)}.${ipHex(udmux, 1)}.qdmux.roblox.com`;
    console.log("[webblox] built gameFqdn", js.gameFqdn);
    return new TextEncoder().encode(JSON.stringify(json)).buffer;
  } catch (e) { console.warn("[webblox] gameFqdn build failed", e); return buf; }
}

// ---- transport -------------------------------------------------------------
let client;
async function getClient() {
  if (client) return client;
  await epoxyInit();
  const opts = new EpoxyClientOptions();
  opts.user_agent = "Roblox/WinInet";
  opts.redirect_limit = 0;
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  client = new EpoxyClient(`${wsProto}//${location.host}/wisp/`, opts);
  return client;
}

const DROP_REQ = new Set(["host", "origin", "referer", "cookie", "connection", "content-length",
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);
const DROP_RES = new Set(["set-cookie", "content-encoding", "content-length", "transfer-encoding",
  "access-control-allow-origin", "access-control-allow-credentials", "access-control-expose-headers"]);

async function relay(msg) {
  let url = new URL(msg.url);

  if (url.hostname === "clientsettingscdn.roblox.com" && url.pathname === PINNED_FLAGS) {
    const r = await fetch("/player/flags.json");
    return { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: await r.arrayBuffer() };
  }

  let body = msg.body;
  ({ url, body } = rewriteJoinRequest(url, body));

  const headers = {};
  for (const [k, v] of msg.headers) {
    const key = k.toLowerCase();
    if (DROP_REQ.has(key)) continue;
    headers[key] = key === "rbx-user-agent" || key === "user-agent" ? rewriteUserAgent(v, url) : v;
  }
  // Joins keep the engine's own web user agent. Roblox then only assigns
  // servers behind the WebTransport gateway (qdmux); with a desktop user
  // agent it can pick servers the browser can't reach (error 279).
  const cookies = cookieHeader(url);
  if (cookies) headers["cookie"] = cookies;
  headers["origin"] = "https://www.roblox.com";
  headers["referer"] = "https://www.roblox.com/";

  const ep = await getClient();
  const res = await ep.fetch(url.href, { method: msg.method, headers, body: body ?? undefined, redirect: "manual" });

  const raw = res.rawHeaders || {};
  const setCookies = Object.entries(raw).filter(([k]) => k.toLowerCase() === "set-cookie").flatMap(([, v]) => (Array.isArray(v) ? v : [v]));
  for (const line of setCookies) storeSetCookie(url, line);

  const outHeaders = [];
  res.headers.forEach((v, k) => { if (!DROP_RES.has(k.toLowerCase())) outHeaders.push([k, v]); });
  let buf = await res.arrayBuffer();
  buf = patchJoinResponse(url, buf);
  return { status: res.status, statusText: res.statusText, headers: outHeaders, body: buf };
}

// ---- wiring ----------------------------------------------------------------
export async function startRelay() {
  if (!("serviceWorker" in navigator)) throw new Error("service workers unavailable");
  navigator.serviceWorker.addEventListener("message", async (e) => {
    if (e.data?.type !== "relay") return;
    const port = e.ports[0];
    try {
      const r = await relay(e.data);
      port.postMessage(r, r.body ? [r.body] : []);
    } catch (err) {
      console.error("[webblox] relay failed", e.data.url, err);
      port.postMessage({ error: String(err?.message || err) });
    }
  });
  navigator.serviceWorker.startMessages();
  await navigator.serviceWorker.register("/player/sw.js", { scope: "/player/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    // First visit: reload once so this page (and its workers) are controlled.
    location.reload();
    await new Promise(() => {});
  }
  navigator.serviceWorker.controller.postMessage({ type: "relay-ready" });
  await getClient();
  await installProxyShims(getClient);
}

// Calls the Roblox API through the same path the engine uses.
export async function robloxFetch(url, init = {}) {
  return fetch(url, { credentials: "include", ...init });
}

// Pulls .ROBLOSECURITY from Scramjet's controller cookie store, if present on
// this origin (a user who signed in to roblox.com in the app's browser).
export async function importScramjetSession() {
  const db = await new Promise((resolve) => {
    const req = indexedDB.open("__scramjet_controller");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => { req.transaction.abort(); resolve(null); };
  });
  if (!db || !db.objectStoreNames.contains("state")) { db?.close(); return false; }
  const raw = await new Promise((resolve) => {
    const r = db.transaction("state").objectStore("state").get("cookies");
    r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null);
  });
  db.close();
  // The controller stores { updatedAt, cookies: "<CookieJar.dump() JSON>" };
  // the dump is keyed "domain@path@name" with Cookie objects as values.
  let dump = raw;
  try {
    if (dump && typeof dump === "object" && typeof dump.cookies === "string") dump = JSON.parse(dump.cookies);
    else if (typeof dump === "string") dump = JSON.parse(dump);
  } catch { return false; }
  if (!dump || typeof dump !== "object") return false;

  for (const [key, c] of Object.entries(dump)) {
    const [kDomain, kPath, kName] = key.split("@");
    const name = c?.name ?? kName;
    const domain = String(c?.domain ?? kDomain ?? "").replace(/^\./, "");
    if (name !== ".ROBLOSECURITY" || !/(^|\.)roblox\.com$/.test(domain)) continue;
    if (c?.expires && c.expires < Date.now()) continue;
    const value = typeof c === "string" ? c : c?.value;
    if (value) { setCookie("roblox.com", name, value, { path: c?.path || kPath || "/" }); return true; }
  }
  return false;
}
