// Nutflix API — Cloudflare Pages Functions + D1.
//
// Every route lives under /api/*. Accounts are keyed by wallet address and
// proven with a signed, single-use sign-in message. The server owns the
// reward rules (watch, claim, starter bag), so the browser can't fake them.
//
// Bindings (Cloudflare dashboard → Pages project → Settings):
//   DB         D1 database (tables are created on first request)
//   ADMIN_KEY  secret used by /admin.html to list every account

import { ed25519 } from "../_lib/ed25519.js";
import { b58decode, isPubkey } from "../_lib/solana.js";
import { queuePayout, payoutsFor, publicPayoutInfo, treasuryInfo, runPayouts, ensurePayoutSchema } from "../_lib/payouts.js";
import { factors as rewardFactors, nflxFor, nutConfig, nutPriceUsd, nutBalance, tierFor, nextTier, publicTiers, MIN_USD, VIDEOS_PER_DAY } from "../_lib/rewards.js";

const MAX_PROFILES = 4;
const NONCE_TTL_MS = 10 * 60e3;   // sign-in message validity
const SESSION_TTL_MS = 30 * 864e5;
const AVATARS = ["hodl", "peachy", "righty", "big-egg", "incognito", "sister", "paper-pete", "slick-tissy"];
const MAX_HISTORY = 120;

const enc = new TextEncoder();
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status, error) => json({ error }, status);
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const hex = u => [...u].map(b => b.toString(16).padStart(2, "0")).join("");
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Solana only: a 32-byte base58 public key. */
function normalizeAddress(chain, address) {
  return chain === "Solana" && isPubkey(address) ? address : null;
}

/** Ed25519 signature check of the sign-in message (Solana wallets sign the raw UTF-8 bytes). */
async function signatureIsValid(chain, address, message, signature) {
  if (chain !== "Solana") return false;
  try { return ed25519.verify(fromB64(signature), enc.encode(message), b58decode(address)); }
  catch { return false; }
}

