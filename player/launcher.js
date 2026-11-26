// WebBlox site: a Roblox-style layout (sidebar, Home, Charts, game pages,
// Friends) in WebBlox's own theme. Hash routes:
//   #/home  #/charts  #/charts/<sortId>  #/recent  #/favorites
//   #/search?q=  #/games/<placeId>  #/friends  #/friends/requests  #/friends/find
// Every Roblox call goes through the relay.
import { robloxFetch, importScramjetSession, setCookie, getCookie, clearCookies } from "/player/relay.js";
import { parseLaunch } from "/player/launch.js";

const $ = (id) => document.getElementById(id);
const RECENTS_KEY = "webblox.recent";
const CHART_SORTS = ["top-playing-now", "top-trending", "up-and-coming", "fun-with-friends", "top-revisited"];

let me = null; // { id, name, displayName }

// ---- helpers ---------------------------------------------------------------
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k);
  return n;
};
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n ?? 0));
// replaceChildren() stringifies null; skip empty slots instead.
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const likeRatio = (up, down) => (up + down > 0 ? Math.round((up / (up + down)) * 100) : null);
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return "";
  for (const [n, u] of [[31536000, "y"], [2592000, "mo"], [86400, "d"], [3600, "h"], [60, "m"]]) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return "just now";
};

// Roblox rejects the first state-changing request with 403 + x-csrf-token;
// remember the token and retry once.
let csrfToken = null;
async function rbx(url, init = {}) {
  const once = (token) => robloxFetch(url, { ...init, headers: { ...(init.headers || {}), ...(token ? { "x-csrf-token": token } : {}) } });
  // Back off on 429 (Retry-After if given, else 1s, 2s, 4s).
  const send = async (token) => {
    for (let attempt = 0; ; attempt++) {
      const r = await once(token);
      if (r.status !== 429 || attempt >= 3) return r;
      const wait = Number(r.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
      await new Promise((res) => setTimeout(res, Math.min(wait, 8000)));
    }
  };
  const sent = csrfToken;
  let r = await send(sent);
  const t = r.headers.get("x-csrf-token");
  // Compare with the token *this* request sent: parallel requests may have
  // already stored the new one, and they each still need their retry.
  if (r.status === 403 && t && t !== sent) { csrfToken = t; r = await send(t); }
  return r;
}
class RobloxError extends Error {
  constructor(status, body, challenge) {
    super(body?.errors?.[0]?.message || `HTTP ${status}`);
    this.status = status; this.code = body?.errors?.[0]?.code; this.challenge = challenge;
  }
}
async function getJson(url, init) {
  const r = await rbx(url, init);
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new RobloxError(r.status, body, r.headers.get("rblx-challenge-type") || r.headers.get("rblx-challenge-id"));
  return body;
}
const postJson = (url, body = {}) => getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function play(placeId, gameId, meta) {
  if (meta) remember({ ...meta, rootPlaceId: placeId });
  const q = new URLSearchParams({ placeId });
  if (gameId) q.set("gameId", gameId);
  location.href = `/player/?${q}`;
}

// ---- thumbnails (batched, cached) -----------------------------------------
const iconCache = new Map();
async function icons(universeIds) {
  const need = [...new Set(universeIds)].filter((id) => id && !iconCache.has(id));
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    try {
      const d = await getJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${chunk.join(",")}&size=256x256&format=Webp&isCircular=false`);
      for (const t of d.data || []) iconCache.set(t.targetId, t.imageUrl || "");
    } catch { chunk.forEach((id) => iconCache.set(id, "")); }
  }
  return iconCache;
}
const headCache = new Map();
async function headshots(userIds) {
  const need = [...new Set(userIds)].filter((id) => id && !headCache.has(id));
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    try {
      const d = await getJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${chunk.join(",")}&size=150x150&format=Webp&isCircular=true`);
      for (const t of d.data || []) headCache.set(t.targetId, t.imageUrl || "");
    } catch { chunk.forEach((id) => headCache.set(id, "")); }
  }
  return Object.fromEntries(userIds.map((id) => [id, headCache.get(id) || ""]));
}

// ---- data sources (memoized per page load) ---------------------------------
const gameMeta = new Map(); // rootPlaceId -> card data, so game pages render instantly
const keep = (g) => { if (g.rootPlaceId) gameMeta.set(String(g.rootPlaceId), { ...gameMeta.get(String(g.rootPlaceId)), ...g }); return g; };

let homeFeedP = null;
function homeFeed() {
  if (!me) return Promise.resolve({ sorts: [] });
  return (homeFeedP ??= postJson("https://apis.roblox.com/discovery-api/omni-recommendation", { pageType: "Home", sessionId: crypto.randomUUID() })
    .then((d) => {
      const games = d.contentMetadata?.Game || {};
      const sorts = [];
      for (const s of d.sorts || []) {
        const list = (s.recommendationList || []).filter((r) => r.contentType === "Game" && games[r.contentId]).map((r) => {
          const g = games[r.contentId];
          return keep({ universeId: g.universeId, rootPlaceId: g.rootPlaceId, name: g.name?.trim(), playerCount: g.playerCount,
            likeRatio: likeRatio(g.totalUpVotes, g.totalDownVotes) });
        });
        if (list.length && !sorts.some((x) => x.topic === s.topic)) sorts.push({ topic: s.topic, games: list });
      }
      return { sorts };
    })
    .catch((e) => { homeFeedP = null; throw e; }));
}
const feedSort = async (topic) => (await homeFeed()).sorts.find((s) => s.topic === topic)?.games || [];

