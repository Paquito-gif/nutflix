// Cloudflare Workers entry point.
// Static files in public/ are served by Workers Static Assets; anything under
// /api/* that isn't a file reaches this script and goes to the API handler
// (the same one Pages Functions would use from functions/api/[[route]].js).
import { onRequest } from "../functions/api/[[route]].js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const route = url.pathname.slice(5).split("/").filter(Boolean);
      return onRequest({ request, env, params: { route } });
    }
    return env.ASSETS.fetch(request);
  },
};