/* ---------- storage ---------- */
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      address TEXT PRIMARY KEY, chain TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL, state TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY, address TEXT NOT NULL, chain TEXT NOT NULL,
      message TEXT NOT NULL, created_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, address TEXT NOT NULL, expires_at INTEGER NOT NULL)`),
  ]);
  // Solana only: remove anything left from Ethereum / Robinhood Chain sign-ins (accounts, sessions, nonces, payouts)
  await ensurePayoutSchema(db);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE address IN (SELECT address FROM users WHERE chain <> 'Solana') OR address LIKE '0x%'"),
    db.prepare("DELETE FROM payouts WHERE address LIKE '0x%'"),
    db.prepare("DELETE FROM nonces WHERE chain <> 'Solana'"),
    db.prepare("DELETE FROM users WHERE chain <> 'Solana'"),
  ]);
  schemaReady = true;
}

const blankState = () => ({
  bal: 0, earned: 0, watched: null, claimed: null, streak: 0, best: 0, holdSince: null,
  videos: 0, videoDay: null, videoToday: 0,
  claims: 0, starter: false, watchLog: [], history: [], profiles: [],
});
const readState = row => Object.assign(blankState(), JSON.parse(row.state || "{}"));
async function writeState(db, address, state) {
  await db.prepare("UPDATE users SET state = ?, last_seen = ? WHERE address = ?")
    .bind(JSON.stringify(state), Date.now(), address).run();
}
function account(row, state) {
  return { address: row.address, chain: row.chain, createdAt: row.created_at, state, today: utcDay(), serverTime: Date.now() };
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
/** Today's NFLX reward for this wallet: real $Nutflix held → $ value → tier, × days held × videos watched. */
async function rewardPreview(env, db, row, state, today, deps = env.__TEST_CHAIN /* tests only */) {
  const c = nutConfig(env);
  const base = { launched: c.launched, buyUrl: c.buyUrl, minUsd: MIN_USD, videos: state.videos || 0, tiers: publicTiers() };
  if (!c.launched) return { ...base, eligible: false, reason: "not_launched" };
  if (row.chain !== "Solana") return { ...base, eligible: false, reason: "wrong_wallet", balance: 0, usd: 0 };
  let balance, price;
  try { [balance, price] = await Promise.all([nutBalance(env, row.address, deps), nutPriceUsd(env, db).then(p => p.price)]); }
  catch { return { ...base, eligible: false, reason: "chain_unreachable" }; }
  if (!price) return { ...base, eligible: false, reason: "no_price", balance };
  const usd = balance * price;
  const tier = tierFor(usd), next = nextTier(usd);
  const since = tier ? (state.holdSince || today) : null;
  const holdDays = since ? daysBetween(since, today) + 1 : 0;
  const f = rewardFactors({ usd, holdDays, videos: state.videos || 0 });
  return { ...base, eligible: !!tier, reason: tier ? null : "hold_more", balance, price, usd, holdSince: since, holdDays,
    tier: tier && { key: tier.key, name: tier.name, icon: tier.icon, mult: tier.mult },
    next: next && { name: next.name, icon: next.icon, minUsd: next.minUsd, needUsd: Math.max(next.minUsd - usd, 0) },
    factors: f, nflx: tier ? nflxFor(env, f) : null };
}
/** Consecutive days watched, ending today (or yesterday if today isn't watched yet), and the best run ever. */
function watchStreaks(log, today) {
  const days = [...new Set(log || [])].sort();
  const set = new Set(days);
  const prev = d => new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10);
  let cur = 0, d = set.has(today) ? today : prev(today);
  while (set.has(d)) { cur++; d = prev(d); }
  let best = 0, run = 0, last = null;
  for (const x of days) { run = last && prev(x) === last ? run + 1 : 1; best = Math.max(best, run); last = x; }
  return { cur, best, days: days.length };
}
const shortAddr = a => a.slice(0, 6) + "…" + a.slice(-4);
const pushHistory = (state, entry) => { state.history = [...state.history, entry].slice(-MAX_HISTORY); };

async function sessionUser(db, request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const s = await db.prepare("SELECT address, expires_at FROM sessions WHERE token = ?").bind(token).first();
  if (!s || s.expires_at < Date.now()) return null;
  const row = await db.prepare("SELECT * FROM users WHERE address = ?").bind(s.address).first();
  return row ? { row, token } : null;
}

async function body(request) {
  const text = await request.text();
  if (text.length > 16384) throw Object.assign(new Error("too large"), { status: 413 });
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------- routes ---------- */
export async function onRequest({ request, env, params }) {
  const route = [].concat(params.route || []).join("/");
  const method = request.method;
  const adminKey = typeof env.ADMIN_KEY === "string" ? env.ADMIN_KEY.trim() : "";
  if (route === "health") return json({ ok: true, configured: !!env.DB, admin: !!adminKey, payouts: publicPayoutInfo(env), nut: { chain: "Solana", launched: nutConfig(env).launched, buyUrl: nutConfig(env).buyUrl, chartUrl: nutConfig(env).chartUrl, token: nutConfig(env).launched ? nutConfig(env).token : null, minUsd: MIN_USD, tiers: publicTiers(), videosPerDay: VIDEOS_PER_DAY }, today: utcDay(), serverTime: Date.now() });
  if (!env.DB) return fail(503, "database_not_configured");
  const db = env.DB;

  try {
    await ensureSchema(db);

    // 1. ask for a sign-in message
    if (route === "nonce" && method === "POST") {
      const { chain, address: rawAddress } = await body(request);
      const address = normalizeAddress(chain, rawAddress);
      if (!address) return fail(400, "bad_address");
      const nonce = randomHex(16);
      const host = new URL(request.url).host;
      const message = `Nutflix wants you to sign in with this wallet.\n\nAddress: ${address}\nDomain: ${host}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}\n\nSigning is free and does not send any transaction.`;
      await db.batch([
        db.prepare("DELETE FROM nonces WHERE created_at < ?").bind(Date.now() - NONCE_TTL_MS),
        db.prepare("INSERT INTO nonces (nonce, address, chain, message, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(nonce, address, chain, message, Date.now()),
      ]);
      return json({ nonce, message });
    }

    // 2. prove the wallet with the signed message → session
    if (route === "verify" && method === "POST") {
      const { nonce, signature } = await body(request);
      if (typeof nonce !== "string" || typeof signature !== "string") return fail(400, "bad_request");
      const n = await db.prepare("SELECT * FROM nonces WHERE nonce = ?").bind(nonce).first();
      if (!n) return fail(400, "unknown_nonce");
      await db.prepare("DELETE FROM nonces WHERE nonce = ?").bind(nonce).run();   // single use
      if (n.created_at < Date.now() - NONCE_TTL_MS) return fail(400, "expired_nonce");
      if (!(await signatureIsValid(n.chain, n.address, n.message, signature))) return fail(401, "bad_signature");

      const now = Date.now();
      await db.prepare(`INSERT INTO users (address, chain, created_at, last_seen, state) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(address) DO UPDATE SET last_seen = excluded.last_seen`)
        .bind(n.address, n.chain, now, now, JSON.stringify(blankState())).run();
      const token = randomHex(32);
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
        db.prepare("INSERT INTO sessions (token, address, expires_at) VALUES (?, ?, ?)").bind(token, n.address, now + SESSION_TTL_MS),
      ]);
      const row = await db.prepare("SELECT * FROM users WHERE address = ?").bind(n.address).first();
      return json({ token, ...account(row, readState(row)) });
    }

    // 3. admin listing
    if (route === "admin/users" && method === "GET") {
      if (!adminKey) return fail(503, "admin_key_not_set");
      if (!timingSafeEqual((request.headers.get("x-admin-key") || "").trim(), adminKey)) return fail(401, "unauthorized");
      const { results } = await db.prepare("SELECT * FROM users ORDER BY last_seen DESC LIMIT 1000").all();
      return json({
        today: utcDay(),
        users: results.map(r => {
          const s = readState(r);
          return { address: r.address, chain: r.chain, createdAt: r.created_at, lastSeen: r.last_seen,
            watched: s.watched, days: s.watchLog.length, streak: s.streak, best: s.best, claims: s.claims,
            bal: s.bal, earned: s.earned, profiles: s.profiles.length };
        }),
      });
    }

    if (route.startsWith("admin/payouts") || route === "admin/treasury") {
      if (!adminKey) return fail(503, "admin_key_not_set");
      if (!timingSafeEqual((request.headers.get("x-admin-key") || "").trim(), adminKey)) return fail(401, "unauthorized");
      await ensurePayoutSchema(db);
      if (route === "admin/payouts" && method === "GET") {
        const { results } = await db.prepare("SELECT * FROM payouts ORDER BY id DESC LIMIT 500").all();
        return json({ payouts: results, info: publicPayoutInfo(env) });
      }
      if (route === "admin/payouts/run" && method === "POST") return json(await runPayouts(env));
      if (route === "admin/payouts/retry" && method === "POST") {
        const { id } = await body(request);
        await db.prepare("UPDATE payouts SET status = 'pending', error = NULL WHERE id = ? AND status = 'failed'").bind(Number(id)).run();
        return json({ ok: true });
      }
      if (route === "admin/treasury" && method === "GET") {
        try { return json(await treasuryInfo(env)); }
        catch (e) { return json({ ready: false, reachable: false, enabled: publicPayoutInfo(env).enabled, missing: [], error: String(e.shortMessage || e.message).slice(0, 200) }); }
      }
      return fail(404, "not_found");
    }

    // public leaderboard: best current watch streaks (short addresses and profile names only)
    if (route === "leaderboard" && method === "GET") {
      const today = utcDay();
      const { results } = await db.prepare("SELECT address, chain, state FROM users").all();
      const rows = results.map(r => {
        const s = readState(r), w = watchStreaks(s.watchLog, today), p = (s.profiles || [])[0];
        return { who: shortAddr(r.address), chain: r.chain, name: p ? p.name : null, avatar: p ? p.avatar : null, bg: p ? p.bg : null,
          streak: w.cur, best: Math.max(w.best, s.best || 0), days: w.days, videos: s.videos || 0 };
      }).filter(x => x.days > 0)
        .sort((a, b) => b.streak - a.streak || b.best - a.best || b.days - a.days || b.videos - a.videos);
      return json({ today, players: rows.length, rows: rows.slice(0, 50) });
    }

    // everything below needs a session
    const me = await sessionUser(db, request);
    if (!me) return fail(401, "not_signed_in");
    const { row } = me;
    const state = readState(row);
    const today = utcDay(), yesterday = utcDay(Date.now() - 864e5);

    if (route === "me" && method === "GET") {
      await db.prepare("UPDATE users SET last_seen = ? WHERE address = ?").bind(Date.now(), row.address).run();
      return json({ ...account(row, state), payouts: await payoutsFor(db, row.address), reward: await rewardPreview(env, db, row, state, today) });
    }

    if (route === "logout" && method === "POST") {
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(me.token).run();
      return json({ ok: true });
    }

    if (route === "watch" && method === "POST") {
      const { title } = await body(request);
      const t = String(title || "an episode").slice(0, 80);
      if (state.watched !== today) {
        state.watched = today;
        state.watchLog = [...state.watchLog.filter(d => d !== today), today].slice(-366);
      }
      if (state.videoDay !== today) { state.videoDay = today; state.videoToday = 0; }
      if (state.videoToday < VIDEOS_PER_DAY) { state.videoToday++; state.videos = (state.videos || 0) + 1; }
      pushHistory(state, { d: today, at: Date.now(), ty: "watch", t });
      await writeState(db, row.address, state);
      return json({ ...account(row, state), reward: await rewardPreview(env, db, row, state, today) });
    }

    if (route === "starter" && method === "POST") return fail(410, "no_free_supply");   // $Nutflix must be bought

    if (route === "claim" && method === "POST") {
      if (state.claimed === today) return fail(409, "already_claimed_today");
      if (state.watched !== today) return fail(409, "watch_first");
      const preview = await rewardPreview(env, db, row, state, today);
      if (preview.reason === "chain_unreachable" || preview.reason === "no_price") return fail(503, preview.reason);
      if (preview.reason === "not_launched") return fail(409, "not_launched");
      if (preview.reason === "wrong_wallet") return fail(409, "wrong_wallet");
      if (!preview.eligible) { state.holdSince = null; await writeState(db, row.address, state); return fail(409, "hold_more"); }
      state.holdSince = preview.holdSince;
      const streak = state.claimed === yesterday ? state.streak + 1 : 1;
      Object.assign(state, { streak, best: Math.max(state.best, streak), claimed: today, claims: state.claims + 1 });
      const nflx = await queuePayout(db, env, { address: row.address, chain: row.chain, day: today, factors: preview.factors });
      pushHistory(state, { d: today, at: Date.now(), ty: "claim", s: streak, x: nflx, tier: preview.tier.key, usd: Math.round(preview.usd) });
      await writeState(db, row.address, state);
      return json({ nflx, ...account(row, state), payouts: await payoutsFor(db, row.address), preview });
    }

    if (route === "profiles" && method === "PUT") {
      const { profiles } = await body(request);
      if (!Array.isArray(profiles) || profiles.length > MAX_PROFILES) return fail(400, "bad_profiles");
      const clean = [];
      for (const p of profiles) {
        const name = String(p?.name || "").trim().replace(/\s+/g, " ").slice(0, 16);
        if (!name || !AVATARS.includes(p?.avatar) || !/^#[0-9a-fA-F]{6}$/.test(p?.bg || "")) return fail(400, "bad_profile");
        clean.push({ id: String(p.id || randomHex(4)).slice(0, 20), name, avatar: p.avatar, bg: p.bg });
      }
      state.profiles = clean;
      await writeState(db, row.address, state);
      return json({ ...account(row, state), reward: await rewardPreview(env, db, row, state, today) });
    }

    return fail(404, "not_found");
  } catch (e) {
    if (e.status) return fail(e.status, e.message);
    console.error("nutflix api", e);
    return fail(500, "server_error");
  }
}