let chartsP = null;
function charts() {
  return (chartsP ??= getJson(`https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${crypto.randomUUID()}`)
    .then((d) => (d.sorts || []).filter((s) => CHART_SORTS.includes(s.sortId) && s.games?.length)
      .sort((a, b) => CHART_SORTS.indexOf(a.sortId) - CHART_SORTS.indexOf(b.sortId))
      .map((s) => ({ id: s.sortId, title: s.sortDisplayName, games: s.games.filter((g) => !g.isSponsored).map((g) => keep({
        universeId: g.universeId, rootPlaceId: g.rootPlaceId, name: g.name, playerCount: g.playerCount,
        likeRatio: likeRatio(g.totalUpVotes, g.totalDownVotes) })) })))
    .catch((e) => { chartsP = null; throw e; }));
}

// ---- game cards & rows -----------------------------------------------------
function gameCard(g) {
  keep(g);
  const img = el("img", { alt: "", loading: "lazy", decoding: "async" });
  const src = iconCache.get(g.universeId);
  if (src) img.src = src;
  const card = el("a", { className: "game-card", href: `#/games/${g.rootPlaceId}`, title: g.name },
    el("div", { className: "thumb" }, img),
    el("div", { className: "game-name" }, g.name),
    el("div", { className: "game-meta" },
      g.likeRatio != null ? el("span", { className: "rating" }, `👍 ${g.likeRatio}%`) : null,
      g.playerCount != null ? el("span", { className: "live" }, fmt(g.playerCount)) : null));
  card.dataset.universe = g.universeId;
  return card;
}
function hydrateIcons(root) {
  const cards = [...root.querySelectorAll(".game-card[data-universe]")];
  icons(cards.map((c) => Number(c.dataset.universe))).then((cache) => {
    for (const c of cards) {
      const img = c.querySelector("img");
      const s = cache.get(Number(c.dataset.universe));
      if (s && !img.src) img.src = s;
    }
  });
}
function row(title, games, { seeAll, extra } = {}) {
  const track = el("div", { className: "track" }, games.map(gameCard));
  const prev = el("button", { className: "nav-btn", type: "button", ariaLabel: "Scroll left", textContent: "‹", onclick: () => track.scrollBy({ left: -track.clientWidth * 0.9, behavior: "smooth" }) });
  const next = el("button", { className: "nav-btn", type: "button", ariaLabel: "Scroll right", textContent: "›", onclick: () => track.scrollBy({ left: track.clientWidth * 0.9, behavior: "smooth" }) });
  const section = el("section", { className: "row" },
    el("div", { className: "row-head" },
      seeAll ? el("a", { className: "row-title", href: seeAll }, el("h2", {}, title), el("span", { className: "chev" }, "›")) : el("h2", {}, title),
      extra || null,
      el("div", { className: "row-nav" }, seeAll ? el("a", { className: "see-all", href: seeAll }, "See all") : null, prev, next)),
    track);
  hydrateIcons(section);
  return section;
}
function grid(games) {
  const g = el("div", { className: "grid" }, games.map(gameCard));
  hydrateIcons(g);
  return g;
}
const skelCard = () => el("div", { className: "game-card skel-card" }, el("div", { className: "thumb skel" }), el("div", { className: "skel skel-line" }));
const skeletonRow = () => el("section", { className: "row" },
  el("div", { className: "row-head" }, el("div", { className: "skel skel-title" })),
  el("div", { className: "track" }, Array.from({ length: 8 }, skelCard)));
const skeletonGrid = (n = 18) => el("div", { className: "grid" }, Array.from({ length: n }, skelCard));
const pageHead = (title, sub, back) => el("div", { className: "page-head" },
  back ? el("a", { className: "nav-btn", href: back, ariaLabel: "Back" }, "‹") : null,
  el("div", {}, el("h1", {}, title), sub ? el("p", { className: "muted" }, sub) : null));
const empty = (text, action) => el("div", { className: "empty" }, el("p", {}, text), action || null);

// ---- local history (signed-out fallback) ----------------------------------
function recents() { try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) || []; } catch { return []; } }
function remember(g) {
  if (!g.rootPlaceId) return;
  const list = recents().filter((r) => String(r.rootPlaceId) !== String(g.rootPlaceId));
  list.unshift({ universeId: g.universeId, rootPlaceId: g.rootPlaceId, name: g.name });
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 30)));
}

