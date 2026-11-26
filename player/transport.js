// A Scramjet ProxyTransport over Wisp, using epoxy (TLS ends in the browser).
import epoxyInit, { EpoxyClient, EpoxyClientOptions, EpoxyHandlers } from "/player/lib/epoxy-bundled.js";

// Epoxy hands back headers as { name: value | value[] }; Scramjet wants
// [name, value] pairs, with each Set-Cookie kept separate.
function toRawHeaders(raw) {
  const out = [];
  for (const [k, v] of Object.entries(raw || {})) {
    for (const one of Array.isArray(v) ? v : [v]) out.push([k, String(one)]);
  }
  return out;
}

function toHeaderObject(pairs) {
  const obj = {};
  for (const [k, v] of pairs) {
    const key = k.toLowerCase();
    obj[key] = key in obj ? `${obj[key]}${key === "cookie" ? "; " : ", "}${v}` : v;
  }
  return obj;
}

export class EpoxyTransport {
  ready = false;
  constructor(wispUrl) { this.wispUrl = wispUrl; }

  async init() {
    await epoxyInit();
    const opts = new EpoxyClientOptions();
    opts.redirect_limit = 0; // Scramjet follows redirects itself.
    this.client = new EpoxyClient(this.wispUrl, opts);
    this.ready = true;
  }

  async request(remote, method, body, headers, signal) {
    if (!this.ready) await this.init();
    if (body instanceof Blob) body = await body.arrayBuffer();
    else if (body instanceof ReadableStream) body = await new Response(body).arrayBuffer();
    const res = await this.client.fetch(remote.href, {
      method,
      body: body ?? undefined,
      headers: toHeaderObject(headers),
      redirect: "manual",
      signal,
    });
    return {
      body: res.body,
      headers: toRawHeaders(res.rawHeaders),
      status: res.status,
      statusText: res.statusText,
    };
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    let ws = null, closed = false;
    const queue = [];
    const handlers = new EpoxyHandlers(
      () => {
        onopen(ws?.protocol ?? "", "");
        for (const d of queue.splice(0)) ws.send(d);
      },
      (code, reason) => { closed = true; onclose(code ?? 1005, reason ?? ""); },
      (err) => onerror(String(err)),
      (data) => onmessage(data),
    );
    (async () => {
      if (!this.ready) await this.init();
      ws = await this.client.connect_websocket(handlers, url.href, protocols, toHeaderObject(requestHeaders));
      if (closed) ws.close(1000, "");
    })().catch((e) => { onerror(String(e)); onclose(1006, ""); });

    const send = async (data) => {
      if (data instanceof Blob) data = await data.arrayBuffer();
      if (ws) ws.send(data); else queue.push(data);
    };
    const close = (code, reason) => { closed = true; ws?.close(code ?? 1000, reason ?? ""); };
    return [send, close];
  }
}
