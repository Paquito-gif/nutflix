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
5. Check `https://nutflix.site/api/health` → `{"ok":true,"configured":true,…}`.
6. Open `https://nutflix.site/admin.html` and enter your `ADMIN_KEY` to see every account.

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

## Launch day: paste the CA, that's it

1. Open `wrangler.jsonc` and paste the $Nutflix contract address in `"NUT_TOKEN_ADDRESS": ""`.
2. Commit & push (or send it to whoever maintains the repo). Cloudflare redeploys in ~1 minute.

From then on, automatically: balances and tiers are read on Robinhood Chain, the price comes from DexScreener
(as soon as a pair exists), the "Buy $Nutflix" button links to the CA on DexScreener, and the official CA is shown
on the landing page and in Nut Rewards with a Copy button. Optional overrides: `NUT_BUY_URL` (your own buy link),
`NUT_PRICE_USD` (fixed price). Don't also set `NUT_TOKEN_ADDRESS` in the dashboard: `wrangler.jsonc` wins on deploy.

## NFLX stock-token payouts (Robinhood Chain)

**No free $Nutflix.** Nobody gets a starter bag or $Nutflix for claiming: people buy $Nutflix themselves, and the
server reads each wallet's **real on-chain balance** on Robinhood Chain. Its value in dollars sets the tier:

| Tier | $Nutflix held (USD value) | Multiplier |
|---|---|---|
| 🥉 Bronze | $150 – $499 | 1x |
| 🥈 Silver | $500 – $1,499 | 1.5x |
| 🥇 Gold | $1,500 – $4,999 | 2x |
| 💎 Diamond | $5,000 – $14,999 | 3x |
| 🐋 Whale | $15,000+ | 4x |

Under $150 = not eligible. On top of the tier:

```
NFLX/day = NFLX_PER_CLAIM × tier × time × watch       (max MAX_PER_USER_NFLX per wallet per day)
time  = 1 + 5% per day held        max 2x · restarts if the value drops under $150
watch = 1 + 2% per video watched   3 videos counted per day · max 2x
```

Example: $1,500 of $Nutflix (Gold), held 11 days, 10 videos watched, base 0.001
→ 0.001 × 2 × 1.5 × 1.2 = **0.0036 NFLX** that day.

To claim, a wallet must watch an episode that day, be at least Bronze, and claim once. The payout is queued
and sent by the nightly cron (00:10 UTC). Tiers are in `functions/_lib/rewards.js`.

**$Nutflix price:** set `NUT_PRICE_USD` to fix it, or leave it empty and the server reads it from DexScreener
(most liquid pair, cached 10 minutes). Until `NUT_TOKEN_ADDRESS` is set, the panel says "$Nutflix isn't live yet".

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
   | `NUT_TOKEN_ADDRESS` | Text | your $Nutflix token on Robinhood Chain (rewards start once it's set) |
   | `NUT_PRICE_USD` | Text | *(optional)* fixed $Nutflix price; empty = live price from DexScreener |
   | `NUT_BUY_URL` | Text | *(optional)* link behind the "Buy $Nutflix" button |
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
- One account per wallet: profiles, streak, calendar, $Nutflix and history follow the wallet on any device.
- The server owns the rules: `/api/watch` (counts up to 3 videos a day) and `/api/claim` (needs today's episode
  and at least $150 of real $Nutflix in the wallet, once a day). "Today" is the server's UTC day. There is no free $Nutflix.
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
- `functions/_lib/rewards.js`: tiers, $Nutflix price and balance, reward formula

## Notes

- $Nutflix is bought on-chain by users; the site never gives any away. NFLX payouts are sent on-chain.
- Holdings are checked when someone claims (once a day): selling between two claims and buying back isn't detected.
- "Watched" means the player ran; it isn't proof someone looked at the screen.
- Nutflix is a parody. No explicit content, just innuendo.