// ---- friends data ------------------------------------------------------------
// Presence types: 0 offline, 1 online (website/app), 2 in game, 3 in Studio.
const PRESENCE_ORDER = { 2: 0, 1: 1, 3: 2, 0: 3 };
async function userNames(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const d = await postJson("https://users.roblox.com/v1/users", { userIds: ids.slice(i, i + 100), excludeBannedUsers: false });
      for (const u of d.data || []) out[u.id] = { name: u.name, displayName: u.displayName || u.name };
    } catch {}
  }
  return out;
}
async function presenceOf(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const d = await postJson("https://presence.roblox.com/v1/presence/users", { userIds: ids.slice(i, i + 50) });
      for (const p of d.userPresences || []) out[p.userId] = p;
    } catch {}
  }
  return out;
}
// The full friends list in Roblox's own order, the one roblox.com uses:
// /friends/find with userSort=1 (StatusFrequents: status, then the friends
// you play with most). It pages, so it also gets past /friends' 200 cap.
async function friendIdsInRobloxOrder() {
  const ids = [];
  let cursor = "";
  for (let page = 0; page < 40; page++) {
    const d = await getJson(`https://friends.roblox.com/v1/users/${me.id}/friends/find?userSort=1&limit=50&cursor=${encodeURIComponent(cursor)}`);
    ids.push(...(d.PageItems || []).map((x) => x.id));
    if (!d.NextCursor) break;
    cursor = d.NextCursor;
  }
  return [...new Set(ids)];
}

let friendsP = null;
function loadFriends(force) {
  if (!me) return Promise.resolve([]);
  if (force) friendsP = null;
  return (friendsP ??= (async () => {
    let ids;
    try { ids = await friendIdsInRobloxOrder(); }
    catch { ids = ((await getJson(`https://friends.roblox.com/v1/users/${me.id}/friends?userSort=StatusFrequents`)).data || []).map((f) => f.id); }
    const [names, presence, heads] = await Promise.all([userNames(ids), presenceOf(ids), headshots(ids)]);
    const rank = new Map(ids.map((id, i) => [id, i]));
    const friends = ids.map((id) => ({
      id,
      displayName: names[id]?.displayName || names[id]?.name || "Friend",
      name: names[id]?.name || "",
      head: heads[id],
      p: presence[id] || { userPresenceType: 0 },
    }));
    // Live presence first (it changes faster than Roblox's ranking), then
    // Roblox's order within each group.
    return friends.sort((a, b) => (PRESENCE_ORDER[a.p.userPresenceType] ?? 9) - (PRESENCE_ORDER[b.p.userPresenceType] ?? 9)
      || rank.get(a.id) - rank.get(b.id));
  })().catch((e) => { friendsP = null; throw e; }));
}
async function requestCount() {
  if (!me) return 0;
  try { return (await getJson("https://friends.roblox.com/v1/user/friend-requests/count")).count || 0; } catch { return 0; }
}

function friendTile(f) {
  const type = f.p.userPresenceType;
  const playing = type === 2;
  const canJoin = playing && f.p.placeId;
  const state = playing ? "playing" : type === 1 ? "online" : type === 3 ? "studio" : "offline";
  const status = playing ? (f.p.lastLocation || "In a game") : type === 1 ? "Online" : type === 3 ? "In Studio" : "Offline";
  const b = el("button", { className: `friend ${state}`, type: "button" },
    el("div", { className: "friend-avatar" }, el("img", { alt: "", src: f.head || "", loading: "lazy" }), el("i", { className: "dot" })),
    el("div", { className: "friend-name" }, f.displayName),
    el("div", { className: "friend-status" }, status));
  b.title = canJoin ? `Join ${f.displayName} in ${f.p.lastLocation || "their game"}` : `${f.displayName} (@${f.name}) · ${status}`;
  b.onclick = canJoin ? () => play(f.p.placeId, f.p.gameId, { universeId: f.p.universeId, name: f.p.lastLocation }) : () => openProfile(f.id);
  return b;
}
function openProfile(userId) {
  window.open("/player/browser.html?url=" + encodeURIComponent(`https://www.roblox.com/users/${userId}/profile`), "_blank");
}

