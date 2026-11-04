// Daily NFLX stock-token payouts on Robinhood Chain.
//
// A claim on day D queues one payout row (address, D). Once a day the cron
// trigger sends every pending row from the treasury wallet as an ERC-20
// transfer, within a daily cap and the treasury's balance. Nothing is sent
// unless PAYOUTS_ENABLED is "true".
//
// Settings (Worker → Settings → Variables and secrets):
//   TREASURY_PRIVATE_KEY  secret  key of a dedicated hot wallet; fund it with only what you plan to pay out
//   NFLX_TOKEN_ADDRESS    text    NFLX stock-token contract on Robinhood Chain (copy it from Robinhood's official docs)
//   RPC_URL               text    Robinhood Chain RPC endpoint
//   PAYOUTS_ENABLED       text    "true" to really send; anything else = dry run
//   NFLX_PER_CLAIM        text    NFLX per claim before the streak bonus (default 0.001)
//   MAX_DAILY_NFLX        text    total NFLX the treasury may send per UTC day (default 0.1)
//   CHAIN_ID              text    default 4663
//   EXPLORER_URL          text    block explorer base URL, for transaction links

import { ethers } from "ethers";

const ERC20 = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export function payoutConfig(env) {
  const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? String(v).trim() : d);
  const cfg = {
    enabled: String(env.PAYOUTS_ENABLED || "").trim().toLowerCase() === "true",
    perClaim: num(env.NFLX_PER_CLAIM, "0.001"),
    maxDaily: num(env.MAX_DAILY_NFLX, "0.1"),
    chainId: Number(env.CHAIN_ID || 4663),
    token: (env.NFLX_TOKEN_ADDRESS || "").trim(),
    rpc: (env.RPC_URL || "").trim(),
    hasKey: !!(env.TREASURY_PRIVATE_KEY || "").trim(),
    explorer: (env.EXPLORER_URL || "").trim().replace(/\/+$/, ""),
  };
  cfg.missing = [
    !ethers.isAddress(cfg.token) && "NFLX_TOKEN_ADDRESS",
    !/^https:\/\//.test(cfg.rpc) && "RPC_URL",
    !cfg.hasKey && "TREASURY_PRIVATE_KEY",
  ].filter(Boolean);
  cfg.ready = cfg.missing.length === 0;
  return cfg;
}

/** Public, non-secret view of the payout settings. */
export function publicPayoutInfo(env) {
  const c = payoutConfig(env);
  return { enabled: c.enabled && c.ready, perClaim: c.perClaim, chainId: c.chainId, token: c.ready ? c.token : null, explorer: c.explorer || null };
}

