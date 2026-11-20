// The desk's own BCH signatures, for the reverse direction (USDC on Base in, PUSD or BCH out): there the desk is the
// taker that funds a SwapLockV2 from its own P2PKH coins, so it has to sign. Pure JavaScript (noble), because
// Cloudflare Workers cannot compile WebAssembly at run time. ECDSA with RFC 6979 nonces, so a signature is
// deterministic and test/bchsign.test.js can compare whole transactions byte for byte with CashScript.
//
// Signing serialization: BIP143 style with SIGHASH_ALL | SIGHASH_FORKID (0x41) and the CashTokens rule that a spent
// output's token prefix goes right before its covered bytecode.
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { base58 } from "@scure/base";
import { compactSize, concat, encodeOutput, hexToBin, le, p2pkhLockingBytecode, pushData, tokenPrefix } from "./bchtx.js";

const SIGHASH_ALL_FORKID = 0x41;
const sha256 = (b) => nobleSha256(b);
const hash256 = (b) => sha256(sha256(b));
const reverse = (bin) => Uint8Array.from(bin).reverse();

// WIF (mainnet 0x80 or testnet 0xef, compressed) → 32-byte private key.
export function wifToKey(wif) {
  const raw = base58.decode(wif.trim());
  const body = raw.slice(0, -4);
  const check = hash256(body).slice(0, 4);
  if (raw.slice(-4).some((b, i) => b !== check[i])) throw new Error("bad WIF checksum");
  if (body[0] !== 0x80 && body[0] !== 0xef) throw new Error("not a WIF key");
  if (body.length !== 34 || body[33] !== 0x01) throw new Error("only compressed WIF keys are supported");
  return body.slice(1, 33);
}

export function keyInfo(wif) {
  const priv = wifToKey(wif);
  const pub = secp256k1.getPublicKey(priv, true);
  return { priv, pub, pkh: ripemd160(sha256(pub)) };
}

// The digest an input signs. tx: { version, inputs: [{ txid, vout, sequence }], outputs: [...], locktime },
// spent: [{ value, lockingBytecode, token }] for every input (same order).
export function sighash(tx, spent, index) {
  const version = tx.version ?? 2;
  const prevouts = concat(...tx.inputs.map((i) => concat(reverse(hexToBin(i.txid)), le(i.vout, 4))));
  const sequences = concat(...tx.inputs.map((i) => le(i.sequence ?? 0xfffffffe, 4)));
  const outputs = concat(...tx.outputs.map(encodeOutput));
  const input = tx.inputs[index];
  const coin = spent[index];
  const preimage = concat(
    le(version, 4),
    hash256(prevouts),
    hash256(sequences),
    reverse(hexToBin(input.txid)),
    le(input.vout, 4),
    tokenPrefix(coin.token),
    compactSize(coin.lockingBytecode.length),
    coin.lockingBytecode,
    le(coin.value, 8),
    le(input.sequence ?? 0xfffffffe, 4),
    hash256(outputs),
    le(tx.locktime ?? 0, 4),
    le(SIGHASH_ALL_FORKID, 4)
  );
  return hash256(preimage);
}

// Signs every input as a P2PKH spend by this key and returns the transaction with unlocking bytecode filled in.
export function signP2pkhInputs(tx, spent, { priv, pub }) {
  const inputs = tx.inputs.map((input, index) => {
    const digest = sighash(tx, spent, index);
    const der = secp256k1.sign(digest, priv, { lowS: true }).toDERRawBytes();
    const sig = concat(der, Uint8Array.of(SIGHASH_ALL_FORKID));
    return { ...input, unlocking: concat(pushData(sig), pushData(pub)) };
  });
  return { ...tx, inputs };
}

// The desk's lock for a reverse swap: its coins into one SwapLockV2 output (PUSD + a little BCH, or plain BCH),
// change back to the desk. coins: the desk's UTXOs as { txid, vout, value, token }. Picks what it needs and returns
// { tx, spent } ready for signP2pkhInputs, or throws when the desk is short.
export function buildDeskLock({ coins, deskPkh, lockBytecode, lockValue, pusdCategory, pusdUnits, feePerByte = 1n }) {
  const deskScript = p2pkhLockingBytecode(deskPkh);
  const picked = [];
  let tokenIn = 0n;
  if (pusdUnits > 0n) {
    const tokenCoins = coins
      .filter((c) => c.token && c.token.category === pusdCategory && !c.token.nft)
      .sort((a, b) => (BigInt(b.token.amount) > BigInt(a.token.amount) ? 1 : -1));
    for (const c of tokenCoins) {
      if (tokenIn >= pusdUnits) break;
      picked.push(c);
      tokenIn += BigInt(c.token.amount);
    }
    if (tokenIn < pusdUnits) throw new Error("The desk is out of PUSD right now.");
  }
  const tokenChange = tokenIn - pusdUnits;
  const plain = coins.filter((c) => !c.token).sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));

  const build = (change) => {
    const outputs = [
      { value: BigInt(lockValue), lockingBytecode: lockBytecode, token: pusdUnits > 0n ? { category: pusdCategory, amount: pusdUnits } : undefined },
    ];
    if (tokenChange > 0n) outputs.push({ value: 1000n, lockingBytecode: deskScript, token: { category: pusdCategory, amount: tokenChange } });
    if (change >= 546n) outputs.push({ value: change, lockingBytecode: deskScript });
    return {
      tx: { version: 2, inputs: picked.map((c) => ({ txid: c.txid, vout: c.vout, sequence: 0xfffffffe })), outputs, locktime: 0 },
      spent: picked.map((c) => ({ value: BigInt(c.value), lockingBytecode: deskScript, token: c.token })),
    };
  };
  // ~150 bytes per signed P2PKH input, ~60 per output (token outputs a bit more), 10 bytes overhead
  const estimate = (nIn, nOut) => BigInt(10 + nIn * 150 + nOut * 75) * feePerByte;
  const outNeed = BigInt(lockValue) + (tokenChange > 0n ? 1000n : 0n);
  let satsIn = picked.reduce((s, c) => s + BigInt(c.value), 0n);
  for (const c of plain) {
    if (satsIn >= outNeed + estimate(picked.length, 3)) break;
    picked.push(c);
    satsIn += BigInt(c.value);
  }
  const fee = estimate(picked.length, 3);
  if (satsIn < outNeed + fee) throw new Error("The desk is out of BCH right now.");
  return build(satsIn - outNeed - fee);
}
