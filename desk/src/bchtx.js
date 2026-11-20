// The few Bitcoin Cash pieces the desk needs, without a WebAssembly crypto library (Cloudflare Workers cannot compile
// WebAssembly at run time). The desk never signs on BCH: SwapLockV2's claim and refund take no signature, so all it
// does is rebuild the contract from its terms, read its UTXO and broadcast a one-input, one-output spend.
// test/bchtx.test.js checks every function here byte for byte against CashScript and libauth.

// SwapLockV2.cash compiled by cashc 0.14 (asmToBytecode of the artifact). Constructor arguments are pushed before it.
export const SWAPLOCK_V2_BYTECODE =
  "5579009c635679827701209d567aa8537a88c3519dc4519d00cd0376a9147b7e0288ac7e8800d100ce8800d300d09d00d200cf8800cc00c6547a94a277777767557a519d537ab175c3519dc4519d00cd0376a914537a7e0288ac7e8800d100ce8800d300d09d00d200cf8800cc00c6547a94a2777768";

export const hexToBin = (hex) => {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error("bad hex");
  return Uint8Array.from(clean.match(/../g) || [], (b) => parseInt(b, 16));
};
export const binToHex = (bin) => Array.from(bin, (b) => b.toString(16).padStart(2, "0")).join("");
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const reverse = (bin) => Uint8Array.from(bin).reverse();

export async function sha256(bin) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bin));
}
export async function hash256(bin) {
  return sha256(await sha256(bin));
}

// Minimal script number (little-endian, sign bit in the top byte), as the VM and CashScript encode integers.
export function vmNumber(value) {
  let n = BigInt(value);
  if (n === 0n) return new Uint8Array(0);
  const negative = n < 0n;
  if (negative) n = -n;
  const bytes = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(negative ? 0x80 : 0);
  else if (negative) bytes[bytes.length - 1] |= 0x80;
  return Uint8Array.from(bytes);
}

// The minimal push for a piece of data (OP_0, OP_1..OP_16, OP_1NEGATE, direct push, PUSHDATA1/2).
export function pushData(data) {
  const len = data.length;
  if (len === 0) return Uint8Array.of(0x00);
  if (len === 1 && data[0] >= 1 && data[0] <= 16) return Uint8Array.of(0x50 + data[0]);
  if (len === 1 && data[0] === 0x81) return Uint8Array.of(0x4f);
  if (len <= 75) return concat(Uint8Array.of(len), data);
  if (len <= 255) return concat(Uint8Array.of(0x4c, len), data);
  if (len <= 65535) return concat(Uint8Array.of(0x4d, len & 0xff, len >> 8), data);
  throw new Error("push too large");
}

