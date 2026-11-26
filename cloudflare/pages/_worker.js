// Front for a WebBlox server on workers.dev / pages.dev. Workers can't open
// the QUIC (WebTransport) connections games need, so this forwards every
// request, WebSockets included, to a self-hosted server set in ORIGIN.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = new URL(env.ORIGIN);
    url.protocol = origin.protocol;
    url.host = origin.host;
    if (url.pathname === "/") return Response.redirect(new URL("/player/", request.url), 302);
    return fetch(new Request(url, request));
  },
};
