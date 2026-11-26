// Game traffic relay over WebSocket. The engine's WebTransport is replaced in
// the browser (player/wt-shim.js) by an object that tunnels everything over a
// WebSocket to /wt-ws/; here we open the real WebTransport session to Roblox's
// qdmux gateway and carry datagrams and unidirectional streams both ways.
// WebSockets pass through HTTP-only fronts like Cloudflare tunnels; UDP doesn't.
//
// Protocol on the socket:
//   client → server, first message (text): {"url": "...", "pins": [{algorithm, value(base64)}]}
//   server → client (text): {"type":"ready","maxDatagramSize":n} | {"type":"closed","closeCode":n,"reason":s} | {"type":"error","message":s}
//   client → server (text): {"type":"close","closeCode":n,"reason":s}
//   binary both ways: [kind u8][stream id u32 BE][payload]
//     1 datagram (id 0)   2 open uni stream   3 stream data   4 stream end   5 stream reset
//   Stream ids are per direction: client→server frames name streams the client
//   opened, server→client frames name streams the server opened.
import { WebSocketServer } from "ws";
import { WebTransport, quicheLoaded } from "@fails-components/webtransport";

const ALLOWED = /(^|\.)roblox\.com$/;
const DGRAM = 1, OPEN = 2, DATA = 3, FIN = 4, RESET = 5;

function frame(kind, id, payload) {
  const out = new Uint8Array(5 + (payload ? payload.byteLength : 0));
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, id);
  if (payload) out.set(payload, 5);
  return out;
}

async function session(ws, first) {
  const send = (data) => { if (ws.readyState === 1) ws.send(data); };
  const sendJson = (obj) => send(JSON.stringify(obj));

  let upstream;
  try {
    const req = JSON.parse(first);
    const target = new URL(req.url);
    if (target.protocol !== "https:" || !ALLOWED.test(target.hostname)) throw new Error("target not allowed");
    const pins = (req.pins || []).map((p) => ({ algorithm: p.algorithm, value: Buffer.from(p.value, "base64") }));
    await quicheLoaded;
    upstream = new WebTransport(target.href, pins.length ? { serverCertificateHashes: pins } : {});
    await upstream.ready;
    console.log("[wt-ws] relaying to", target.host);
    sendJson({ type: "ready", maxDatagramSize: upstream.datagrams?.maxDatagramSize || 1200 });
  } catch (e) {
    console.warn("[wt-ws] upstream failed:", e?.message || e);
    sendJson({ type: "error", message: String(e?.message || e) });
    try { upstream?.close(); } catch {}
    ws.close();
    return;
  }

  let open = true;
  const finish = (info = {}) => {
    if (!open) return;
    open = false;
    sendJson({ type: "closed", closeCode: info.closeCode ?? 0, reason: info.reason ?? "" });
    try { upstream.close(info); } catch {}
    ws.close();
  };
  upstream.closed.then((i) => finish(i || {}), (e) => finish({ closeCode: 0, reason: String(e?.message || e) }));

  // upstream → browser
  (async () => {
    const r = upstream.datagrams.readable.getReader();
    for (;;) { const { value, done } = await r.read(); if (done) return; send(frame(DGRAM, 0, value)); }
  })().catch(() => {});
  (async () => {
    const streams = upstream.incomingUnidirectionalStreams.getReader();
    let next = 1;
    for (;;) {
      const { value: stream, done } = await streams.read();
      if (done) return;
      const id = next++;
      send(frame(OPEN, id));
      (async () => {
        const r = stream.getReader();
        try {
          for (;;) { const { value, done } = await r.read(); if (done) break; send(frame(DATA, id, value)); }
          send(frame(FIN, id));
        } catch { send(frame(RESET, id)); }
      })();
    }
  })().catch(() => {});

  // browser → upstream
  const dgramWriter = upstream.datagrams.writable.getWriter();
  const outStreams = new Map(); // id → promise chain ending in a writer
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      try { const m = JSON.parse(data.toString()); if (m.type === "close") finish(m); } catch {}
      return;
    }
    const buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (buf.length < 5) return;
    const kind = buf[0], id = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
    const payload = buf.slice(5);
    if (kind === DGRAM) { dgramWriter.write(payload).catch(() => {}); return; }
    if (kind === OPEN) {
      outStreams.set(id, upstream.createUnidirectionalStream().then((w) => w.getWriter()));
      return;
    }
    const chain = outStreams.get(id);
    if (!chain) return;
    if (kind === DATA) outStreams.set(id, chain.then(async (w) => { await w.write(payload); return w; }));
    else if (kind === FIN) { chain.then((w) => w.close()).catch(() => {}); outStreams.delete(id); }
    else if (kind === RESET) { chain.then((w) => w.abort()).catch(() => {}); outStreams.delete(id); }
  });
  ws.on("close", () => finish({ closeCode: 0, reason: "socket closed" }));
}

export function createWtWs() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  wss.on("connection", (ws) => {
    ws.once("message", (data) => session(ws, data.toString()).catch((e) => console.warn("[wt-ws]", e?.message || e)));
  });
  return (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
}

process.on("unhandledRejection", (e) => console.warn("[wt-ws] unhandled:", e?.message || e));