export async function ensurePayoutSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, day TEXT NOT NULL,
    amount TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, error TEXT,
    created_at INTEGER NOT NULL, sent_at INTEGER, sent_day TEXT,
    UNIQUE(address, day))`).run();
}

/** Queue the payout for a claim. Ethereum-compatible addresses only; one per address per day. */
export async function queuePayout(db, env, { address, chain, day, streakMult }) {
  const c = payoutConfig(env);
  if (chain !== "Ethereum" || !(Number(c.perClaim) > 0)) return null;
  const amount = (Number(c.perClaim) * streakMult).toFixed(6);
  await ensurePayoutSchema(db);
  await db.prepare(`INSERT INTO payouts (address, day, amount, status, created_at) VALUES (?, ?, ?, 'pending', ?)
                    ON CONFLICT(address, day) DO NOTHING`).bind(address, day, amount, Date.now()).run();
  return amount;
}

export async function payoutsFor(db, address) {
  await ensurePayoutSchema(db);
  const { results } = await db.prepare(
    "SELECT day, amount, status, tx_hash, sent_at FROM payouts WHERE address = ? ORDER BY day DESC LIMIT 60").bind(address).all();
  return results;
}

function chainDeps(env, c) {
  const provider = new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(env.TREASURY_PRIVATE_KEY.trim(), provider);
  const token = new ethers.Contract(c.token, ERC20, wallet);
  return { provider, wallet, token };
}

/** Treasury address and balances, for the admin page. */
export async function treasuryInfo(env, deps) {
  const c = payoutConfig(env);
  if (!c.ready) return { ready: false, missing: c.missing, enabled: c.enabled };
  const { provider, wallet, token } = deps || chainDeps(env, c);
  const [decimals, symbol, bal, eth] = await Promise.all([
    token.decimals(), token.symbol().catch(() => "NFLX"), token.balanceOf(wallet.address), provider.getBalance(wallet.address)]);
  return { ready: true, enabled: c.enabled, address: wallet.address, symbol,
    token: ethers.formatUnits(bal, decimals), eth: ethers.formatEther(eth),
    perClaim: c.perClaim, maxDaily: c.maxDaily, explorer: c.explorer || null };
}

/** Send every pending payout. Safe to run more than once a day. */
export async function runPayouts(env, { deps, now = Date.now() } = {}) {
  const db = env.DB;
  const c = payoutConfig(env);
  if (!db) return { status: "no_database" };
  await ensurePayoutSchema(db);
  const { results: pending } = await db.prepare(
    "SELECT * FROM payouts WHERE status = 'pending' ORDER BY day, id LIMIT 200").all();
  if (!c.ready) return { status: "not_configured", missing: c.missing, pending: pending.length };
  if (!c.enabled) return { status: "disabled", pending: pending.length };

  const { provider, wallet, token } = deps || chainDeps(env, c);
  const decimals = Number(await token.decimals());
  const today = utcDay(now);

  // 1. settle earlier transfers
  const { results: unsettled } = await db.prepare("SELECT id, tx_hash FROM payouts WHERE status = 'sent' LIMIT 200").all();
  for (const r of unsettled) {
    const rc = await provider.getTransactionReceipt(r.tx_hash).catch(() => null);
    if (rc) await db.prepare("UPDATE payouts SET status = ?, error = ? WHERE id = ?")
      .bind(rc.status === 1 ? "confirmed" : "failed", rc.status === 1 ? null : "reverted on chain", r.id).run();
  }

  // 2. what is left of today's budget and of the treasury
  const { results: sentToday } = await db.prepare(
    "SELECT amount FROM payouts WHERE sent_day = ? AND status IN ('sent','confirmed')").bind(today).all();
  let budget = ethers.parseUnits(c.maxDaily, decimals);
  for (const r of sentToday) budget -= ethers.parseUnits(r.amount, decimals);
  let balance = await token.balanceOf(wallet.address);
  let nonce = await provider.getTransactionCount(wallet.address, "pending");

  const out = { status: "ran", sent: 0, failed: 0, left: 0, stoppedBy: null };
  for (const row of pending) {
    const amount = ethers.parseUnits(row.amount, decimals);
    if (amount > budget) { out.stoppedBy = "daily_cap"; break; }
    if (amount > balance) { out.stoppedBy = "treasury_low"; break; }
    if (!ethers.isAddress(row.address)) {
      await db.prepare("UPDATE payouts SET status = 'failed', error = 'bad address' WHERE id = ?").bind(row.id).run();
      out.failed++; continue;
    }
    try {
      const tx = await token.transfer(ethers.getAddress(row.address), amount, { nonce });
      nonce++;
      budget -= amount; balance -= amount;
      await db.prepare("UPDATE payouts SET status = 'sent', tx_hash = ?, sent_at = ?, sent_day = ?, error = NULL WHERE id = ?")
        .bind(tx.hash, now, today, row.id).run();
      out.sent++;
    } catch (e) {
      await db.prepare("UPDATE payouts SET status = 'failed', error = ? WHERE id = ?")
        .bind(String(e.shortMessage || e.message || e).slice(0, 300), row.id).run();
      out.failed++;
      if (/insufficient funds|gas/i.test(String(e.message))) { out.stoppedBy = "treasury_out_of_eth"; break; }
    }
  }
  out.left = pending.length - out.sent - out.failed;
  return out;
}
