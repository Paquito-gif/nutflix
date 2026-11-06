// Minimal Solana toolkit for the Worker: base58, keys, associated token accounts, RPC,
// SPL / Token-2022 balances and a signed "create ATA if needed + transferChecked" transaction.
// No SDK: built on the vendored @noble ed25519 + sha256 so it runs as-is on Cloudflare Workers.

import { ed25519, sha256 } from "./ed25519.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/* ---------- base58 ---------- */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  if (typeof s !== "string" || !s.length) throw new Error("bad base58");
  const bytes = [];
  for (const c of s) {
    let carry = B58.indexOf(c);
    if (carry < 0) throw new Error("bad base58");
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 255; carry >>= 8; }
    while (carry) { bytes.push(carry & 255); carry >>= 8; }
  }
  for (const c of s) { if (c === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}
export function b58encode(u8) {
  const digits = [];
  for (const byte of u8) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const byte of u8) { if (byte === 0) out += "1"; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
/** A valid Solana public key (32 bytes, base58). Off-curve PDAs are valid too. */
export function isPubkey(s) {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try { return b58decode(s).length === 32; } catch { return false; }
}

/* ---------- keys ---------- */
/** Parse a treasury secret: base58 64-byte secret (Phantom/Solflare export) or a JSON array (solana-keygen). */
export function parseSecretKey(raw) {
  const s = String(raw || "").trim();
  let bytes;
  if (s.startsWith("[")) bytes = Uint8Array.from(JSON.parse(s));
  else bytes = b58decode(s);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("secret key must be 64 bytes (or a 32-byte seed)");
  const seed = bytes.slice(0, 32);
  const pub = ed25519.getPublicKey(seed);
  if (bytes.length === 64 && !bytes.slice(32).every((b, i) => b === pub[i])) throw new Error("secret key does not match its public key");
  return { seed, publicKey: b58encode(pub), sign: msg => ed25519.sign(msg, seed) };
}

/* ---------- program-derived addresses ---------- */
const onCurve = bytes => { try { ed25519.ExtendedPoint.fromHex(bytes); return true; } catch { return false; } };
const concat = parts => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
export function findProgramAddress(seeds, programId) {
  const pid = b58decode(programId), tag = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat([...seeds, Uint8Array.of(bump), pid, tag]));
    if (!onCurve(h)) return b58encode(h);
  }
  throw new Error("no viable bump");
}
export const associatedTokenAddress = (owner, mint, tokenProgram = TOKEN_PROGRAM) =>
  findProgramAddress([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], ATA_PROGRAM);

/* ---------- RPC ---------- */
export function rpcClient(url, fetcher = fetch) {
  let id = 0;
  return async (method, params = []) => {
    const r = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error((j.error && j.error.message) || `rpc ${method} http ${r.status}`);
    return j.result;
  };
}
/** Token amount an owner holds for a mint (all its token accounts, both token programs), in whole tokens. */
export async function tokenBalance(rpc, owner, mint) {
  const res = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  let raw = 0n, decimals = 0;
  for (const a of res.value || []) {
    const t = a.account.data.parsed.info.tokenAmount;
    raw += BigInt(t.amount); decimals = t.decimals;
  }
  return { raw, decimals, amount: Number(raw) / 10 ** decimals };
}
export async function mintInfo(rpc, mint) {
  const res = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
  if (!res.value) throw new Error("mint not found");
  return { program: res.value.owner, decimals: res.value.data.parsed.info.decimals };
}

/* ---------- transactions ---------- */
const u64le = n => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(v & 255n); v >>= 8n; } return b; };
const u32le = n => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255);
const shortvec = n => { const o = []; let v = n; for (;;) { let e = v & 0x7f; v >>= 7; if (v) { o.push(e | 0x80); } else { o.push(e); break; } } return Uint8Array.from(o); };

/**
 * Signed legacy transaction: set compute budget, create the recipient's associated token account if it
 * doesn't exist (idempotent, paid by the treasury), then transferChecked `raw` units of `mint`.
 */
export function buildTransfer({ signer, recipient, mint, tokenProgram, decimals, raw, blockhash, priorityMicroLamports = 5000, computeUnits = 80000 }) {
  const treasury = signer.publicKey;
  const src = associatedTokenAddress(treasury, mint, tokenProgram);
  const dst = associatedTokenAddress(recipient, mint, tokenProgram);
  // account order: signer+writable | writable | readonly
  const keys = [treasury, src, dst, recipient, mint, SYSTEM_PROGRAM, tokenProgram, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM];
  const idx = k => keys.indexOf(k);
  const ix = (prog, accts, data) => concat([Uint8Array.of(idx(prog)), shortvec(accts.length), Uint8Array.from(accts.map(idx)), shortvec(data.length), data]);
  const instructions = [
    ix(COMPUTE_BUDGET_PROGRAM, [], concat([Uint8Array.of(2), u32le(computeUnits)])),
    ix(COMPUTE_BUDGET_PROGRAM, [], concat([Uint8Array.of(3), u64le(priorityMicroLamports)])),
    ix(ATA_PROGRAM, [treasury, dst, recipient, mint, SYSTEM_PROGRAM, tokenProgram], Uint8Array.of(1)),
    ix(tokenProgram, [src, mint, dst, treasury], concat([Uint8Array.of(12), u64le(raw), Uint8Array.of(decimals)])),
  ];
  const message = concat([
    Uint8Array.of(1, 0, 6),                         // 1 signer, 0 readonly signers, 6 readonly non-signers
    shortvec(keys.length), ...keys.map(b58decode),
    b58decode(blockhash),
    shortvec(instructions.length), ...instructions,
  ]);
  const sig = signer.sign(message);
  const tx = concat([shortvec(1), sig, message]);
  return { tx, signature: b58encode(sig), base64: btoa(String.fromCharCode(...tx)) };
}
