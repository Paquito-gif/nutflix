// Who earns NFLX, and how much.
//
// Holdings are real $Nutflix bought on Solana (no free supply). Their value in dollars decides the
// tier; days held and videos watched stack on top:
//
//   NFLX/day = NFLX_PER_CLAIM × tier × time × watch   (capped at MAX_PER_USER_NFLX)
//   tier  = by $ value of $Nutflix held (table below); under the first tier = not eligible
//   time  = 1 + 5% per day held, max 2x; back to day 1 if the value drops under the first tier
//   watch = 1 + 2% per video watched (max 3 counted per day), max 2x
//
// Settings: NUT_MINT (the $Nutflix mint; empty until launch), NUT_PRICE_USD (optional fixed price;
// otherwise read from DexScreener and cached 10 minutes), NUT_BUY_URL (optional buy link).

import { isPubkey, rpcClient, tokenBalance } from "./solana.js";
import { DEFAULT_RPC } from "./payouts.js";

export const TIERS = [
  { key: "bronze",  name: "Bronze",  icon: "🥉", minUsd: 150,   mult: 1 },
  { key: "silver",  name: "Silver",  icon: "🥈", minUsd: 500,   mult: 1.5 },
  { key: "gold",    name: "Gold",    icon: "🥇", minUsd: 1500,  mult: 2 },
  { key: "diamond", name: "Diamond", icon: "💎", minUsd: 5000,  mult: 3 },
  { key: "whale",   name: "Whale",   icon: "🐋", minUsd: 15000, mult: 4 },
];
export const MIN_USD = TIERS[0].minUsd;
export const VIDEOS_PER_DAY = 3;
const round2 = x => Math.round(x * 100) / 100;

export function tierFor(usd) {
  let t = null;
  for (const x of TIERS) if (usd >= x.minUsd) t = x;
  return t;
}
export function nextTier(usd) { return TIERS.find(x => usd < x.minUsd) || null; }

export function factors({ usd, holdDays, videos }) {
  const tier = tierFor(usd);
  const time = Math.min(1 + Math.max(holdDays - 1, 0) * 0.05, 2);
  const watch = Math.min(1 + Math.max(videos, 0) * 0.02, 2);
  const f = { tier: tier ? tier.mult : 0, time: round2(time), watch: round2(watch) };
  f.total = f.tier * f.time * f.watch;
  return f;
}

export function nflxFor(env, f) {
  const per = Number(env.NFLX_PER_CLAIM || "0.001");
  const cap = Number(env.MAX_PER_USER_NFLX || "0.01");
  return Math.min(per * f.total, cap).toFixed(6);
}

export function nutConfig(env) {
  const token = (env.NUT_MINT || "").trim();
  const rpc = (env.SOLANA_RPC_URL || DEFAULT_RPC).trim();
  const fixed = Number(env.NUT_PRICE_USD);
  const launched = isPubkey(token);
  return {
    launched, token, rpc,
    fixedPrice: Number.isFinite(fixed) && fixed > 0 ? fixed : null,
    // buy link: NUT_BUY_URL if set, otherwise Jupiter swap SOL → $Nutflix
    buyUrl: /^https:\/\//.test(env.NUT_BUY_URL || "") ? env.NUT_BUY_URL.trim()
      : launched ? `https://jup.ag/swap/SOL-${token}` : null,
    chartUrl: launched ? `https://dexscreener.com/solana/${token}` : null,
  };
}

/** $Nutflix price in USD: NUT_PRICE_USD if set, else DexScreener (most liquid Solana pair), cached 10 minutes in D1. */
export async function nutPriceUsd(env, db, fetcher = fetch) {
  const c = nutConfig(env);
  if (c.fixedPrice) return { price: c.fixedPrice, source: "fixed" };
  if (!c.launched) return { price: null, source: "none" };
  await db.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)").run();
  const cached = await db.prepare("SELECT v, at FROM kv WHERE k = 'nut_price'").first();
  if (cached && Date.now() - cached.at < 10 * 60e3) return { price: Number(cached.v), source: "dexscreener" };
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetcher(`https://api.dexscreener.com/latest/dex/tokens/${c.token}`, { signal: ctl.signal });
    clearTimeout(t);
    const pairs = ((await r.json()).pairs || [])
      .filter(p => p.chainId === "solana" && p.baseToken && p.baseToken.address === c.token && Number(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    if (!pairs.length) throw new Error("no pair");
    const price = Number(pairs[0].priceUsd);
    await db.prepare("INSERT INTO kv (k, v, at) VALUES ('nut_price', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at")
      .bind(String(price), Date.now()).run();
    return { price, source: "dexscreener" };
  } catch {
    return cached ? { price: Number(cached.v), source: "dexscreener (stale)" } : { price: null, source: "unavailable" };
  }
}

/** Real on-chain $Nutflix balance of a Solana wallet, in whole tokens. */
export async function nutBalance(env, owner, deps) {
  const c = nutConfig(env);
  const rpc = deps?.rpc || rpcClient(c.rpc);
  return (await tokenBalance(rpc, owner, c.token)).amount;
}

export function publicTiers() {
  return TIERS.map(({ key, name, icon, minUsd, mult }) => ({ key, name, icon, minUsd, mult }));
}
