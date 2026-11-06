# Nutflix

No Nut November, the streaming parody, on **Solana**. Starring HODL, the peanut with diamond hands.
Watch an episode a day, hold $Nutflix, earn NFLX stock tokens every night.

Live at **https://nutflix.site** · X: [@nutflixonrh](https://x.com/nutflixonrh)

## Deploy on Cloudflare (Workers)

The repo is set up for **Cloudflare Workers with static assets** (`wrangler.jsonc`):
`public/` is the site, `src/worker.js` serves `/api/*` and runs the nightly payout cron, the D1 database is bound
as `DB`, and the Worker answers on `nutflix.site` and `www.nutflix.site`.

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick this repo.
   Build command: *(empty)*. Deploy command: `npx wrangler deploy` (the default).
2. Worker → **Settings → Variables and secrets** → add **Secrets**:
   - `ADMIN_KEY`: a long random password for `/admin.html`
   - `SOLANA_TREASURY_KEY`: the treasury wallet's secret key (see payouts below)
3. Check `https://nutflix.site/api/health` → `{"ok":true,"configured":true,"admin":true,…}`.

Every push to `main` redeploys automatically. Plain settings live in `wrangler.jsonc` → `vars`
(they win over the dashboard on deploy); only secrets go in the dashboard.

## Run locally

```bash
npx wrangler dev
```

Opens the site with the API and a local D1 database on http://localhost:8787.

## Launch day: paste the CA, that's it

1. Open `wrangler.jsonc` and paste the $Nutflix **mint address** in `"NUT_MINT": ""`.
2. Commit & push. Cloudflare redeploys in ~1 minute.

From then on, automatically: balances and tiers are read on Solana, the price comes from DexScreener (as soon as a
pair exists), the "Buy $Nutflix" button opens a Jupiter swap, "Chart" opens DexScreener, and the official CA is
shown on the landing page and in Nut Rewards with a Copy button. Optional overrides: `NUT_BUY_URL`, `NUT_PRICE_USD`.

## Rewards: who earns NFLX, and how much

**No free $Nutflix.** People buy it themselves; the server reads each wallet's real on-chain balance on Solana and
values it in dollars:

| Tier | $Nutflix held (USD value) | Multiplier |
|---|---|---|
| 🥉 Bronze | $150 – $499 | 1x |
| 🥈 Silver | $500 – $1,499 | 1.5x |
| 🥇 Gold | $1,500 – $4,999 | 2x |
| 💎 Diamond | $5,000 – $14,999 | 3x |
| 🐋 Whale | $15,000+ | 4x |

```
NFLX/day = NFLX_PER_CLAIM × tier × time × watch       (max MAX_PER_USER_NFLX per wallet per day)
time  = 1 + 5% per day held        max 2x · restarts if the value drops under $150
watch = 1 + 2% per video watched   3 videos counted per day · max 2x
```

To claim, a wallet watches an episode that day, holds at least $150 of $Nutflix, and claims once. Tiers are in
`functions/_lib/rewards.js`.

## NFLX payouts (Solana)

NFLX is the **"Netflix - Backpack Securities"** token (`NFLX7qV57zuVxCoHy3s1jiGZyALraLNwttbxdvmYJLJ`,
Token-2022, 6 decimals, no transfer hook). Each night at **00:10 UTC** the Worker sends every pending payout from the
treasury wallet: it creates the recipient's NFLX token account if needed (paid by the treasury) and does a
`transferChecked`. Earlier transfers are then confirmed on chain; one that never landed is marked failed and can be
retried from the admin.

**Payouts only go out when `PAYOUTS_ENABLED` is `"true"` *and* `SOLANA_TREASURY_KEY` is set.**

1. Create a **dedicated treasury wallet** (a fresh Phantom/Solflare account, never your main one) and export its
   private key. Keep only what you plan to pay out in it.
2. Fund it with **NFLX** (the mint above) and a little **SOL** for fees and new token accounts (~0.002 SOL each).
3. Add the secret `SOLANA_TREASURY_KEY` (the base58 private key, or a JSON array from solana-keygen).
4. Open `/admin.html`: the treasury card must show the wallet, its NFLX and SOL balances.
5. Optional: set `SOLANA_RPC_URL` to a private RPC (Helius, Triton, QuickNode…). The public endpoint is rate-limited.

Settings in `wrangler.jsonc`: `NFLX_MINT`, `SOLANA_RPC_URL`, `EXPLORER_URL` (Solscan), `NFLX_PER_CLAIM`,
`MAX_PER_USER_NFLX`, `MAX_DAILY_NFLX`, `PRIORITY_FEE` (micro-lamports per compute unit), `PAYOUTS_ENABLED`.

Safety built in: one payout per wallet per day, a daily cap, it stops when the treasury runs low on NFLX or SOL,
and a transaction is never resent while it could still land.

> ⚠️ Giving away tokenized stocks as a reward is likely a regulated activity (securities, promotions, KYC), and
> NFLX is a security token whose issuer can pause or claw back transfers. Get legal advice before enabling payouts.
> Nutflix is a parody and is not affiliated with Netflix; say so wherever you promote it.

## How accounts work

- Sign in with any Solana wallet (Phantom, Solflare, Backpack, Jupiter, OKX, Trust…), detected through the Wallet
  Standard. The wallet signs a one-time message from `/api/nonce`; `/api/verify` checks the Ed25519 signature on the
  server, deletes the nonce so it can't be replayed, and returns a 30-day session.
- One account per wallet: profiles, streak, calendar, history and payouts follow the wallet on any device.
- The server owns the rules: `/api/watch` (counts up to 3 videos a day) and `/api/claim`. "Today" is the server's UTC
  day.
- On phones, wallet buttons open the site inside the Phantom / Solflare / OKX / Trust in-app browser.
- `/api/leaderboard` ranks the longest watch streaks (short addresses and profile names only).

## Files

- `public/index.html`: the whole site · `public/admin.html`: admin dashboard (needs `ADMIN_KEY`)
- `functions/api/[[route]].js`: the API · `src/worker.js`: Worker entry (API + nightly cron)
- `functions/_lib/solana.js`: base58, keys, token accounts, RPC, balances, signed transfers (no SDK)
- `functions/_lib/ed25519.js`: vendored @noble/curves ed25519 + @noble/hashes sha256 (MIT)
- `functions/_lib/payouts.js`: nightly NFLX payouts · `functions/_lib/rewards.js`: tiers, price, balances
- `wrangler.jsonc`: Worker name, domains, assets, D1, cron and settings
- `brand/`: logos, banners, tweet images

## Notes

- Holdings are checked when someone claims (once a day): selling between two claims and buying back isn't detected.
- "Watched" means ~85% of the episode was played, not that someone looked at the screen.
- Nutflix is a parody. No explicit content, just innuendo.
