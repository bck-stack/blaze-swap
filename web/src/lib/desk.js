// The page's side of a swap with the BLAZE Desk. The user stays the maker: this page makes the secret, locks the
// user's PUSD or BCH in a SwapLockV2 on Bitcoin Cash, waits for the desk's USDC lock on Base, checks that lock on chain
// itself, and only then hands the secret to the desk, which delivers the USDC and takes its side.
import {
  Contract,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
} from "cashscript";
import SwapLockV2Artifact from "../contracts/SwapLockV2.json";
import { NETWORK_CONFIG, bytesToHex, computeEvmLockId, generateSecretPair, hexToBytes, normalizeHex32 } from "./swapProtocol.js";
import { getElectrumProvider, toRelayRequest } from "./bchBridge.js";
import { approveEvmUsdc, fetchEvmLockState, getEvmPublicClient, lockEvmSwap } from "./evmBridge.js";

export const DESK_URL = import.meta.env.VITE_DESK_URL || "https://blaze-desk.launch-engine.workers.dev";
export const USER_LOCK_HOURS = 3;
const cfg = NETWORK_CONFIG.mainnet;
const STORE = "blaze_desk_swaps_v1";

async function call(path, body) {
  const res = await fetch(`${DESK_URL}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({ ok: false, error: `Desk answered ${res.status}` }));
  if (!data.ok) throw new Error(data.error || "The desk refused the request.");
  return data;
}
export const deskStatus = () => call("/api/status");
export const deskQuote = (pay, payUnits) => call("/api/quote", { pay, payUnits: String(payUnits) });
export const deskQuoteToBch = (receive, receiveUnits) => call("/api/quote", { dir: "toBch", receive, receiveUnits: String(receiveUnits) });
export const deskTake = (body) => call("/api/take", body);
export const deskReveal = (secret) => call("/api/reveal", { secret });
export const deskSwap = (hash) => call(`/api/swap/${hash}`);
export const deskRecent = () => call("/api/recent");

// Every swap the user starts is kept in this browser until it finishes, with its secret, so a closed tab can resume.
export function loadDeskSwaps() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "[]");
  } catch {
    return [];
  }
}
export function saveDeskSwap(s) {
  try {
    const all = loadDeskSwaps().filter((x) => x.hash !== s.hash);
    localStorage.setItem(STORE, JSON.stringify([s, ...all].slice(0, 20)));
  } catch {
    /* private window: the swap still runs, it just cannot be resumed */
  }
}

export function lockContract({ deskPkh, userPkh, secretHash, timeout, maxFee }) {
  return new Contract(
    SwapLockV2Artifact,
    [hexToBytes(deskPkh), hexToBytes(userPkh), hexToBytes(normalizeHex32(secretHash)), BigInt(timeout), BigInt(maxFee)],
    { provider: getElectrumProvider("mainnet"), addressType: "p2sh32" }
  );
}

export async function newSwapTerms({ quote, userPkh }) {
  const { secret, secretHash } = await generateSecretPair();
  const timeout = Math.floor(Date.now() / 1000) + USER_LOCK_HOURS * 3600;
  return { secret, secretHash, timeout, userPkh, deskPkh: quote.deskBchPkh, maxFee: quote.maxFee };
}

// The user's one signature: their PUSD (or BCH) into the swap contract, change back to them.
export async function lockWithWallet({ manager, account, quote, contract }) {
  const provider = getElectrumProvider("mainnet");
  const utxos = await provider.getUtxos(account.tokenAddress);
  const lockSats = BigInt(quote.lockSats);
  const isPusd = quote.pay === "PUSD";
  const pusdUnits = BigInt(quote.payUnits);

  const tokenInputs = [];
  let tokenIn = 0n;
  if (isPusd) {
    for (const u of utxos.filter((x) => x.token?.category === cfg.pusdCategory && !x.token.nft).sort((a, b) => Number(b.token.amount - a.token.amount))) {
      tokenInputs.push(u);
      tokenIn += u.token.amount;
      if (tokenIn >= pusdUnits) break;
    }
    if (tokenIn < pusdUnits) throw new Error(`Your wallet has ${Number(tokenIn) / 100} PUSD; this swap needs ${Number(pusdUnits) / 100}.`);
  }
  const tokenChange = tokenIn - (isPusd ? pusdUnits : 0n);
  const need = lockSats + (tokenChange > 0n ? 1000n : 0n) + 1500n;
  let satsIn = tokenInputs.reduce((s, u) => s + u.satoshis, 0n);
  const bchInputs = [];
  for (const u of utxos.filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis))) {
    if (satsIn >= need) break;
    bchInputs.push(u);
    satsIn += u.satoshis;
  }
  if (satsIn < need) throw new Error(`Your wallet needs about ${Number(need) / 1e8} BCH for this lock and its fee.`);

  const builder = new TransactionBuilder({ provider });
  const inputs = [...tokenInputs, ...bchInputs];
  builder.addInputs(inputs, placeholderP2PKHUnlocker(account.cashAddress));
  builder.addOutput(
    isPusd
      ? { to: contract.tokenAddress, amount: lockSats, token: { category: cfg.pusdCategory, amount: pusdUnits } }
      : { to: contract.address, amount: lockSats }
  );
  if (tokenChange > 0n) builder.addOutput({ to: account.tokenAddress, amount: 1000n, token: { category: cfg.pusdCategory, amount: tokenChange } });
  builder.addBchChangeOutputIfNeeded({ to: account.cashAddress, feeRate: 1.1 });

  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: isPusd ? `Swap ${Number(pusdUnits) / 100} PUSD for USDC on Base` : `Swap ${Number(quote.payUnits) / 1e8} BCH for USDC on Base`,
  });
  const signed = await manager.signTransaction({ transaction: toRelayRequest(wc), inputPaths: inputs.map((_, i) => [i, "receive", 0]) });
  if (signed.error) throw new Error(signed.error);
  return provider.sendRawTransaction(signed.signedTransaction);
}

// Before the secret leaves this page, check the desk's USDC lock on Base ourselves: right amount, right recipient,
// right hash, not settled, and expiring before the user's own BCH lock.
export async function checkDeskLock({ deskBase, userBase, quote, secretHash, deskTimeout, userTimeout }) {
  const lockId = computeEvmLockId({ token: cfg.evmUsdcAddress, sender: deskBase, recipient: userBase, amount: BigInt(quote.usdcUnits), secretHash, timeout: deskTimeout });
  const st = await fetchEvmLockState({ networkId: "mainnet", swapLockAddress: cfg.defaultSwapLockAddress, lockId });
  if (!st?.exists) return { ok: false, lockId, reason: "The desk's Base lock is not visible yet." };
  if (st.settled) return { ok: false, lockId, reason: "The desk's Base lock is already settled." };
  if (st.recipient.toLowerCase() !== userBase.toLowerCase() || st.amount !== BigInt(quote.usdcUnits)) return { ok: false, lockId, reason: "The desk's Base lock has the wrong terms." };
  if (deskTimeout > userTimeout - 1800) return { ok: false, lockId, reason: "The desk's Base lock lasts too long." };
  return { ok: true, lockId };
}

// After the timeout anyone may broadcast the refund (no signature), so the page can do it without the wallet.
export async function refundWithoutWallet({ terms, toPkh }) {
  const contract = lockContract(terms);
  const [utxo] = await contract.getUtxos();
  if (!utxo) throw new Error("Nothing left in the lock.");
  const builder = new TransactionBuilder({ provider: getElectrumProvider("mainnet") });
  builder.setLocktime(Number(terms.timeout));
  builder.addInput(utxo, contract.unlock.refund());
  const { encodeCashAddress } = await import("@bitauth/libauth");
  const to = encodeCashAddress({ prefix: "bitcoincash", type: utxo.token ? "p2pkhWithTokens" : "p2pkh", payload: hexToBytes(toPkh) });
  builder.addOutput({ to: typeof to === "string" ? to : to.address, amount: utxo.satoshis - 600n, token: utxo.token });
  return builder.send();
}

// --- The reverse direction: USDC on Base in, PUSD or BCH out ---------------------------------------------------

// The user's side on Base: allow SwapLock to move the USDC (only if it cannot already), then lock it for the desk.
export async function lockUsdcForDesk({ account, quote, secretHash, timeout, onApproved }) {
  const amount = BigInt(quote.usdcUnits);
  const allowance = await getEvmPublicClient("mainnet").readContract({
    address: cfg.evmUsdcAddress,
    abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "allowance",
    args: [account, cfg.defaultSwapLockAddress],
  });
  if (allowance < amount) {
    await approveEvmUsdc({ networkId: "mainnet", account, swapLockAddress: cfg.defaultSwapLockAddress, amount });
    onApproved?.();
  }
  return lockEvmSwap({ networkId: "mainnet", account, swapLockAddress: cfg.defaultSwapLockAddress, recipient: quote.deskBase, amount, secretHash, timeout });
}

// The desk's lock on Bitcoin Cash, rebuilt from its terms: it pays the user, refunds the desk.
export function deskBchContract({ userPkh, quote, secretHash, deskTimeout }) {
  return new Contract(
    SwapLockV2Artifact,
    [hexToBytes(userPkh), hexToBytes(quote.deskBchPkh), hexToBytes(normalizeHex32(secretHash)), BigInt(deskTimeout), BigInt(quote.maxFee)],
    { provider: getElectrumProvider("mainnet"), addressType: "p2sh32" }
  );
}

// Before the secret leaves this page: the desk's coins are really at that contract, enough of them, with time left.
export async function checkDeskBchLock({ userPkh, quote, secretHash, deskTimeout }) {
  if (deskTimeout < Date.now() / 1000 + 15 * 60) return { ok: false, reason: "The desk's lock ends too soon." };
  const contract = deskBchContract({ userPkh, quote, secretHash, deskTimeout });
  const [utxo] = await contract.getUtxos();
  if (!utxo) return { ok: false, reason: "The desk's Bitcoin Cash lock is not visible yet." };
  if (utxo.satoshis < BigInt(quote.lockSats)) return { ok: false, reason: "The desk's lock holds too few satoshis." };
  if (quote.receive === "PUSD" && !(utxo.token?.category === cfg.pusdCategory && utxo.token.amount >= BigInt(quote.receiveUnits))) {
    return { ok: false, reason: "The desk's lock holds too little PUSD." };
  }
  return { ok: true, contract, utxo };
}

// The claim needs no signature, so the page can send it itself if the desk does not.
export async function claimDeskBchLock({ contract, utxo, secret, userPkh }) {
  const { encodeCashAddress } = await import("@bitauth/libauth");
  const to = encodeCashAddress({ prefix: "bitcoincash", type: utxo.token ? "p2pkhWithTokens" : "p2pkh", payload: hexToBytes(userPkh) });
  const builder = new TransactionBuilder({ provider: getElectrumProvider("mainnet") });
  builder.addInput(utxo, contract.unlock.claim(hexToBytes(normalizeHex32(secret))));
  builder.addOutput({ to: typeof to === "string" ? to : to.address, amount: utxo.satoshis - 600n, token: utxo.token });
  return builder.send();
}

export const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "");
export const bchTx = (t) => `${cfg.bchExplorerTx}${t}`;
export const baseTx = (t) => `${cfg.evmExplorerTx}${t}`;
export { bytesToHex };