// ---- pages -------------------------------------------------------------------
async function pageHome(view) {
  if (!me) {
    view.append(el("section", { className: "hero" },
      el("h1", {}, "Play Roblox right in your browser."),
      el("p", {}, "No download. Sign in with your Roblox account, pick a game, and you're in."),
      el("div", { className: "hero-actions" },
        el("a", { className: "btn primary lg", href: "/player/browser.html" }, "Sign in with Roblox"),
        el("button", { className: "btn ghost lg", type: "button", onclick: () => $("cookie-dialog").showModal() }, "Use a session cookie"))));
    const local = recents();
    if (local.length) view.append(row("Recently played", local));
  } else {
    view.append(el("div", { className: "greeting" },
      el("img", { className: "avatar xl", alt: "", src: headCache.get(me.id) || "" }),
      el("div", {}, el("h1", {}, `Hello, ${me.displayName || me.name}!`), el("p", { className: "muted" }, "@" + me.name))));
  }

  const friendsSlot = el("div");
  const feedSlot = el("div", {}, skeletonRow(), skeletonRow());
  const chartsSlot = el("div");
  view.append(friendsSlot, feedSlot, chartsSlot);

  if (me) {
    loadFriends().then((friends) => {
      const reqLink = el("a", { className: "see-all", href: "#/friends/find" }, "+ Add");
      friendsSlot.replaceChildren(el("section", { className: "row" },
        el("div", { className: "row-head" },
          el("a", { className: "row-title", href: "#/friends" }, el("h2", {}, `Friends (${friends.length})`), el("span", { className: "chev" }, "›")),
          el("div", { className: "row-nav" }, reqLink, el("a", { className: "see-all", href: "#/friends" }, "See all"))),
        el("div", { className: "track friends-track" }, addFriendTile(), friends.slice(0, 40).map(friendTile))));
    }).catch(() => {});
    homeFeed().then(({ sorts }) => {
      const pick = (t) => sorts.find((s) => s.topic === t);
      const out = [];
      const cont = pick("Continue");
      if (cont) out.push(row("Recently played", cont.games.slice(0, 30), { seeAll: "#/recent" }));
      const favs = pick("Favorites");
      if (favs) out.push(row("Favorites", favs.games.slice(0, 30), { seeAll: "#/favorites" }));
      for (const s of sorts) if (!["Continue", "Favorites", "Friends"].includes(s.topic)) out.push(row(s.topic, s.games.slice(0, 30)));
      fill(feedSlot, out);
    }).catch(() => feedSlot.replaceChildren());
  } else {
    feedSlot.replaceChildren();
  }

  charts().then((sorts) => {
    chartsSlot.replaceChildren(...sorts.slice(0, me ? 2 : 5).map((s) => row(s.title, s.games.slice(0, 30), { seeAll: `#/charts/${s.id}` })));
  }).catch((e) => chartsSlot.replaceChildren(empty(`Couldn't load games (${e.message}).`)));
}

function addFriendTile() {
  const b = el("a", { className: "friend add-friend", href: "#/friends/find", title: "Add friends" },
    el("div", { className: "friend-avatar" }, el("div", { className: "add-circle" }, "+")),
    el("div", { className: "friend-name" }, "Add friends"),
    el("div", { className: "friend-status" }, "Find people"));
  requestCount().then((n) => {
    if (!n) return;
    b.href = "#/friends/requests";
    b.querySelector(".friend-avatar").append(el("i", { className: "badge" }, n > 99 ? "99+" : String(n)));
    b.querySelector(".friend-name").textContent = "Requests";
    b.querySelector(".friend-status").textContent = `${n} pending`;
  });
  return b;
}

async function pageCharts(view, sortId) {
  if (sortId) {
    view.append(pageHead("Charts", null, "#/charts"), skeletonGrid());
    try {
      const s = (await charts()).find((x) => x.id === sortId);
      view.replaceChildren(pageHead(s?.title || "Charts", s ? `${s.games.length} games` : null, "#/charts"), s ? grid(s.games) : empty("That chart isn't available right now."));
    } catch (e) { view.replaceChildren(pageHead("Charts", null, "#/charts"), empty(`Couldn't load charts (${e.message}).`)); }
    return;
  }
  view.append(pageHead("Charts", "What people are playing right now"), skeletonRow(), skeletonRow());
  try {
    const sorts = await charts();
    view.replaceChildren(pageHead("Charts", "What people are playing right now"),
      ...sorts.map((s) => row(s.title, s.games.slice(0, 30), { seeAll: `#/charts/${s.id}` })));
  } catch (e) { view.replaceChildren(pageHead("Charts"), empty(`Couldn't load charts (${e.message}).`)); }
}

async function pageFeedGrid(view, topic, title, emptyText) {
  view.append(pageHead(title), skeletonGrid());
  if (!me) {
    const local = topic === "Continue" ? recents() : [];
    view.replaceChildren(pageHead(title), local.length ? grid(local)
      : empty(emptyText, el("a", { className: "btn primary", href: "/player/browser.html" }, "Sign in")));
    return;
  }
  try {
    const games = await feedSort(topic);
    view.replaceChildren(pageHead(title, games.length ? `${games.length} games` : null), games.length ? grid(games) : empty(emptyText));
  } catch (e) { view.replaceChildren(pageHead(title), empty(`Couldn't load (${e.message}).`)); }
}

let searchSeq = 0;
async function pageSearch(view, q) {
  const seq = ++searchSeq;
  $("q").value = q;
  view.append(pageHead(`Results for “${q}”`), skeletonGrid());
  try {
    const d = await getJson(`https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(q)}&sessionId=${crypto.randomUUID()}&pageType=all`);
    if (seq !== searchSeq) return;
    const games = (d.searchResults || []).filter((g) => g.contentGroupType === "Game").flatMap((g) => g.contents || []).map((g) => ({
      universeId: g.universeId, rootPlaceId: g.rootPlaceId, name: g.name, creatorName: g.creatorName,
      playerCount: g.playerCount, likeRatio: likeRatio(g.totalUpVotes, g.totalDownVotes) }));
    view.replaceChildren(pageHead(`Results for “${q}”`, games.length ? `${games.length} games` : null), games.length ? grid(games.slice(0, 60)) : empty("No games found."));
  } catch (e) {
    if (seq === searchSeq) view.replaceChildren(pageHead(`Results for “${q}”`), empty(`Search failed (${e.message}).`));
  }
}

