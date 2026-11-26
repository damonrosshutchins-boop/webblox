// Parses the ways roblox.com asks to launch the desktop app into a player
// target: { placeId, gameId?, userId? }.
//
//   roblox-player:1+launchmode:play+gameinfo:<ticket>+…+placelauncherurl:<enc URL>+…
//     placelauncherurl → PlaceLauncher.ashx?request=RequestGame|RequestGameJob|RequestFollowUser&placeId=&gameId=&userId=
//   roblox://placeId=123&gameInstanceId=…   roblox://experiences/start?placeId=123
//   https://www.roblox.com/games/start?placeId=123&gameInstanceId=…
export function parseLaunch(raw) {
  raw = String(raw).trim();
  let params = null;

  if (/^roblox-player:/i.test(raw)) {
    const parts = Object.fromEntries(raw.replace(/^roblox-player:/i, "").split("+").map((p) => {
      const i = p.indexOf(":");
      return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
    }));
    if (parts.placelauncherurl) {
      try { params = new URL(decodeURIComponent(parts.placelauncherurl)).searchParams; } catch {}
    }
  } else if (/^roblox:/i.test(raw)) {
    const q = raw.replace(/^roblox:(\/\/)?/i, "").replace(/^[^?]*\?/, (m) => (m.includes("=") ? m : ""));
    params = new URLSearchParams(q.replace(/^\?/, ""));
  } else {
    try { params = new URL(raw).searchParams; } catch {}
  }
  if (!params) return null;

  const get = (...names) => {
    for (const n of names) for (const [k, v] of params) if (k.toLowerCase() === n.toLowerCase() && v) return v;
    return null;
  };
  const placeId = get("placeId");
  const gameId = get("gameId", "gameInstanceId", "jobId");
  const userId = get("userId", "followUserId");
  const request = get("request") || "";

  if (/followuser/i.test(request) && userId) return { userId };
  if (placeId && /^\d+$/.test(placeId)) return { placeId, gameId: gameId || undefined };
  if (userId && /^\d+$/.test(userId)) return { userId };
  return null;
}

export function playerUrl({ placeId, gameId, userId }) {
  const q = new URLSearchParams();
  if (placeId) q.set("placeId", placeId);
  if (gameId) q.set("gameId", gameId);
  if (userId && !placeId) q.set("userId", userId);
  return `/player/?${q}`;
}
