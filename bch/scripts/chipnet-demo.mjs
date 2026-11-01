// Real SwapLock round trips on chipnet with the test wallet (it plays both sides, so nothing leaves it):
//   node scripts/chipnet-demo.mjs <wallet file> claim    lock 10.00 PUSD-test (+ dust BCH), then claim it with the secret
//   node scripts/chipnet-demo.mjs <wallet file> refund   lock it with a timeout already passed, then refund it
// Add --dry to build and check every transaction without broadcasting. Each step prints its txid; the fee comes from
// the wallet's plain BCH (a few hundred sats per transaction).
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Contract, SignatureTemplate, TransactionBuilder } from "cashscript";
import { cashAddressToLockingBytecode, binToHex } from "@bitauth/libauth";
import { loadWallet, chipnet } from "./wallet.mjs";

const PUSD_TEST = "dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b"; // PUSD on chipnet (ParyonUSD, 29 Oct 2026)
const AMOUNT = 1_000n; // 10.00 PUSD (2 decimals)
const DUST = 1_000n; // sats that ride with a token output
const FEE = 600n; // per transaction, at about 1 sat/byte
const mode = process.argv[3];
const dry = process.argv.includes("--dry");
if (!["claim", "refund"].includes(mode)) { console.error("usage: node scripts/chipnet-demo.mjs <wallet file> claim|refund [--dry]"); process.exit(1); }

const artifact = JSON.parse(readFileSync(new URL("../SwapLock.json", import.meta.url)));
const w = loadWallet();
const provider = chipnet();
const signer = new SignatureTemplate(w.priv);
const height = await provider.getBlockHeight();
const secret = randomBytes(32);
const secretHash = createHash("sha256").update(secret).digest();
// claim: a timeout a day away (it does not matter for claim). refund: one already passed, so the refund is valid at once.
const timeout = BigInt(mode === "claim" ? height + 144 : height - 1);
const contract = new Contract(artifact, [w.pkh, w.pkh, secretHash, timeout], { provider, addressType: "p2sh32" });
console.log(`${mode}: contract ${contract.tokenAddress}, timeout ${timeout} (height ${height})`);

// Every transaction states what goes in and out, and is refused unless the difference (the miner fee) is at most
// FEE: on 1 Nov 2026 the first claim took the wallet's 0.0101 tBCH change as its fee input and paid all of it as fee.
const send = async (tx, label, inSats, outSats) => {
  const fee = inSats - outSats;
  if (fee < 0n || fee > FEE) throw new Error(`${label}: fee would be ${fee} sat (in ${inSats}, out ${outSats}); refused`);
  if (dry) { const hex = tx.build(); console.log(`${label}: built ${hex.length / 2} bytes (dry run, not sent)`); return null; }
  const r = await tx.send();
  console.log(`${label}: ${r.txid}`);
  return r.txid;
};

// 1. Lock: the token UTXO plus enough plain BCH for the dust and fees.
const utxos = await provider.getUtxos(w.address);
const tokenIn = utxos.find((u) => u.token?.category === PUSD_TEST && !u.token.nft && u.token.amount >= AMOUNT);
const bchIn = utxos.filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
if (!tokenIn) throw new Error("no PUSD-test UTXO with at least 10.00");
const inputs = [tokenIn, ...bchIn];
const total = inputs.reduce((s, u) => s + u.satoshis, 0n);
const need = DUST * 2n + FEE * 2n; // lock output + token change, and this fee plus the next one
if (total < need + 546n) throw new Error(`not enough BCH: ${total} sat in the wallet, need about ${need + 546n}; get chipnet tBCH from a faucet for ${w.address}`);
const lock = new TransactionBuilder({ provider });
for (const u of inputs) lock.addInput(u, signer.unlockP2PKH());
lock.addOutput({ to: contract.tokenAddress, amount: DUST, token: { category: PUSD_TEST, amount: AMOUNT } });
if (tokenIn.token.amount > AMOUNT) lock.addOutput({ to: w.tokenAddress, amount: DUST, token: { category: PUSD_TEST, amount: tokenIn.token.amount - AMOUNT } });
const tokenChange = tokenIn.token.amount > AMOUNT ? DUST : 0n;
lock.addOutput({ to: w.address, amount: total - DUST - tokenChange - FEE });
const lockTx = await send(lock, "lock", total, total - FEE);

// 2. Claim with the secret, or refund after the timeout. The locked UTXO is read back from the chain (or, in a dry
// run, described from the lock above).
const locked = lockTx
  ? (await contract.getUtxos())[0]
  : { txid: "00".repeat(32), vout: 0, satoshis: DUST, token: { category: PUSD_TEST, amount: AMOUNT }, lockingBytecode: contract.lockingBytecode };
const walletLock = binToHex(cashAddressToLockingBytecode(w.address).bytecode);
// The fee comes from the lock's BCH change; whatever it holds beyond the fee goes back to the wallet.
const feeIn = lockTx
  ? (await provider.getUtxos(w.address)).find((u) => !u.token && u.txid === lockTx)
  : { txid: "11".repeat(32), vout: 2, satoshis: total - DUST - tokenChange - FEE, lockingBytecode: walletLock };
if (!feeIn || feeIn.satoshis < FEE + 546n) throw new Error("the lock's BCH change is missing or too small to pay the fee");
const spend = new TransactionBuilder({ provider });
spend.addInput(locked, mode === "claim" ? contract.unlock.claim(w.pub, signer, secret) : contract.unlock.refund(w.pub, signer));
spend.addInput(feeIn, signer.unlockP2PKH());
spend.addOutput({ to: w.tokenAddress, amount: locked.satoshis, token: { category: PUSD_TEST, amount: AMOUNT } });
spend.addOutput({ to: w.address, amount: feeIn.satoshis - FEE });
if (mode === "refund") spend.setLocktime(Number(timeout));
await send(spend, mode, locked.satoshis + feeIn.satoshis, locked.satoshis + feeIn.satoshis - FEE);
if (!dry) console.log(`secret (claim only, public once claimed): ${mode === "claim" ? secret.toString("hex") : "-"}`);
process.exit(0);
