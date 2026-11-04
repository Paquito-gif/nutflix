# Nutflix

No Nut November, the streaming parody. Starring HODL, the peanut with diamond hands.
Static site: one `index.html` plus the artwork in `public/`. No build step.

## Run locally

```bash
cd public && python3 -m http.server 8080
```

Then open http://localhost:8080. Wallet extensions (Phantom, MetaMask) only inject on `http://localhost` or `https://` pages, not on `file://`.

## Deploy on Cloudflare Pages

1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
3. Build settings: Framework preset **None**, Build command **(empty)**, Build output directory **`public`**.
   The `functions/` folder is picked up automatically and serves `/api/*`.
4. Deploy.

## Turn on accounts (one-time, ~5 minutes)

Without this the site still works, but each visitor's progress stays in their own browser.

1. **Create the database**: Workers & Pages → **D1 SQL Database** → Create → name it `nutflix`.
   Tables are created automatically on the first request.
2. **Bind it**: your Pages project → **Settings → Bindings → Add → D1 database**.
   Variable name **`DB`**, database `nutflix`. Do it for Production (and Preview if you use it).
3. **Admin key**: Settings → **Variables and secrets → Add** → type **Secret**, name **`ADMIN_KEY`**,
   value: a long random password.
4. **Redeploy** (Deployments → ⋯ → Retry deployment) so the bindings apply.
5. Check `https://<your-site>/api/health` → `{"ok":true,"configured":true,…}`.
6. Open `https://<your-site>/admin.html` and enter your `ADMIN_KEY` to see every account.

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

| Feature | Cloudflare + D1 | Cloudflare without D1 | claude.ai preview |
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
- `functions/_lib/evm.js`: vendored Ethereum signature check (@noble/curves + @noble/hashes, MIT)

## Notes

- `$NUT` is a points system, not a token. Rewards are not paid on-chain.
- "Watched" means the player ran; it isn't proof someone looked at the screen.
- Nutflix is a parody. No explicit content, just innuendo.
