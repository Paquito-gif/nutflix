# Nutflix

No Nut November, the streaming parody. Starring HODL, the peanut with diamond hands.
Static site: one `index.html` plus the artwork in `public/`. No build step.

## Deploy on Cloudflare (Workers)

The repo is set up for **Cloudflare Workers with static assets** (`wrangler.jsonc`):
`public/` is the site, `src/worker.js` serves `/api/*`, and the D1 database is bound as `DB`.

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick this repo.
   Build command: *(empty)*. Deploy command: `npx wrangler deploy` (the default).
2. Make sure the Worker is named **`nutflix`** (or change `"name"` in `wrangler.jsonc` to match).
3. The D1 database ID is already in `wrangler.jsonc`. Tables are created automatically on the first request.
4. Worker → **Settings → Variables and secrets → Add** → type **Secret**, name **`ADMIN_KEY`**,
   value: a long random password. Secrets survive every deploy.
5. Check `https://<your-worker>.workers.dev/api/health` → `{"ok":true,"configured":true,…}`.
6. Open `/admin.html` and enter your `ADMIN_KEY` to see every account.

Every push to `main` redeploys automatically.

<details><summary>Using Cloudflare Pages instead</summary>

Create a **Pages** project, output directory `public`, no build command. `functions/` serves `/api/*`.
Bind the D1 database as `DB` and add the `ADMIN_KEY` secret in the Pages project settings.
</details>

## Run locally

```bash
npx wrangler dev
```

Opens the site with the API and a local D1 database on http://localhost:8787.

## How accounts work

- Signing in with Phantom (Solana) or MetaMask (Ethereum) signs a one-time message from `/api/nonce`.
  `/api/verify` checks the signature on the server (Ed25519 / EIP-191), deletes the nonce so it can't be
  replayed, and returns a 30-day session.
- One account per wallet: profiles, streak, calendar, $NUT and history follow the wallet on any device.
- The server owns the rules: `/api/watch`, `/api/starter` (one welcome bag) and `/api/claim`
  (needs today's episode + 1,000 $NUT, once a day, streak bonus up to 2x). "Today" is the server's UTC day.
- On phones, the wallet buttons open the site inside the Phantom / MetaMask in-app browser.
- The demo wallet only appears when there is no backend (local testing, claude.ai preview).

## What works where

| Feature | Cloudflare + D1 | Static files only | claude.ai preview |
|---|---|---|---|
| Landing, profiles, shows, tempters, guest mode | ✅ | ✅ | ✅ |
| Wallet sign-in | ✅ verified by the server | ✅ signed in the browser | depends on the extension |
| Account follows the wallet across devices | ✅ | ❌ this browser only | ✅ per claude.ai user |
| Rewards can't be faked from the browser | ✅ | ❌ | ❌ |
| Admin view | ✅ `/admin.html` | ❌ | ✅ in Settings |

## Files

- `public/index.html`: the whole site
- `public/admin.html`: admin dashboard (needs `ADMIN_KEY`)
- `functions/api/[[route]].js`: the API
- `src/worker.js`: Workers entry point (routes `/api/*` to the API)
- `wrangler.jsonc`: Worker name, assets folder and D1 binding
- `functions/_lib/evm.js`: vendored Ethereum signature check (@noble/curves + @noble/hashes, MIT)

## Notes

- `$NUT` is a points system, not a token. Rewards are not paid on-chain.
- "Watched" means the player ran; it isn't proof someone looked at the screen.
- Nutflix is a parody. No explicit content, just innuendo.
