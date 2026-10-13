// Public hosting alternative to server.py: a Cloudflare Worker that serves
// static/ AND proxies /v1/* to the decision API, holding the token as a
// worker secret (never shipped to browsers).
//
//   cd deploy
//   wrangler deploy
//   wrangler secret put CLEF_TOKEN     # paste the API token once, stdin masked
//
// The UI works unmodified because the proxy is same-origin (no CORS problem),
// exactly like ./run.sh locally.

const UPSTREAM = "https://api.blablador.fz-juelich.de";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/v1/")) return env.ASSETS.fetch(req);

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers: {
        "content-type": req.headers.get("content-type") || "application/json",
        authorization: "Bearer " + env.CLEF_TOKEN,
      },
      body: req.body,
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  },
};