// Daily NFLX stock-token payouts on Solana.
//
// A claim on day D queues one payout row (wallet, D). Once a day the cron trigger sends every pending
// row from the treasury wallet: create the recipient's NFLX token account if needed, then transferChecked.
// Nothing is sent unless PAYOUTS_ENABLED is "true".
//
// Settings (wrangler.jsonc "vars", secrets in Worker → Settings → Variables and secrets):
//   SOLANA_TREASURY_KEY   secret  treasury wallet secret key (base58 export from Phantom/Solflare, or a JSON array)
//   NFLX_MINT             text    NFLX mint (default: Netflix - Backpack Securities, NFLX7qV57…)
//   SOLANA_RPC_URL        text    Solana RPC (default public mainnet; a private RPC such as Helius is recommended)
//   PAYOUTS_ENABLED       text    "true" to really send; anything else = dry run
//   NFLX_PER_CLAIM        text    base NFLX per claim before bonuses (default 0.001)
//   MAX_PER_USER_NFLX     text    most NFLX one wallet can get per day (default 0.01)
//   MAX_DAILY_NFLX        text    total NFLX the treasury may send per UTC day (default 0.1)
//   PRIORITY_FEE          text    priority fee in micro-lamports per compute unit (default 5000)
//   EXPLORER_URL          text    explorer base URL for transaction links (default https://solscan.io)
//
// How much each wallet earns (tiers, days held, videos) lives in rewards.js.

import { isPubkey, parseSecretKey, rpcClient, tokenBalance, mintInfo, buildTransfer } from "./solana.js";

export const DEFAULT_NFLX_MINT = "NFLX7qV57zuVxCoHy3s1jiGZyALraLNwttbxdvmYJLJ";
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const okRpc = u => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u);
const SETTLE_AFTER_MS = 3 * 60e3;   // a blockhash expires after ~1-2 min: unseen after 3 min = never landed

export function payoutConfig(env) {
  const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? String(v).trim() : d);
  let signer = null, keyError = null;
  if ((env.SOLANA_TREASURY_KEY || "").trim()) { try { signer = parseSecretKey(env.SOLANA_TREASURY_KEY); } catch (e) { keyError = e.message; } }
  const cfg = {
    enabled: String(env.PAYOUTS_ENABLED || "").trim().toLowerCase() === "true",
    perClaim: num(env.NFLX_PER_CLAIM, "0.001"),
    maxDaily: num(env.MAX_DAILY_NFLX, "0.1"),
    maxPerUser: num(env.MAX_PER_USER_NFLX, "0.01"),
    priority: Math.round(Number(num(env.PRIORITY_FEE, "5000"))),
    mint: (env.NFLX_MINT || DEFAULT_NFLX_MINT).trim(),
    rpc: (env.SOLANA_RPC_URL || DEFAULT_RPC).trim(),
    explorer: (env.EXPLORER_URL || "https://solscan.io").trim().replace(/\/+$/, ""),
    signer, keyError,
  };
  cfg.missing = [
    !isPubkey(cfg.mint) && "NFLX_MINT",
    !okRpc(cfg.rpc) && "SOLANA_RPC_URL",
    !signer && (keyError ? `SOLANA_TREASURY_KEY (${keyError})` : "SOLANA_TREASURY_KEY"),
  ].filter(Boolean);
  cfg.ready = cfg.missing.length === 0;
  return cfg;
}

/** Public, non-secret view of the payout settings. */
export function publicPayoutInfo(env) {
  const c = payoutConfig(env);
  return { enabled: c.enabled && c.ready, perClaim: c.perClaim, maxPerUser: c.maxPerUser, chain: "Solana",
    token: c.mint, explorer: c.explorer };
}

export function nflxAmount(env, factors) {
  const c = payoutConfig(env);
  return Math.min(Number(c.perClaim) * factors.total, Number(c.maxPerUser)).toFixed(6);
}

