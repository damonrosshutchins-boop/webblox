# WebBlox

Roblox's official browser client (`WebClientApp`, Emscripten/wasm), self-hosted, with every request (HTTP, WebSockets and game traffic) sent through your server.

## Self-hosting

Docker (recommended; the WebTransport module needs glibc 2.38+):

```
docker compose up -d     # http://localhost:8080/player/
```

Or with Node 22 on a recent distro:

```
npm install
ENGINE_SOURCE=github:ytsodacan/webblox-files CDN_ONLY=1 npm start
```

Serve it over HTTPS (service workers need it), e.g. behind a Cloudflare tunnel or Caddy. WebSocket upgrades must pass through.

Environment:
- `PORT` (default 8080).
- `ENGINE_SOURCE=github:owner/repo[@branch]`: engine files come from that repo; browsers download them straight from jsDelivr (raw GitHub as fallback). Build your own copy with `.github/workflows/fetch-vendor.yml` in a repo of your own. `GITHUB_TOKEN` for a private repo.
- `CDN_ONLY=1`: ignore a local `vendor/`.
- Without `ENGINE_SOURCE`, run `node scripts/fetch-vendor.mjs` to download the engine into `vendor/` (about 400 MB).

### workers.dev / pages.dev

Cloudflare Workers can't open the QUIC connections games use, so `cloudflare/` holds a small front that forwards everything to your self-hosted server:
- Worker: set `ORIGIN` in `cloudflare/wrangler.toml`, then `cd cloudflare && npx wrangler deploy`.
- Pages: `npx wrangler pages deploy cloudflare/pages --project-name webblox`, then set the `ORIGIN` environment variable in the Pages project.

If you see a captcha on the sign-in page that always fails, sign in on roblox.com directly instead; Roblox rejects challenges solved through a proxy.

- `vendor/<version>/` — engine + content pulled from `setup.rbxcdn.com/webclient/`; `vendor/CURRENT` picks the version; `<version>.flags.json` pins flags to it.
  The content index is `WebClient.fsindex.txt` (prefix-compressed: `<shared prefix len>\t<suffix>\t<size>`), not `WebClient.metadata.json`.
- `server.mjs` — serves `/player/` cross-origin isolated (COOP/COEP), the engine at `/player/engine/`, epoxy at `/player/lib/`, Wisp at `/wisp/`.
- `player/sw.js` — catches `*.roblox.com` / `*.rbxcdn.com` requests from the page and engine workers and hands them to the page.
- `player/relay.js` — sends them over Wisp with epoxy, keeps a cookie jar in localStorage, serves pinned flags, rewrites `rbx-user-agent`, `join-game` → `join-game-instance` (`?gameId=`), and builds `gameFqdn` if the join response lacks it. Imports `.ROBLOSECURITY` from Scramjet's `__scramjet_controller` IndexedDB on the same origin.
- `player/browser.html` / `browser.js` — Scramjet 2 sign-in browser (not cross-origin isolated, same origin as the player). The controller saves its cookie jar in IndexedDB `__scramjet_controller`; the player imports `.ROBLOSECURITY` from it on every start. A frame plugin catches `roblox-player:` / `roblox://` / `/games/start` launches and opens the player (`player/launch.js` parses them).
- Every request goes through this server:
  - HTTP goes through the service worker and the Wisp relay.
  - WebSockets go through `player/shims.js` (epoxy over Wisp).
  - Game traffic (WebTransport to `*.qdmux.roblox.com`) is tunneled over a WebSocket at `/wt-ws/` to `wt-relay.mjs`, which opens the real WebTransport session and carries datagrams and unidirectional streams both ways (framing is documented at the top of the file).
  - `server.mjs` puts `player/wt-shim.js` in front of `WebClient.js`, because the engine opens WebTransport from pthread workers. The shim forwards the URL and Roblox's pinned cert hashes.
  - App files are stamped with a build id (`?b=<id>`, engine under `/player/engine/<id>/`) so caches never serve stale scripts.
- `player/transport.js` — Scramjet ProxyTransport over Wisp/epoxy.
- `gameFqdn` fallback: `NetStackTokenValue` is base64; it's decoded to hex for the first label.
- Joins keep the engine's own web `rbx-user-agent` (rewritten to `Roblox/WinInet`), **not** `Roblox/Darwin`. With a desktop user agent, gamejoin can assign a server in a data center with no qdmux WebTransport gateway, and the browser then fails with error 279 (QUIC idle timeout). With the web user agent it only picks servers the browser can reach.
- `player/launcher.js` — the site: sidebar layout with hash routes (`#/home`, `#/charts[/<sort>]`, `#/recent`, `#/favorites`, `#/search?q=`, `#/games/<placeId>`, `#/friends[/requests|/find]`). Recently played and Favorites come from Roblox's home feed (`discovery-api/omni-recommendation`); friends are listed in Roblox's own order via paged `friends/find?userSort=1` (StatusFrequents, no 200 cap).
- `docs/roblox-api/` — Swagger specs for the Roblox web APIs we use, from `https://<service>.roblox.com/docs/json/<version>`. Friend request/accept/decline (`friends.roblox.com/v1/users/{id}/request-friendship` etc.) aren't in the current specs but still respond.
- `player/main.js` — launcher (search, paste link) and player boot. URLs: `?placeId=`, `?placeId=&gameId=`, `?userId=` (follow a friend via presence).
