// Prepended to the engine's WebClient.js by server.mjs, so it runs on the main
// thread and in every pthread worker. WebTransport to Roblox is replaced with
// an object that tunnels datagrams and unidirectional streams over a WebSocket
// to our server (/wt-ws/), which opens the real session. See wt-relay.mjs for
// the protocol. The engine only uses datagrams, uni streams, ready/closed,
// close(), getStats() and maxDatagramSize.
(() => {
  const Native = globalThis.WebTransport;
  if (Native && Native.__webblox) return;
  const ROBLOX = /(^|\.)roblox\.com$/;
  const DGRAM = 1, OPEN = 2, DATA = 3, FIN = 4, RESET = 5;
  const wsUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wt-ws/`;

  const frame = (kind, id, payload) => {
    const bytes = payload ? (payload instanceof Uint8Array ? payload : new Uint8Array(payload.buffer ?? payload, payload.byteOffset ?? 0, payload.byteLength)) : null;
    const out = new Uint8Array(5 + (bytes ? bytes.byteLength : 0));
    out[0] = kind;
    new DataView(out.buffer).setUint32(1, id);
    if (bytes) out.set(bytes, 5);
    return out;
  };

  class TunnelWebTransport {
    static __webblox = true;
    constructor(url, options = {}) {
      const target = new URL(url);
      if (!ROBLOX.test(target.hostname)) {
        if (!Native) throw new TypeError("WebTransport unavailable");
        return new Native(url, options);
      }
      this.protocol = "";
      this.reliability = "pending";
      let readyOk, readyErr, closedOk, closedErr;
      this.ready = new Promise((a, b) => { readyOk = a; readyErr = b; });
      this.closed = new Promise((a, b) => { closedOk = a; closedErr = b; });
      this.ready.catch(() => {}); this.closed.catch(() => {});
      this.draining = new Promise(() => {});

      const ws = (this._ws = new WebSocket(wsUrl()));
      ws.binaryType = "arraybuffer";
      const send = (d) => { if (ws.readyState === 1) ws.send(d); };

      let dgramCtl, uniCtl;
      const inStreams = new Map();
      const outgoing = new Set();
      let nextOut = 1, isReady = false, done = false;

      const datagrams = {
        maxDatagramSize: 1200,
        incomingHighWaterMark: 1, outgoingHighWaterMark: 1, incomingMaxAge: null, outgoingMaxAge: null,
        readable: new ReadableStream({ start: (c) => { dgramCtl = c; } }),
        writable: new WritableStream({ write: (chunk) => { send(frame(DGRAM, 0, chunk)); } }),
      };
      this.datagrams = datagrams;
      this.incomingUnidirectionalStreams = new ReadableStream({ start: (c) => { uniCtl = c; } });
      this.incomingBidirectionalStreams = new ReadableStream({});

      const shutdown = (info, err) => {
        if (done) return;
        done = true;
        const e = err || new Error(info?.reason || "closed");
        try { dgramCtl.close(); } catch {}
        try { uniCtl.close(); } catch {}
        for (const c of inStreams.values()) { try { c.error(e); } catch {} }
        inStreams.clear();
        if (!isReady) readyErr(e);
        if (err) closedErr(err); else closedOk({ closeCode: info?.closeCode ?? 0, reason: info?.reason ?? "" });
        try { ws.close(); } catch {}
      };
      this._shutdown = shutdown;

      ws.onopen = () => {
        const pins = (options.serverCertificateHashes || []).map((h) => {
          const v = h.value instanceof ArrayBuffer ? new Uint8Array(h.value) : new Uint8Array(h.value.buffer, h.value.byteOffset, h.value.byteLength);
          return { algorithm: h.algorithm, value: btoa(String.fromCharCode(...v)) };
        });
        ws.send(JSON.stringify({ url: target.href, pins }));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.type === "ready") {
            datagrams.maxDatagramSize = m.maxDatagramSize || 1200;
            isReady = true; this.reliability = "supports-unreliable";
            console.log("[webblox] game traffic via WebSocket relay ->", target.host);
            readyOk();
          } else if (m.type === "closed") shutdown(m);
          else if (m.type === "error") shutdown(null, new Error(`relay: ${m.message}`));
          return;
        }
        const buf = new Uint8Array(ev.data);
        if (buf.length < 5) return;
        const kind = buf[0], id = new DataView(ev.data).getUint32(1), payload = buf.subarray(5);
        if (kind === DGRAM) { try { dgramCtl.enqueue(payload); } catch {} }
        else if (kind === OPEN) {
          let ctl;
          const rs = new ReadableStream({ start: (c) => { ctl = c; } });
          inStreams.set(id, ctl);
          try { uniCtl.enqueue(rs); } catch {}
        } else {
          const ctl = inStreams.get(id);
          if (!ctl) return;
          if (kind === DATA) { try { ctl.enqueue(payload); } catch {} }
          else if (kind === FIN) { try { ctl.close(); } catch {} inStreams.delete(id); }
          else if (kind === RESET) { try { ctl.error(new Error("stream reset")); } catch {} inStreams.delete(id); }
        }
      };
      ws.onerror = () => shutdown(null, new Error("relay socket error"));
      ws.onclose = () => shutdown({ closeCode: 0, reason: "relay socket closed" });

      this.createUnidirectionalStream = async () => {
        await this.ready;
        const id = nextOut++;
        send(frame(OPEN, id));
        const ws2 = new WritableStream({
          write: (chunk) => { send(frame(DATA, id, chunk)); },
          close: () => { send(frame(FIN, id)); outgoing.delete(id); },
          abort: () => { send(frame(RESET, id)); outgoing.delete(id); },
        });
        outgoing.add(id);
        return ws2;
      };
    }
    async createBidirectionalStream() { throw new Error("bidirectional streams aren't relayed"); }
    async getStats() { return { datagrams: {} }; }
    close(info = {}) {
      if (this._ws.readyState === 1) this._ws.send(JSON.stringify({ type: "close", closeCode: info.closeCode ?? 0, reason: info.reason ?? "" }));
      this._shutdown(info);
    }
  }
  globalThis.WebTransport = TunnelWebTransport;
})();
