// Routes the engine's direct connections through the proxy:
// - WebSocket to Roblox hosts → epoxy over Wisp
import { EpoxyHandlers } from "/player/lib/epoxy-bundled.js";

const ROBLOX = /(^|\.)(roblox\.com|rbxcdn\.com)$/;

export function installProxyShims(getClient) {
  installWebSocket(getClient);
  // WebTransport is patched inside the engine script itself (server.mjs
  // prepends wt-shim.js), because the engine opens it from worker threads.
}

function installWebSocket(getClient) {
  const Native = window.WebSocket;
  class ProxiedWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url, protocols = []) {
      const u = new URL(url, location.href);
      if (!ROBLOX.test(u.hostname)) return new Native(url, protocols);
      super();
      this.url = u.href; this.readyState = 0; this.protocol = ""; this.extensions = "";
      this.binaryType = "blob"; this.bufferedAmount = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._queue = [];
      const fire = (type, init) => {
        const ev = type === "message" ? new MessageEvent("message", init)
          : type === "close" ? new CloseEvent("close", init) : new Event(type);
        this.dispatchEvent(ev); this["on" + type]?.(ev);
      };
      const handlers = new EpoxyHandlers(
        () => { this.readyState = 1; fire("open"); for (const d of this._queue.splice(0)) this._ws.send(d); },
        (code, reason) => { this.readyState = 3; fire("close", { code: code ?? 1005, reason: reason ?? "", wasClean: true }); },
        () => fire("error"),
        (data) => {
          if (typeof data !== "string" && this.binaryType === "blob") data = new Blob([data]);
          fire("message", { data, origin: u.origin });
        },
      );
      getClient()
        .then((c) => c.connect_websocket(handlers, u.href, [].concat(protocols), { origin: "https://www.roblox.com" }))
        .then((ws) => { this._ws = ws; if (this.readyState >= 2) ws.close(1000, ""); })
        .catch(() => { this.readyState = 3; fire("error"); fire("close", { code: 1006, reason: "", wasClean: false }); });
    }
    async send(data) {
      if (this.readyState === 0) { this._queue.push(data); return; }
      if (data instanceof Blob) data = await data.arrayBuffer();
      else if (ArrayBuffer.isView(data)) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      this._ws?.send(data);
    }
    close(code = 1000, reason = "") { if (this.readyState >= 2) return; this.readyState = 2; this._ws?.close(code, reason); }
  }
  window.WebSocket = ProxiedWebSocket;
}