// ---- game page ---------------------------------------------------------------
async function pageGame(view, placeId) {
  const known = gameMeta.get(String(placeId)) || {};
  let info = { rootPlaceId: placeId, name: known.name };
  const playBtn = el("button", { className: "btn primary xl play-btn", type: "button", ariaLabel: "Play",
    innerHTML: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>Play' });
  playBtn.onclick = () => play(placeId, null, { ...known, ...info });

  const mainImg = el("img", { alt: "" });
  const thumbs = el("div", { className: "media-thumbs" });
  const media = el("div", { className: "media" }, el("div", { className: "media-main" }, mainImg), thumbs);
  if (known.universeId && iconCache.get(known.universeId)) mainImg.src = iconCache.get(known.universeId);

  const title = el("h1", {}, known.name || "");
  const creator = el("div", { className: "creator" });
  const votes = el("div", { className: "votes" });
  const side = el("div", { className: "game-side" }, title, creator, el("div", { className: "play-wrap" }, playBtn), votes);
  const stats = el("div", { className: "stats" });
  const desc = el("p", { className: "desc" });

  const aboutPane = el("div", { className: "tab-pane" }, el("h2", {}, "Description"), desc, stats);
  const serversPane = el("div", { className: "tab-pane", hidden: true });
  const tabAbout = el("button", { className: "tab", type: "button", ariaSelected: "true" }, "About");
  const tabServers = el("button", { className: "tab", type: "button", ariaSelected: "false" }, "Servers");
  const selectTab = (which) => {
    tabAbout.setAttribute("aria-selected", String(which === "about"));
    tabServers.setAttribute("aria-selected", String(which === "servers"));
    aboutPane.hidden = which !== "about";
    serversPane.hidden = which !== "servers";
    if (which === "servers" && !serversPane.dataset.loaded) { serversPane.dataset.loaded = "1"; loadServers(serversPane, placeId); }
  };
  tabAbout.onclick = () => selectTab("about");
  tabServers.onclick = () => selectTab("servers");

  view.append(
    el("div", { className: "game-top" }, media, side),
    el("div", { className: "tabs", role: "tablist" }, tabAbout, tabServers),
    aboutPane, serversPane);

  try {
    let universeId = known.universeId;
    if (!universeId) universeId = (await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)).universeId;
    if (!universeId) { view.replaceChildren(empty("That game doesn't exist or isn't public.", el("a", { className: "btn primary", href: "#/home" }, "Back home"))); return; }
    const [g, v, shots] = await Promise.all([
      getJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`).then((d) => d.data?.[0]),
      getJson(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`).then((d) => d.data?.[0]).catch(() => null),
      getJson(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeId}&countPerUniverse=10&size=768x432&format=Webp`)
        .then((d) => (d.data?.[0]?.thumbnails || []).map((t) => t.imageUrl).filter(Boolean)).catch(() => []),
    ]);
    if (!g) throw new Error("Game not found");
    info = keep({ universeId, rootPlaceId: g.rootPlaceId || placeId, name: g.name, creatorName: g.creator?.name, playerCount: g.playing });
    document.title = `${g.name} · WebBlox`;
    title.textContent = g.name;
    fill(creator, "By ", el("strong", {}, g.creator?.name || "Unknown"), g.creator?.hasVerifiedBadge ? el("span", { className: "verified", title: "Verified" }, "✔") : null);
    desc.textContent = g.description || "No description.";

    if (shots.length) {
      mainImg.src = shots[0];
      if (shots.length > 1) thumbs.replaceChildren(...shots.map((src, i) => {
        const b = el("button", { type: "button", className: i === 0 ? "active" : "" }, el("img", { alt: "", src, loading: "lazy" }));
        b.onclick = () => { mainImg.src = src; thumbs.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b)); };
        return b;
      }));
    } else {
      icons([universeId]).then((c) => { if (c.get(universeId)) mainImg.src = c.get(universeId); });
    }

    if (v) {
      const r = likeRatio(v.upVotes, v.downVotes);
      fill(votes,
        el("div", { className: "vote-bar" }, el("i", { style: `width:${r ?? 0}%` })),
        el("div", { className: "vote-counts" }, el("span", {}, `👍 ${fmt(v.upVotes)}`), el("span", {}, r != null ? `${r}%` : ""), el("span", {}, `👎 ${fmt(v.downVotes)}`)));
    }
    const stat = (label, value) => el("div", { className: "stat" }, el("span", {}, label), el("strong", {}, value));
    fill(stats,
      stat("Active", fmt(g.playing)),
      stat("Favorites", fmt(g.favoritedCount)),
      stat("Visits", fmt(g.visits)),
      stat("Server size", String(g.maxPlayers)),
      stat("Genre", g.genre_l1 || g.genre || "—"),
      stat("Created", new Date(g.created).toLocaleDateString()),
      stat("Updated", new Date(g.updated).toLocaleDateString()),
      g.price ? stat("Price", `R$ ${g.price}`) : null,
    );
  } catch (e) {
    if (!title.textContent) view.replaceChildren(empty(`Couldn't load this game (${e.message}).`, el("a", { className: "btn primary", href: "#/home" }, "Back home")));
  }
}

async function loadServers(pane, placeId, cursor, append) {
  if (!append) pane.replaceChildren(el("div", { className: "servers-head" }, el("h2", {}, "Servers"),
    el("button", { className: "btn ghost sm", type: "button", textContent: "Refresh", onclick: () => loadServers(pane, placeId) })),
    el("ul", { className: "servers" }, el("li", { className: "muted pad" }, "Loading servers…")));
  const list = pane.querySelector(".servers");
  try {
    const d = await getJson(`https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=25&sortOrder=Desc&excludeFullGames=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!append) list.replaceChildren();
    pane.querySelector(".more")?.remove();
    const servers = d.data || [];
    if (!servers.length && !append) { list.append(el("li", { className: "muted pad" }, "No public servers right now. Press Play to start one.")); return; }
    for (const s of servers) {
      const full = s.playing >= s.maxPlayers;
      list.append(el("li", { className: "server" },
        el("div", { className: "server-fill" },
          el("div", { className: "server-count" }, el("strong", {}, `${s.playing ?? 0}`), ` / ${s.maxPlayers} players`),
          el("div", { className: "fill-bar" }, el("i", { style: `width:${Math.min(100, ((s.playing ?? 0) / s.maxPlayers) * 100)}%` }))),
        el("div", { className: "server-meta muted" }, s.ping != null ? `${Math.round(s.ping)} ms` : "", s.fps ? ` · ${Math.round(s.fps)} fps` : ""),
        el("button", { className: "btn " + (full ? "ghost" : "primary") + " sm", type: "button", disabled: full, textContent: full ? "Full" : "Join",
          onclick: () => play(placeId, s.id, gameMeta.get(String(placeId))) })));
    }
    if (d.nextPageCursor) pane.append(el("button", { className: "btn ghost more", type: "button", textContent: "Load more",
      onclick: () => loadServers(pane, placeId, d.nextPageCursor, true) }));
  } catch (e) {
    list.replaceChildren(el("li", { className: "muted pad" }, `Couldn't load servers (${e.message}).`));
  }
}

// ---- friends page --------------------------------------------------------------
async function pageFriends(view, tab = "all") {
  if (!me) {
    view.append(pageHead("Friends"), empty("Sign in to see your friends.", el("a", { className: "btn primary", href: "/player/browser.html" }, "Sign in")));
    return;
  }
  const tabs = el("div", { className: "tabs", role: "tablist" },
    [["all", "Friends", "#/friends"], ["requests", "Requests", "#/friends/requests"], ["find", "Find people", "#/friends/find"]].map(([id, label, href]) =>
      el("a", { className: "tab", href, role: "tab", ariaSelected: String(tab === id) }, label, id === "requests" ? el("i", { className: "tab-badge", hidden: true }) : null)));
  const body = el("div");
  view.append(pageHead("Friends"), tabs, body);
  requestCount().then((n) => { const b = tabs.querySelector(".tab-badge"); if (n && b) { b.textContent = n > 99 ? "99+" : n; b.hidden = false; } });

  if (tab === "requests") return friendRequests(body);
  if (tab === "find") return findPeople(body);

  body.append(el("p", { className: "muted pad" }, "Loading friends…"));
  try {
    const friends = await loadFriends(true);
    if (!friends.length) { body.replaceChildren(empty("No friends yet.", el("a", { className: "btn primary", href: "#/friends/find" }, "Find people"))); return; }
    const filter = el("input", { className: "filter", type: "search", placeholder: `Filter ${friends.length} friends`, ariaLabel: "Filter friends" });
    const groups = el("div");
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = friends.filter((f) => !q || f.displayName.toLowerCase().includes(q) || f.name.toLowerCase().includes(q));
      const section = (label, list) => list.length ? el("section", { className: "friend-group" },
        el("h2", {}, label, el("span", { className: "count" }, String(list.length))),
        el("div", { className: "friend-grid" }, list.map(friendTile))) : null;
      fill(groups,
        section("In game", shown.filter((f) => f.p.userPresenceType === 2)),
        section("Online", shown.filter((f) => f.p.userPresenceType === 1 || f.p.userPresenceType === 3)),
        section("Offline", shown.filter((f) => !f.p.userPresenceType)),
      );
      if (!groups.childElementCount) groups.append(empty("No friends match that."));
    };
    filter.oninput = render;
    render();
    body.replaceChildren(filter, groups);
  } catch (e) { body.replaceChildren(empty(`Couldn't load friends (${e.message}).`)); }
}

function personRow(user, head, actions, sub) {
  return el("li", { className: "person" },
    el("img", { className: "avatar lg", alt: "", src: head || "" }),
    el("div", { className: "person-info" },
      el("strong", {}, user.displayName || user.name),
      el("span", { className: "muted" }, "@" + user.name + (sub ? ` · ${sub}` : ""))),
    el("div", { className: "person-actions" }, actions));
}
function actionError(e, userId) {
  if (e.challenge || e.code === 14 || /challenge|captcha/i.test(e.message)) {
    return el("span", { className: "action-note" }, "Roblox wants a captcha. ",
      el("button", { className: "link-btn inline", type: "button", textContent: "Do it on their profile", onclick: () => openProfile(userId) }));
  }
  return el("span", { className: "action-note error" }, e.message || "Failed");
}
async function friendAction(btn, userId, path, body, done) {
  const cell = btn.parentElement;
  cell.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await postJson(`https://friends.roblox.com/v1/users/${userId}/${path}`, body);
    friendsP = null;
    done(cell);
  } catch (e) {
    cell.querySelectorAll("button").forEach((b) => (b.disabled = false));
    cell.querySelector(".action-note")?.remove();
    cell.append(actionError(e, userId));
  }
}
const tag = (text) => el("span", { className: "pill-tag" }, text);

async function friendRequests(body) {
  body.replaceChildren(el("p", { className: "muted pad" }, "Loading requests…"));
  try {
    const d = await getJson("https://friends.roblox.com/v1/my/friends/requests?limit=50&sortOrder=Desc");
    const reqs = d.data || [];
    if (!reqs.length) { body.replaceChildren(empty("No pending friend requests.", el("a", { className: "btn ghost", href: "#/friends/find" }, "Find people"))); return; }
    const ids = reqs.map((r) => r.id);
    const [names, heads] = await Promise.all([userNames(ids), headshots(ids)]);
    body.replaceChildren(el("ul", { className: "people" }, reqs.map((r) => {
      const u = { id: r.id, name: names[r.id]?.name || String(r.id), displayName: names[r.id]?.displayName };
      const accept = el("button", { className: "btn primary sm", type: "button", textContent: "Accept" });
      const ignore = el("button", { className: "btn ghost sm", type: "button", textContent: "Ignore" });
      accept.onclick = () => friendAction(accept, r.id, "accept-friend-request", {}, (cell) => cell.replaceChildren(tag("Friends")));
      ignore.onclick = () => friendAction(ignore, r.id, "decline-friend-request", {}, (cell) => cell.closest("li").remove());
      const sub = [r.mutualFriendsList?.length ? `${r.mutualFriendsList.length} mutual` : null, r.friendRequest?.sentAt ? ago(r.friendRequest.sentAt) : null].filter(Boolean).join(" · ");
      return personRow(u, heads[r.id], [ignore, accept], sub);
    })));
  } catch (e) { body.replaceChildren(empty(`Couldn't load requests (${e.message}).`)); }
}

function findPeople(body) {
  const input = el("input", { className: "filter", type: "search", placeholder: "Search by username or display name", ariaLabel: "Search people" });
  const list = el("ul", { className: "people" });
  let seq = 0, timer;
  const run = async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 3) { list.replaceChildren(el("li", { className: "muted pad" }, q ? "Type at least 3 characters." : "Search for people to add.")); return; }
    list.replaceChildren(el("li", { className: "muted pad" }, "Searching…"));
    try {
      const d = await getJson(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(q)}&limit=25`);
      if (my !== seq) return;
      const users = (d.data || []).filter((u) => u.id !== me.id);
      if (!users.length) { list.replaceChildren(el("li", { className: "muted pad" }, "No one found.")); return; }
      const ids = users.map((u) => u.id);
      const [heads, statuses] = await Promise.all([
        headshots(ids),
        getJson(`https://friends.roblox.com/v1/users/${me.id}/friends/statuses?userIds=${ids.join(",")}`)
          .then((s) => Object.fromEntries((s.data || []).map((x) => [x.id, x.status]))).catch(() => ({})),
      ]);
      if (my !== seq) return;
      list.replaceChildren(...users.map((u) => {
        const status = statuses[u.id]; // NotFriends | Friends | RequestSent | RequestReceived
        const profile = el("button", { className: "btn ghost sm", type: "button", textContent: "Profile", onclick: () => openProfile(u.id) });
        let action;
        if (status === "Friends") action = tag("Friends");
        else if (status === "RequestSent") action = tag("Requested");
        else if (status === "RequestReceived") {
          action = el("button", { className: "btn primary sm", type: "button", textContent: "Accept" });
          action.onclick = () => friendAction(action, u.id, "accept-friend-request", {}, () => action.replaceWith(tag("Friends")));
        } else {
          action = el("button", { className: "btn primary sm", type: "button", textContent: "Add friend" });
          action.onclick = () => friendAction(action, u.id, "request-friendship", { friendshipOriginSourceType: "PlayerSearch" }, () => action.replaceWith(tag("Requested")));
        }
        return personRow(u, heads[u.id], [profile, action], u.hasVerifiedBadge ? "verified" : null);
      }));
    } catch (e) {
      if (my === seq) list.replaceChildren(el("li", { className: "muted pad" }, `Search failed (${e.message}).`));
    }
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  body.replaceChildren(input, list);
  run();
  setTimeout(() => input.focus(), 0);
}

