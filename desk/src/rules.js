// The desk's rules as plain functions, so they can be tested without a network: what a quote costs, and whether the
// lock a user made is the one the desk agreed to before it puts its own USDC down.

export const RULES = {
  feeBps: 50n, // 0.5% of what the user receives
  minUsdCents: 5n, // $0.05
  maxUsdCents: 25n, // $0.25 a swap while the desk runs on demo liquidity
  dailyUsdCents: 300n, // $3 a day in total
  maxFee: 2000n, // SwapLockV2 constructor: miners may take at most this from the lock
  lockExtraSats: 3000n, // sats the user adds to the lock so the desk's claim can pay its fee and keep dust
  userTimeoutMinSec: 2 * 3600, // the user's BCH lock must give the desk at least this long
  userTimeoutMaxSec: 24 * 3600,
  deskTimeoutSec: 3600, // the desk's Base lock: one hour for the user to finish
  deskMarginSec: 3600, // the desk's lock must expire at least this long before the user's
  quoteTtlSec: 600,
};

export const PUSD_CATEGORY = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const SWAP_LOCK_BASE = "0xf66642c35cf4a36fcd7d3bcf87422791280f8901";

const usdcFromCents = (cents) => cents * 10_000n; // 6 decimals

// pay: "PUSD" (amount in PUSD units, 2 decimals) or "BCH" (amount in sats). bchUsd: dollars per BCH (number).
export function priceQuote({ pay, payUnits, bchUsd }) {
  payUnits = BigInt(payUnits);
  if (payUnits <= 0n) throw new Error("Amount must be positive.");
  let usdMicros; // value of what the user pays, in USDC base units (1e-6 dollars)
  if (pay === "PUSD") usdMicros = payUnits * 10_000n;
  else if (pay === "BCH") {
    if (!(bchUsd > 0)) throw new Error("No BCH price right now; try again in a minute.");
    usdMicros = (payUnits * BigInt(Math.round(bchUsd * 1e6))) / 100_000_000n;
  } else throw new Error("Pay with PUSD or BCH.");
  if (usdMicros < usdcFromCents(RULES.minUsdCents)) throw new Error("The desk takes at least $0.05.");
  if (usdMicros > usdcFromCents(RULES.maxUsdCents)) throw new Error("The demo desk takes at most $0.25 a swap.");
  const feeUnits = (usdMicros * RULES.feeBps + 9_999n) / 10_000n;
  const usdcUnits = usdMicros - feeUnits;
  const lockSats = pay === "BCH" ? payUnits + RULES.lockExtraSats : RULES.lockExtraSats;
  return { pay, payUnits, usdMicros, feeUnits, usdcUnits, lockSats };
}

// What the desk checks before it locks USDC. utxo is what Electrum reports at the contract address.
export function checkUserLock({ quote, utxo, bchTimeout, nowSec }) {
  if (!utxo) return { ok: false, retry: true, reason: "Your lock is not on the network yet." };
  if (BigInt(utxo.value) < BigInt(quote.lockSats)) return { ok: false, reason: "The lock holds fewer satoshis than the quote." };
  if (quote.pay === "PUSD") {
    if (!utxo.token || utxo.token.category !== PUSD_CATEGORY) return { ok: false, reason: "The lock holds no PUSD." };
    if (utxo.token.nft) return { ok: false, reason: "The lock holds an NFT." };
    if (BigInt(utxo.token.amount) < BigInt(quote.payUnits)) return { ok: false, reason: "The lock holds less PUSD than the quote." };
  } else if (utxo.token) return { ok: false, reason: "A BCH lock must not carry tokens." };
  if (bchTimeout < nowSec + RULES.userTimeoutMinSec) return { ok: false, reason: "Your lock expires too soon for the desk." };
  if (bchTimeout > nowSec + RULES.userTimeoutMaxSec) return { ok: false, reason: "Your lock expires too far in the future." };
  const deskTimeout = Math.min(nowSec + RULES.deskTimeoutSec, bchTimeout - RULES.deskMarginSec);
  if (deskTimeout < nowSec + 15 * 60) return { ok: false, reason: "Not enough time left to finish safely." };
  return { ok: true, deskTimeout };
}

