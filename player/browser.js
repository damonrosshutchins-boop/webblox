// In-app browser (Scramjet 2) for signing in to roblox.com. Its cookie jar is
// saved by the controller in IndexedDB, where the player page reads
// .ROBLOSECURITY. A frame plugin catches roblox.com trying to launch the
// desktop app and opens the WebBlox player instead.
import { EpoxyTransport } from "/player/transport.js";
import { parseLaunch, playerUrl } from "/player/launch.js";

const $ = (id) => document.getElementById(id);
const { Controller, ManagedPlugin } = $scramjetController;

const START_URL = new URLSearchParams(location.search).get("url") || "https://www.roblox.com/login";

// ---- launch interception ---------------------------------------------------
const ROBLOX_SCHEME = /^roblox(-player)?:/i;

function isLaunchUrl(value, base) {
  if (typeof value !== "string" && !(value instanceof URL)) return false;
  const s = String(value).trim();
  if (ROBLOX_SCHEME.test(s)) return true;
  try {
    const u = new URL(s, base);
    return /(^|\.)roblox\.com$/i.test(u.hostname) && /^\/games\/start\/?$/i.test(u.pathname) && u.searchParams.has("placeId");
  } catch { return false; }
}

let pendingLaunch = null;
function launch(raw) {
  const target = parseLaunch(String(raw));
  if (!target) { console.warn("[webblox] launch not understood", raw); return; }
  const url = playerUrl(target);
  pendingLaunch = url;
  // Opening needs user activation; if the browser blocks it, the banner's
  // button opens it instead.
  const w = window.open(url, "_blank");
  $("launch-text").textContent = target.userId && !target.placeId ? "Joining your friend…" : "Game ready.";
  $("launch-banner").hidden = !!w;
}

class LaunchCatcher extends ManagedPlugin {
  constructor() { super("webblox-launch", []); }

  install(frame) {
    super.install(frame);
    this.tap(frame.hooks.init.pre, ({ window: w, isTopLevel }) => this.patch(w, isTopLevel));
  }

  patch(w, isTopLevel) {
    const prefix = this.frame.prefix;
    // The proxied page's real URL, for resolving relative links.
    const realUrl = () => {
      try {
        const p = w.location.pathname;
        if (p.startsWith(prefix)) return decodeURIComponent(p.slice(prefix.length)) + w.location.search;
      } catch {}
      return "https://www.roblox.com/";
    };

    // Top-level navigation to /games/start: launch, then go back.
    if (isTopLevel && isLaunchUrl(realUrl())) {
      launch(realUrl());
      w.history.length > 1 ? w.history.back() : this.frame.go("https://www.roblox.com/home");
      return;
    }

    const guard = (value) => {
      if (!isLaunchUrl(value, realUrl())) return false;
      const s = String(value).trim();
      launch(ROBLOX_SCHEME.test(s) ? s : new URL(s, realUrl()).href);
      return true;
    };

    // iframe.src = "roblox-player:…"
    const iframeSrc = Object.getOwnPropertyDescriptor(w.HTMLIFrameElement.prototype, "src");
    if (iframeSrc?.set) {
      Object.defineProperty(w.HTMLIFrameElement.prototype, "src", {
        ...iframeSrc,
        set(v) { if (!guard(v)) iframeSrc.set.call(this, v); },
      });
    }

    // iframe.setAttribute("src", "roblox-player:…")
    const setAttribute = w.Element.prototype.setAttribute;
    w.Element.prototype.setAttribute = function (name, value) {
      if (this instanceof w.HTMLIFrameElement && String(name).toLowerCase() === "src" && guard(value)) return;
      return setAttribute.call(this, name, value);
    };

    // window.open("roblox-player:…" | "/games/start?placeId=…")
    const open = w.open;
    w.open = function (url, ...rest) {
      if (url != null && guard(url)) return null;
      return open.call(this, url, ...rest);
    };

    // <a href="roblox-player:…"> / <a href="/games/start?placeId=…"> clicks,
    // including programmatic a.click().
    w.document.addEventListener("click", (e) => {
      const a = e.target?.closest?.("a[href]");
      if (!a) return;
      const href = a.getAttribute("href");
      if (guard(href)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    // location = "roblox-player:…" and anything else the patches miss.
    w.navigation?.addEventListener("navigate", (e) => {
      const dest = e.destination?.url;
      if (dest && ROBLOX_SCHEME.test(dest) && guard(dest)) e.preventDefault();
    });
  }
}

// ---- browser chrome ---------------------------------------------------------
function decodeFrameUrl(frame) {
  try {
    const p = frame.element.contentWindow.location.pathname;
    if (!p.startsWith(frame.prefix)) return null;
    return decodeURIComponent(p.slice(frame.prefix.length)) + frame.element.contentWindow.location.search + frame.element.contentWindow.location.hash;
  } catch { return null; }
}

function normalizeInput(text) {
  text = text.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(text)) return "https://" + text;
  return "https://www.roblox.com/discover?Keyword=" + encodeURIComponent(text);
}

async function registerWorker() {
  await navigator.serviceWorker.register("/player/sw.js", { scope: "/player/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    location.reload();
    await new Promise(() => {});
  }
  return navigator.serviceWorker.controller;
}

async function boot() {
  const sw = await registerWorker();
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const transport = new EpoxyTransport(`${wsProto}//${location.host}/wisp/`);
  await transport.init();

  const controller = new Controller({
    serviceworker: sw,
    transport,
    config: {
      prefix: "/player/~/sj/",
      scramjetPath: "/player/sj/scramjet.js",
      injectPath: "/player/sj/controller.inject.js",
      wasmPath: "/player/sj/scramjet.wasm",
    },
  });
  await controller.wait();

  const frame = controller.createFrame($("frame"), { plugins: [new LaunchCatcher()] });
  window.__webbloxFrame = frame; // for debugging

  $("frame").addEventListener("load", () => {
    const real = decodeFrameUrl(frame);
    if (real) $("url").value = real;
  });
  $("url-form").onsubmit = (e) => { e.preventDefault(); const u = normalizeInput($("url").value); if (u) frame.go(u); };
  $("back").onclick = () => frame.back();
  $("forward").onclick = () => frame.forward();
  $("reload").onclick = () => frame.reload();
  $("launch-open").onclick = () => { if (pendingLaunch) window.open(pendingLaunch, "_blank"); $("launch-banner").hidden = true; };
  $("launch-dismiss").onclick = () => ($("launch-banner").hidden = true);

  $("boot-status").remove();
  $("frame").classList.add("ready");
  $("url").value = START_URL;
  frame.go(START_URL);
}

boot().catch((e) => {
  console.error(e);
  $("boot-status").textContent = `Browser failed to start: ${e.message || e}`;
});