// ---- account ------------------------------------------------------------------
async function refreshAccount() {
  const chip = $("account");
  chip.replaceChildren();
  me = null;
  homeFeedP = friendsP = null;
  if (getCookie(".ROBLOSECURITY")) {
    try { me = await getJson("https://users.roblox.com/v1/users/authenticated"); } catch {}
  }
  const sideMe = $("side-me");
  if (!me) {
    chip.append(el("a", { className: "btn primary", href: "/player/browser.html" }, "Sign in"));
    sideMe.hidden = true;
    $("side-req").hidden = true;
    return;
  }
  await headshots([me.id]);
  const avatar = el("img", { className: "avatar", alt: "", src: headCache.get(me.id) || "" });
  const menu = el("div", { className: "menu", hidden: true },
    el("div", { className: "menu-head" }, el("strong", {}, me.displayName || me.name), el("span", { className: "muted" }, "@" + me.name)),
    el("a", { href: "/player/browser.html?url=" + encodeURIComponent(`https://www.roblox.com/users/${me.id}/profile`), target: "_blank" }, "My profile"),
    el("a", { href: "/player/browser.html?url=" + encodeURIComponent("https://www.roblox.com/home"), target: "_blank" }, "Open Roblox website"),
    el("button", { type: "button", textContent: "Sign out", onclick: signOut }));
  const toggle = el("button", { className: "account-btn", type: "button", ariaLabel: "Account" }, avatar, el("span", {}, me.displayName || me.name));
  toggle.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  chip.append(toggle, menu);

  sideMe.hidden = false;
  sideMe.querySelector("img").src = headCache.get(me.id) || "";
  sideMe.querySelector("span").textContent = me.displayName || me.name;
  requestCount().then((n) => { const b = $("side-req"); b.hidden = !n; b.textContent = n > 99 ? "99+" : n; });
}
async function signOut() {
  clearCookies();
  // Also clear the sign-in browser's saved session so it isn't re-imported.
  await new Promise((res) => { const r = indexedDB.deleteDatabase("__scramjet_controller"); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  await refreshAccount();
  route();
}

// ---- router -------------------------------------------------------------------
let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  const hash = location.hash.replace(/^#/, "") || "/home";
  const [path, qs] = hash.split("?");
  const parts = path.split("/").filter(Boolean);
  const view = $("view");
  view.replaceChildren();
  document.title = "WebBlox";
  closeSidebar();

  const section = parts[0] === "games" ? "" : parts[0];
  for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("active", a.dataset.nav === section);
  if (parts[0] !== "search") $("q").value = "";

  const scrollTop = () => { if (seq === routeSeq) window.scrollTo(0, 0); };
  scrollTop();
  switch (parts[0]) {
    case "charts": return pageCharts(view, parts[1]);
    case "recent": return pageFeedGrid(view, "Continue", "Recently played", "Games you play show up here.");
    case "favorites": return pageFeedGrid(view, "Favorites", "Favorites", "Favorite games on Roblox to see them here.");
    case "search": return pageSearch(view, new URLSearchParams(qs).get("q") || "");
    case "games": return pageGame(view, parts[1]);
    case "friends": return pageFriends(view, parts[1] || "all");
    default: return pageHome(view);
  }
}

function linkTarget(q) {
  if (/^\d{5,}$/.test(q)) return { placeId: q };
  const games = /roblox\.com\/(?:[a-z]{2}\/)?games\/(\d+)/i.exec(q);
  if (games) {
    let gameId = null;
    try { gameId = new URL(q.startsWith("http") ? q : "https://" + q).searchParams.get("gameInstanceId"); } catch {}
    return { placeId: games[1], gameId };
  }
  if (/^roblox(-player)?:|^https?:\/\/(www\.)?roblox\.com\/games\/start/i.test(q)) {
    const t = parseLaunch(q);
    if (t?.placeId) return t;
  }
  return null;
}

function openSidebar() { $("sidebar").classList.add("open"); $("scrim").hidden = false; }
function closeSidebar() { $("sidebar").classList.remove("open"); $("scrim").hidden = true; }

// ---- wiring --------------------------------------------------------------------
export async function showLauncher() {
  $("launcher").hidden = false;

  // Old ?q= links still work.
  const legacyQ = new URLSearchParams(location.search).get("q");
  if (legacyQ) history.replaceState(null, "", `/player/#/search?q=${encodeURIComponent(legacyQ)}`);

  $("search-form").onsubmit = (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    if (!q) return;
    const target = linkTarget(q);
    if (target?.gameId) return play(target.placeId, target.gameId);
    if (target) { location.hash = `#/games/${target.placeId}`; return; }
    location.hash = `#/search?q=${encodeURIComponent(q)}`;
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName) && !document.querySelector("dialog[open]")) { e.preventDefault(); $("q").focus(); }
    if (e.key === "Escape") closeSidebar();
  });
  document.addEventListener("click", () => { const m = document.querySelector(".menu"); if (m) m.hidden = true; });
  $("menu-toggle").onclick = () => ($("sidebar").classList.contains("open") ? closeSidebar() : openSidebar());
  $("scrim").onclick = closeSidebar;

  $("cookie-form").onsubmit = async (e) => {
    e.preventDefault();
    const v = $("cookie").value.trim();
    if (v) setCookie("roblox.com", ".ROBLOSECURITY", v);
    $("cookie").value = "";
    $("cookie-dialog").close();
    await refreshAccount();
    route();
  };
  $("cookie-cancel").onclick = () => $("cookie-dialog").close();
  // Coming back from the sign-in tab: pick up the new session.
  window.addEventListener("focus", async () => { if (!me && await importScramjetSession()) { await refreshAccount(); route(); } });

  window.addEventListener("hashchange", route);
  await refreshAccount();
  route();
}
