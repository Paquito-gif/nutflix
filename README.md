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

## NFLX stock-token payouts (Robinhood Chain)

Each claim queues a payout to the user's address, computed from how much $NUT they hold, for how long,
and how many days they watched:

```
NFLX = NFLX_PER_CLAIM × hold × time × watch      (capped at MAX_PER_USER_NFLX per wallet per day)
hold  = 1 + log10(balance / 1,000)   1x at 1,000 $NUT · 2x at 10,000 · max 3x
time  = 1 + 5% per day held          max 2x from day 21 · back to day 1 if the balance drops under 1,000
watch = 1 + 3% per day watched       max 1.9x
```

Example: 10,000 $NUT held for 11 days, 10 days watched, base 0.001 → 0.001 × 2 × 1.5 × 1.3 = 0.0039 NFLX.

**Which $NUT counts:** until your token exists, the site's $NUT points. Once you launch $NUT on Robinhood Chain,
add `NUT_TOKEN_ADDRESS`: the server then reads each wallet's real on-chain balance at every claim (only
Ethereum-compatible wallets can hold it, so Solana sign-ins stop qualifying).

 Once a day
(cron `10 0 * * *`, 00:10 UTC) the Worker sends every pending payout from a treasury wallet as an ERC-20
transfer on Robinhood Chain. Only Ethereum-compatible addresses (Robinhood Wallet, MetaMask) receive them.

**Nothing is sent until `PAYOUTS_ENABLED` is `true`.** Set it up in this order:

1. **Make a dedicated treasury wallet** (a fresh account, never your main wallet). Its key lives on the server,
   so keep only what you plan to pay out in it.
2. Add Robinhood Chain (chain ID 4663) to it, then fund it with **ETH for gas** and the **NFLX stock tokens** to distribute.
3. Get the **official NFLX token contract address** and **RPC URL** from Robinhood's documentation or explorer.
   Copycat tokens with the same ticker exist; check the address twice.
4. Worker → **Settings → Variables and secrets**:

   | Name | Type | Value |
   |---|---|---|
   | `TREASURY_PRIVATE_KEY` | Secret | private key of the treasury wallet |
   | `NFLX_TOKEN_ADDRESS` | Text | NFLX token contract on Robinhood Chain |
   | `RPC_URL` | Text | Robinhood Chain RPC (`https://…`) |
   | `EXPLORER_URL` | Text | explorer base URL, for transaction links |
   | `NFLX_PER_CLAIM` | Text | base amount, e.g. `0.001` (before the hold × time × watch bonuses) |
   | `MAX_PER_USER_NFLX` | Text | most one wallet can get per day, e.g. `0.01` |
   | `NUT_TOKEN_ADDRESS` | Text | *(later)* your $NUT token on Robinhood Chain, to count real holdings |
   | `MAX_DAILY_NFLX` | Text | hard cap per UTC day, e.g. `0.1` |
   | `PAYOUTS_ENABLED` | Text | `false` first, `true` when you're ready |

5. Open `/admin.html`: the treasury card must show the wallet, its NFLX and ETH balances.
   Click **Run payouts now** with `PAYOUTS_ENABLED=false` to see what would go out, then switch it to `true`.

Safety built in: one payout per address per day, a daily cap, it stops when the treasury runs low,
earlier transfers are checked on chain (sent → confirmed / failed), failed ones can be retried from the admin.

> ⚠️ Giving away stock tokens as a reward is likely a regulated activity (securities, promotions, KYC) and
> recipients must be eligible for Robinhood stock tokens in their country. Get legal advice before enabling it.
> Nutflix is a parody and is not affiliated with Netflix or Robinhood; say so wherever you promote it.

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
- `functions/_lib/payouts.js`: daily NFLX payouts (ethers v6)

## Notes

- `$NUT` is a points system, not a token. Only the optional NFLX payouts are on-chain.
- "Watched" means the player ran; it isn't proof someone looked at the screen.
- Nutflix is a parody. No explicit content, just innuendo.
