// Who earns NFLX, and how much.
//
// Holdings are real $NUT bought on Robinhood Chain (no free supply). Their value in
// dollars decides the tier; days held and videos watched stack on top:
//
//   NFLX/day = NFLX_PER_CLAIM × tier × time × watch   (capped at MAX_PER_USER_NFLX)
//   tier  = by $ value of $NUT held (table below); under the first tier = not eligible
//   time  = 1 + 5% per day held, max 2x; back to day 1 if the value drops under the first tier
//   watch = 1 + 2% per video watched (max 3 counted per day), max 2x
//
// Settings: NUT_TOKEN_ADDRESS (required), NUT_PRICE_USD (optional fixed price; otherwise
// the price is read from DexScreener and cached 10 minutes), NUT_BUY_URL (link to buy).

import { ethers } from "ethers";
// RPC must be https; plain http is only accepted for a local dev node
const okRpc = u => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u);

export const TIERS = [
  { key: "bronze",  name: "Bronze",  icon: "🥉", minUsd: 150,   mult: 1 },
  { key: "silver",  name: "Silver",  icon: "🥈", minUsd: 500,   mult: 1.5 },
  { key: "gold",    name: "Gold",    icon: "🥇", minUsd: 1500,  mult: 2 },
  { key: "diamond", name: "Diamond", icon: "💎", minUsd: 5000,  mult: 3 },
  { key: "whale",   name: "Whale",   icon: "🐋", minUsd: 15000, mult: 4 },
];
export const MIN_USD = TIERS[0].minUsd;
export const VIDEOS_PER_DAY = 3;

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
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
  const token = (env.NUT_TOKEN_ADDRESS || "").trim();
  const rpc = (env.RPC_URL || "").trim();
  const fixed = Number(env.NUT_PRICE_USD);
  return {
    launched: ethers.isAddress(token) && okRpc(rpc),
    token, rpc, chainId: Number(env.CHAIN_ID || 4663),
    fixedPrice: Number.isFinite(fixed) && fixed > 0 ? fixed : null,
    buyUrl: /^https:\/\//.test(env.NUT_BUY_URL || "") ? env.NUT_BUY_URL.trim() : null,
  };
}

/** $NUT price in USD: NUT_PRICE_USD if set, else DexScreener (most liquid pair), cached 10 minutes in D1. */
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
      .filter(p => p.baseToken && p.baseToken.address && p.baseToken.address.toLowerCase() === c.token.toLowerCase() && Number(p.priceUsd) > 0)
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

/** Real on-chain $NUT balance of an Ethereum-compatible address. */
export async function nutBalance(env, address, deps) {
  const c = nutConfig(env);
  const provider = deps?.provider || new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
  const nut = deps?.nut || new ethers.Contract(c.token, ERC20, provider);
  const [bal, dec] = await Promise.all([nut.balanceOf(address), nut.decimals()]);
  return Number(ethers.formatUnits(bal, dec));
}

export function publicTiers() {
  return TIERS.map(({ key, name, icon, minUsd, mult }) => ({ key, name, icon, minUsd, mult }));
}