// Quotes are not stored: the desk signs them (HMAC) and checks the signature when the user comes back.
export async function signQuote(key, body) {
  const data = new TextEncoder().encode(JSON.stringify(body));
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function verifyQuote(key, body, mac, nowSec) {
  if (!body || typeof mac !== "string") return "Missing quote.";
  if ((await signQuote(key, body)) !== mac) return "The quote was changed.";
  if (nowSec > body.expiresAt) return "The quote expired; get a new one.";
  return null;
}

// --- The reverse direction: USDC on Base in, PUSD or BCH on Bitcoin Cash out ------------------------------------
// The user is still the maker: they lock USDC on Base first (with the secret's hash, paying the desk), the desk then
// funds a SwapLockV2 on Bitcoin Cash that pays the user. The user names what they want to receive.
export const REVERSE = {
  claimFeeSats: 600n, // what the claim transaction leaves to miners (see spendLockTx)
  pusdLockSats: 1600n, // a PUSD lock carries 1,000 sat of dust to the user plus the claim fee
  baseTimeoutMinSec: 2.5 * 3600,
  baseTimeoutMaxSec: 24 * 3600,
  // The desk's BCH lock ends at least this long before the user's Base lock: an hour of margin plus up to an hour by
  // which Bitcoin Cash median time trails the clock (so the desk can refund only about an hour after its timeout).
  marginSec: 2 * 3600,
};

// receive: "PUSD" (units, 2 decimals) or "BCH" (sats). The user locks usdcUnits on Base.
export function priceQuoteToBch({ receive, receiveUnits, bchUsd }) {
  receiveUnits = BigInt(receiveUnits);
  if (receiveUnits <= 0n) throw new Error("Amount must be positive.");
  let usdMicros;
  if (receive === "PUSD") usdMicros = receiveUnits * 10_000n;
  else if (receive === "BCH") {
    if (!(bchUsd > 0)) throw new Error("No BCH price right now; try again in a minute.");
    usdMicros = (receiveUnits * BigInt(Math.round(bchUsd * 1e6)) + 99_999_999n) / 100_000_000n;
  } else throw new Error("Receive PUSD or BCH.");
  if (usdMicros < usdcFromCents(RULES.minUsdCents)) throw new Error("The desk takes at least $0.05.");
  if (usdMicros > usdcFromCents(RULES.maxUsdCents)) throw new Error("The demo desk takes at most $0.25 a swap.");
  const feeUnits = (usdMicros * RULES.feeBps + 9_999n) / 10_000n;
  const usdcUnits = usdMicros + feeUnits;
  const lockSats = receive === "BCH" ? receiveUnits + REVERSE.claimFeeSats : REVERSE.pusdLockSats;
  return { receive, receiveUnits, usdMicros, feeUnits, usdcUnits, lockSats };
}

// What the desk checks on the user's Base lock (found by its id, which commits to token, sender, recipient = desk,
// amount, hash and timeout) before it puts its own coins down on Bitcoin Cash.
export function checkUserBaseLock({ state, baseTimeout, nowSec }) {
  if (!state?.exists) return { ok: false, retry: true, reason: "Your Base lock is not visible yet." };
  if (state.settled) return { ok: false, reason: "Your Base lock is already settled." };
  if (baseTimeout < nowSec + REVERSE.baseTimeoutMinSec) return { ok: false, reason: "Your Base lock expires too soon for the desk." };
  if (baseTimeout > nowSec + REVERSE.baseTimeoutMaxSec) return { ok: false, reason: "Your Base lock expires too far in the future." };
  const deskTimeout = Math.min(nowSec + RULES.deskTimeoutSec, baseTimeout - REVERSE.marginSec);
  if (deskTimeout < nowSec + 20 * 60) return { ok: false, reason: "Not enough time left to finish safely." };
  return { ok: true, deskTimeout };
}
