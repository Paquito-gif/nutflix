// Cloudflare Workers entry point.
// Static files in public/ are served by Workers Static Assets; anything under
// /api/* that isn't a file reaches this script and goes to the API handler
// (the same one Pages Functions would use from functions/api/[[route]].js).
import { onRequest } from "../functions/api/[[route]].js";
import { runPayouts } from "../functions/_lib/payouts.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const route = url.pathname.slice(5).split("/").filter(Boolean);
      return onRequest({ request, env, params: { route } });
    }
    return env.ASSETS.fetch(request);
  },
  // daily cron (wrangler.jsonc → triggers): send the NFLX payouts queued by yesterday's claims
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPayouts(env)
      .then(r => console.log("nutflix payouts", JSON.stringify(r)))
      .catch(e => console.error("nutflix payouts failed, nothing marked as sent:", e && (e.shortMessage || e.message))));
  },
};