export async function ensurePayoutSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, day TEXT NOT NULL,
    amount TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, error TEXT,
    created_at INTEGER NOT NULL, sent_at INTEGER, sent_day TEXT,
    UNIQUE(address, day))`).run();
}

/** Queue the payout for a claim. Solana wallets only; one per wallet per day. */
export async function queuePayout(db, env, { address, chain, day, factors }) {
  const c = payoutConfig(env);
  if (chain !== "Solana" || !(Number(c.perClaim) > 0) || !(factors.total > 0)) return null;
  const amount = nflxAmount(env, factors);
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

const toRaw = (amount, decimals) => {
  const [w, f = ""] = String(amount).split(".");
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
};
const fromRaw = (raw, decimals) => Number(raw) / 10 ** decimals;

/** Treasury address and balances, for the admin page. */
export async function treasuryInfo(env, deps = {}) {
  const c = payoutConfig(env);
  if (!c.ready) return { ready: false, missing: c.missing, enabled: c.enabled };
  const rpc = deps.rpc || rpcClient(c.rpc);
  const [bal, sol] = await Promise.all([tokenBalance(rpc, c.signer.publicKey, c.mint), rpc("getBalance", [c.signer.publicKey])]);
  return { ready: true, enabled: c.enabled, address: c.signer.publicKey, symbol: "NFLX", chain: "Solana",
    token: String(bal.amount), sol: String((sol.value || 0) / 1e9),
    perClaim: c.perClaim, maxDaily: c.maxDaily, explorer: c.explorer };
}

/** Send every pending payout. Safe to run more than once a day. */
export async function runPayouts(env, { deps = {}, now = Date.now() } = {}) {
  const db = env.DB;
  const c = payoutConfig(env);
  if (!db) return { status: "no_database" };
  await ensurePayoutSchema(db);
  const { results: pending } = await db.prepare(
    "SELECT * FROM payouts WHERE status = 'pending' ORDER BY day, id LIMIT 200").all();
  if (!c.ready) return { status: "not_configured", missing: c.missing, pending: pending.length };
  if (!c.enabled) return { status: "disabled", pending: pending.length };

  const rpc = deps.rpc || rpcClient(c.rpc);
  const today = utcDay(now);

  // 1. settle earlier transfers
  const { results: unsettled } = await db.prepare("SELECT id, tx_hash, sent_at FROM payouts WHERE status = 'sent' LIMIT 200").all();
  if (unsettled.length) {
    const st = await rpc("getSignatureStatuses", [unsettled.map(r => r.tx_hash), { searchTransactionHistory: true }]);
    for (const [i, r] of unsettled.entries()) {
      const s = st.value[i];
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"))
        await db.prepare("UPDATE payouts SET status = ?, error = ? WHERE id = ?").bind(s.err ? "failed" : "confirmed", s.err ? JSON.stringify(s.err).slice(0, 300) : null, r.id).run();
      else if (!s && now - r.sent_at > SETTLE_AFTER_MS)
        await db.prepare("UPDATE payouts SET status = 'failed', error = 'not landed (blockhash expired)' WHERE id = ?").bind(r.id).run();
    }
  }

  // 2. today's budget and the treasury's balance
  const mi = await mintInfo(rpc, c.mint);
  const { results: sentToday } = await db.prepare(
    "SELECT amount FROM payouts WHERE sent_day = ? AND status IN ('sent','confirmed')").bind(today).all();
  let budget = toRaw(c.maxDaily, mi.decimals);
  for (const r of sentToday) budget -= toRaw(r.amount, mi.decimals);
  let balance = (await tokenBalance(rpc, c.signer.publicKey, c.mint)).raw;
  const lamports = (await rpc("getBalance", [c.signer.publicKey])).value || 0;
  if (lamports < 3_000_000) return { status: "ran", sent: 0, failed: 0, left: pending.length, stoppedBy: "treasury_out_of_sol" };

  const out = { status: "ran", sent: 0, failed: 0, left: 0, stoppedBy: null };
  for (const row of pending) {
    const raw = toRaw(row.amount, mi.decimals);
    if (raw > budget) { out.stoppedBy = "daily_cap"; break; }
    if (raw > balance) { out.stoppedBy = "treasury_low"; break; }
    if (!isPubkey(row.address)) {
      await db.prepare("UPDATE payouts SET status = 'failed', error = 'not a Solana address' WHERE id = ?").bind(row.id).run();
      out.failed++; continue;
    }
    try {
      const { value: { blockhash } } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const t = buildTransfer({ signer: c.signer, recipient: row.address, mint: c.mint, tokenProgram: mi.program,
        decimals: mi.decimals, raw, blockhash, priorityMicroLamports: c.priority, computeUnits: 60000 });
      await rpc("sendTransaction", [t.base64, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
      budget -= raw; balance -= raw;
      await db.prepare("UPDATE payouts SET status = 'sent', tx_hash = ?, sent_at = ?, sent_day = ?, error = NULL WHERE id = ?")
        .bind(t.signature, now, today, row.id).run();
      out.sent++;
    } catch (e) {
      await db.prepare("UPDATE payouts SET status = 'failed', error = ? WHERE id = ?").bind(String(e.message || e).slice(0, 300), row.id).run();
      out.failed++;
      if (/insufficient (funds|lamports)/i.test(String(e.message))) { out.stoppedBy = "treasury_out_of_sol"; break; }
    }
  }
  out.left = pending.length - out.sent - out.failed;
  return out;
}

export { fromRaw };