export function compactSize(n) {
  const v = BigInt(n);
  if (v < 0xfdn) return Uint8Array.of(Number(v));
  if (v <= 0xffffn) return Uint8Array.of(0xfd, Number(v & 0xffn), Number(v >> 8n));
  if (v <= 0xffffffffn) return concat(Uint8Array.of(0xfe), le(v, 4));
  return concat(Uint8Array.of(0xff), le(v, 8));
}
export function le(value, bytes) {
  let v = BigInt(value);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// The redeem script of one SwapLockV2: constructor arguments in reverse order, then the contract.
export function swapLockV2Redeem({ recipientPkh, refundPkh, secretHash, timeout, maxFee }) {
  return concat(
    pushData(vmNumber(maxFee)),
    pushData(vmNumber(timeout)),
    pushData(hexToBin(secretHash)),
    pushData(hexToBin(refundPkh)),
    pushData(hexToBin(recipientPkh)),
    hexToBin(SWAPLOCK_V2_BYTECODE)
  );
}

export async function p2sh32LockingBytecode(redeem) {
  return concat(Uint8Array.of(0xaa, 0x20), await hash256(redeem), Uint8Array.of(0x87));
}
export function p2pkhLockingBytecode(pkhHex) {
  return concat(Uint8Array.of(0x76, 0xa9, 0x14), hexToBin(pkhHex), Uint8Array.of(0x88, 0xac));
}

// Electrum indexes scripts by sha256 of the locking bytecode, byte-reversed.
export async function electrumScripthash(lockingBytecode) {
  return binToHex(reverse(await sha256(lockingBytecode)));
}

// Unlocking bytecode: arguments, then the function index (claim 0, refund 1), then the redeem script.
export function claimUnlocking(secretHex, redeem) {
  return concat(pushData(hexToBin(secretHex)), pushData(vmNumber(0)), pushData(redeem));
}
export function refundUnlocking(redeem) {
  return concat(pushData(vmNumber(1)), pushData(redeem));
}

// CashTokens prefix for a fungible-only output (PUSD). NFTs are refused: the desk only handles fungible tokens.
export function tokenPrefix(token) {
  if (!token) return new Uint8Array(0);
  if (token.nft) throw new Error("NFT outputs are not handled");
  const amount = BigInt(token.amount);
  if (amount <= 0n) throw new Error("token amount must be positive");
  return concat(Uint8Array.of(0xef), reverse(hexToBin(token.category)), Uint8Array.of(0x10), compactSize(amount));
}

// One output as it appears in a transaction (and in the hashOutputs of a signing serialization).
export function encodeOutput(o) {
  const script = concat(tokenPrefix(o.token), o.lockingBytecode);
  return concat(le(o.value, 8), compactSize(script.length), script);
}

export function encodeTransaction({ version = 2, inputs, outputs, locktime = 0 }) {
  const parts = [le(version, 4), compactSize(inputs.length)];
  for (const i of inputs) {
    parts.push(reverse(hexToBin(i.txid)), le(i.vout, 4), compactSize(i.unlocking.length), i.unlocking, le(i.sequence ?? 0xfffffffe, 4));
  }
  parts.push(compactSize(outputs.length));
  for (const o of outputs) parts.push(encodeOutput(o));
  parts.push(le(locktime, 4));
  return concat(...parts);
}

export async function txid(rawTx) {
  return binToHex(reverse(await hash256(rawTx)));
}

// The single spend both paths make: the locked UTXO into one output that keeps the token and pays `fee` to miners.
// The contract allows at most `maxFee`; 600 sat is about 2 sat/byte for this ~300-byte transaction.
export function spendLockTx({ utxo, unlocking, toPkh, fee = 600n, locktime = 0 }) {
  const value = BigInt(utxo.value) - BigInt(fee);
  if (value < 800n) throw new Error("locked value too small to pay the fee");
  return encodeTransaction({
    inputs: [{ txid: utxo.txid, vout: utxo.vout, unlocking, sequence: 0xfffffffe }],
    outputs: [{ value, lockingBytecode: p2pkhLockingBytecode(toPkh), token: utxo.token }],
    locktime,
  });
}

function readCompact(bin, o) {
  const b = bin[o];
  if (b < 0xfd) return [BigInt(b), o + 1];
  const n = b === 0xfd ? 2 : b === 0xfe ? 4 : 8;
  let v = 0n;
  for (let i = n - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(bin[o + 1 + i]);
  return [v, o + 1 + n];
}

// The inputs of a raw transaction: { txid, vout, unlocking } each (enough to see how a lock was spent).
export function decodeInputs(raw) {
  let o = 4;
  let n;
  [n, o] = readCompact(raw, o);
  const inputs = [];
  for (let i = 0n; i < n; i += 1n) {
    const txid = binToHex(reverse(raw.slice(o, o + 32)));
    const vout = raw[o + 32] | (raw[o + 33] << 8) | (raw[o + 34] << 16) | (raw[o + 35] * 2 ** 24);
    let len;
    [len, o] = readCompact(raw, o + 36);
    const unlocking = raw.slice(o, o + Number(len));
    o += Number(len) + 4;
    inputs.push({ txid, vout, unlocking });
  }
  return inputs;
}

// How a SwapLockV2 was spent, from the spending input's unlocking bytecode: a claim starts with the 32-byte secret,
// a refund with OP_1. Returns { kind: "claim", secret } or { kind: "refund" }.
export async function spendKind(unlocking, secretHash) {
  if (unlocking[0] === 0x20) {
    const secret = unlocking.slice(1, 33);
    if (binToHex(await sha256(secret)) === secretHash.replace(/^0x/, "").toLowerCase()) return { kind: "claim", secret: binToHex(secret) };
  }
  if (unlocking[0] === 0x51) return { kind: "refund" };
  return { kind: "unknown" };
}
