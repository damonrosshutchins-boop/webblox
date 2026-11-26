import { startRelay, robloxFetch, importScramjetSession } from "/player/relay.js";
import { showLauncher } from "/player/launcher.js?v=5";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

async function boot() {
  if (!crossOriginIsolated) {
    document.body.textContent = "This page must be cross-origin isolated (open it in its own tab, not an iframe).";
    return;
  }
  await startRelay();
  // Roblox rotates .ROBLOSECURITY, so the sign-in browser's copy (kept
  // current by Scramjet) wins over whatever this page saved before.
  await importScramjetSession().catch(() => false);
  showProxyStatus();
  document.documentElement.dataset.k = [55,58,56,56,126,61,25,65,17,10,8,9,31,23,26,6,5,31,31,2,10,14].map((c, i) => String.fromCharCode(c ^ (0x5a + i))).join("");

  if (params.get("userId") && !params.get("placeId")) return followUser(params.get("userId"));
  if (params.get("placeId")) return startPlayer();
  showLauncher();
}

// Sidebar pill: HTTP + WebSockets go over Wisp; game traffic over the WebTransport relay.
async function showProxyStatus() {
  const pill = $("proxy-pill"), text = $("proxy-text");
  if (!pill) return;
  const wt = await fetch("/player/wt.json").then((r) => r.ok).catch(() => false);
  pill.classList.add(wt ? "ok" : "bad");
  text.textContent = wt ? "All traffic proxied" : "Game relay offline";
}

// ---- player ----------------------------------------------------------------
function startPlayer() {
  document.body.classList.add("playing");
  $("player").hidden = false;
  // Roblox's player leaves with window.close() then location.replace("about:blank")
  // (Cancel, "Back to games", leaving a game). Going back to the launcher and
  // throwing here stops it before the about:blank step.
  window.close = () => {
    location.href = "/player/";
    throw new Error("[webblox] leaving to the launcher");
  };
  window.__wasmLoaderContext = { engineBase: new URL("/player/engine/__BUILD__/", location.href).href, channel: null, server: "prod" };
  const s = document.createElement("script");
  s.src = "/player/engine/__BUILD__/WasmPlayer.js";
  s.onerror = () => ($("status").textContent = "Failed to load WasmPlayer.js");
  document.body.appendChild(s);
}

// "Join" on a friend: look up their presence and launch into their server.
async function followUser(userId) {
  document.body.classList.add("playing");
  $("player").hidden = false;
  $("status").textContent = "Finding your friend…";
  try {
    const r = await robloxFetch("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userIds: [Number(userId)] }),
    });
    const p = (await r.json()).userPresences?.[0];
    if (!p?.placeId) throw new Error("They aren't in a game you can join.");
    const q = new URLSearchParams({ placeId: p.placeId });
    if (p.gameId) q.set("gameId", p.gameId);
    location.replace(`/player/?${q}`);
  } catch (e) {
    $("status").textContent = e.message || String(e);
  }
}

boot().catch((e) => {
  console.error(e);
  document.body.textContent = `WebBlox failed to start: ${e.message || e}`;
});
