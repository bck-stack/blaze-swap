// A full cross-chain atomic swap on mainnet: PUSD (or plain BCH) on Bitcoin Cash against USDC on Base, under one
// sha256 hash. One operator runs both wallets, so no value leaves them; what it proves is that the two contracts the app
// uses settle on mainnet in the order the app drives them:
//   1. maker locks USDC on Base (long timeout)        4. the script reads the secret back from the BCH claim
//   2. taker locks PUSD on BCH (short timeout)         5. taker claims the USDC on Base with that secret
//   3. maker claims the PUSD on BCH, revealing the secret
//
//   node scripts/mainnet-swap.mjs --bch-wallet <file> --evm-key <file> [--asset pusd|bch] [--dry]
//
// The BCH wallet file holds CHIPNET_WIF (the same key works on mainnet; only the address prefix changes). The EVM key
// file holds one hex private key. Neither is printed. --dry builds and checks every step without broadcasting.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Contract, ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from "cashscript";
import {
  cashAddressToLockingBytecode,
  decodePrivateKeyWif,
  decodeTransactionUnsafe,
  encodeCashAddress,
  hash160,
  hexToBin,
  binToHex,
  secp256k1,
} from "@bitauth/libauth";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, [])
);
const dry = args.dry === true;
const asset = args.asset || "pusd";
if (!args["bch-wallet"] || !args["evm-key"]) {
  console.error("usage: node scripts/mainnet-swap.mjs --bch-wallet <file> --evm-key <file> [--asset pusd|bch] [--dry]");
  process.exit(1);
}

const PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SWAP_LOCK = "0xf66642c35cf4a36fcd7d3bcf87422791280f8901";
const USDC_AMOUNT = 50_000n; // 0.05 USDC
const PUSD_AMOUNT = 5n; // 0.05 PUSD (2 decimals)
const BCH_AMOUNT = 5_000n; // when --asset bch
const DUST = 1_000n;
const FEE = 600n;

// --- keys -----------------------------------------------------------------------------------------------------------
const envFile = Object.fromEntries(
  readFileSync(args["bch-wallet"], "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);
const wif = decodePrivateKeyWif(envFile.CHIPNET_WIF || envFile.BCH_WIF);
if (typeof wif === "string") throw new Error(`bad WIF: ${wif}`);
const bchPub = secp256k1.derivePublicKeyCompressed(wif.privateKey);
const bchPkh = hash160(bchPub);
const bchAddr = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload: bchPkh }).address;
const bchTokenAddr = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkhWithTokens", payload: bchPkh }).address;
const signer = new SignatureTemplate(wif.privateKey);

let evmKey = readFileSync(args["evm-key"], "utf8").trim();
const m = evmKey.match(/(?:^|=)\s*(0x)?([0-9a-fA-F]{64})\s*$/m);
if (!m) throw new Error("no hex private key in the EVM key file");
evmKey = `0x${m[2]}`;
const account = privateKeyToAccount(evmKey);

const provider = new ElectrumNetworkProvider("mainnet");
const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const wallet = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];
const LOCK_ABI = [
  { type: "function", name: "lock", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [] },
  { type: "function", name: "locks", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }, { type: "bool" }] },
];
const CLAIMED = parseAbiItem("event Claimed(bytes32 indexed id, bytes32 secret)");

const log = (step, msg) => console.log(`${step.padEnd(14)} ${msg}`);
const proof = [];

// --- preflight ------------------------------------------------------------------------------------------------------
const nowSec = Math.floor(Date.now() / 1000);
const makerTimeout = BigInt(nowSec + 2 * 3600); // Base, maker's lock
const takerTimeout = BigInt(nowSec + 3600); // BCH, taker's lock (unix time, checked against tx.time)
const secret = randomBytes(32);
const secretHash = createHash("sha256").update(secret).digest();
const secretHashHex = `0x${secretHash.toString("hex")}`;

const usdcBal = await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [account.address] });
const ethBal = await pub.getBalance({ address: account.address });
const utxos = await provider.getUtxos(bchAddr);
const tokenUtxos = await provider.getUtxos(bchTokenAddr);
const all = [...new Map([...utxos, ...tokenUtxos].map((u) => [`${u.txid}:${u.vout}`, u])).values()];
const plain = all.filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
const pusdIn = all.find((u) => u.token?.category === PUSD && !u.token.nft && u.token.amount >= PUSD_AMOUNT);
const bchSats = plain.reduce((s, u) => s + u.satoshis, 0n);
log("wallets", `BCH ${bchAddr} ${bchSats} sat${pusdIn ? `, PUSD ${pusdIn.token.amount}` : ", no PUSD"} | Base ${account.address} ${Number(usdcBal) / 1e6} USDC, ${Number(ethBal) / 1e18} ETH`);
if (usdcBal < USDC_AMOUNT) throw new Error("not enough USDC on Base");
if (asset === "pusd" && !pusdIn) throw new Error(`no PUSD UTXO with at least ${PUSD_AMOUNT} units at ${bchTokenAddr}`);
const needSats = (asset === "pusd" ? DUST * 2n : BCH_AMOUNT) + FEE * 2n + 546n;
if (bchSats < needSats) throw new Error(`not enough BCH: ${bchSats} sat, need about ${needSats}`);

// --- 1. maker locks USDC on Base --------------------------------------------------------------------------------------
const lockId = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }],
    [USDC, account.address, account.address, USDC_AMOUNT, secretHashHex, makerTimeout]
  )
);
log("hash", `${secretHashHex} (Base lock id ${lockId})`);
const sendEvm = async (label, req) => {
  if (dry) {
    await pub.simulateContract({ ...req, account });
    log(label, "simulated ok (dry run)");
    return null;
  }
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  log(label, `https://basescan.org/tx/${hash}`);
  proof.push([label, "base", hash]);
  return hash;
};
const allowance = await pub.readContract({ address: USDC, abi: ERC20, functionName: "allowance", args: [account.address, SWAP_LOCK] });
if (allowance < USDC_AMOUNT) {
  await sendEvm("base approve", { address: USDC, abi: ERC20, functionName: "approve", args: [SWAP_LOCK, USDC_AMOUNT] });
}
if (!dry || allowance >= USDC_AMOUNT) {
  await sendEvm("base lock", { address: SWAP_LOCK, abi: LOCK_ABI, functionName: "lock", args: [USDC, account.address, USDC_AMOUNT, secretHashHex, makerTimeout] });
} else {
  log("base lock", "skipped in dry run (needs the approve first)");
}

// --- 2. taker checks the Base lock, then locks on BCH -------------------------------------------------------------------
if (!dry) {
  const l = await pub.readContract({ address: SWAP_LOCK, abi: LOCK_ABI, functionName: "locks", args: [lockId] });
  if (l[3] !== USDC_AMOUNT || l[4] !== secretHashHex || l[6]) throw new Error("Base lock does not match the terms");
  log("check", "Base lock is on chain with the agreed amount, hash and timeout");
}
const artifact = JSON.parse(readFileSync(new URL("../src/contracts/SwapLock.json", import.meta.url)));
const contract = new Contract(artifact, [bchPkh, bchPkh, secretHash, takerTimeout], { provider, addressType: "p2sh32" });
log("bch contract", contract.tokenAddress);

const sendBch = async (label, tx, inSats, outSats) => {
  const fee = inSats - outSats;
  if (fee < 0n || fee > FEE) throw new Error(`${label}: fee would be ${fee} sat; refused`);
  if (dry) {
    log(label, `built ${tx.build().length / 2} bytes (dry run, not sent)`);
    return null;
  }
  const r = await tx.send();
  log(label, `https://blockchair.com/bitcoin-cash/transaction/${r.txid}`);
  proof.push([label, "bch", r.txid]);
  return r.txid;
};

const lockAmount = asset === "pusd" ? DUST : BCH_AMOUNT;
const inputs = asset === "pusd" ? [pusdIn] : [];
for (const u of plain) {
  if (inputs.reduce((s, x) => s + x.satoshis, 0n) >= needSats) break;
  inputs.push(u);
}
const total = inputs.reduce((s, u) => s + u.satoshis, 0n);
const lockTx = new TransactionBuilder({ provider });
for (const u of inputs) lockTx.addInput(u, signer.unlockP2PKH());
lockTx.addOutput(
  asset === "pusd"
    ? { to: contract.tokenAddress, amount: DUST, token: { category: PUSD, amount: PUSD_AMOUNT } }
    : { to: contract.address, amount: BCH_AMOUNT }
);
let tokenChange = 0n;
if (asset === "pusd" && pusdIn.token.amount > PUSD_AMOUNT) {
  tokenChange = DUST;
  lockTx.addOutput({ to: bchTokenAddr, amount: DUST, token: { category: PUSD, amount: pusdIn.token.amount - PUSD_AMOUNT } });
}
const lockChange = total - lockAmount - tokenChange - FEE;
lockTx.addOutput({ to: bchAddr, amount: lockChange });
const bchLockTxid = await sendBch("bch lock", lockTx, total, total - FEE);

// --- 3. maker claims on BCH, revealing the secret --------------------------------------------------------------------
const locked = bchLockTxid
  ? (await contract.getUtxos())[0]
  : { txid: "00".repeat(32), vout: 0, satoshis: lockAmount, token: asset === "pusd" ? { category: PUSD, amount: PUSD_AMOUNT } : undefined, lockingBytecode: contract.lockingBytecode };
const feeIn = bchLockTxid
  ? (await provider.getUtxos(bchAddr)).find((u) => u.txid === bchLockTxid && !u.token)
  : { txid: "11".repeat(32), vout: inputs.length, satoshis: lockChange };
const claimTx = new TransactionBuilder({ provider });
claimTx.addInput(locked, contract.unlock.claim(bchPub, signer, secret));
claimTx.addInput(feeIn, signer.unlockP2PKH());
claimTx.addOutput(
  asset === "pusd"
    ? { to: bchTokenAddr, amount: DUST, token: { category: PUSD, amount: PUSD_AMOUNT } }
    : { to: bchAddr, amount: BCH_AMOUNT }
);
claimTx.addOutput({ to: bchAddr, amount: feeIn.satoshis - FEE });
const claimTxid = await sendBch("bch claim", claimTx, locked.satoshis + feeIn.satoshis, locked.satoshis + feeIn.satoshis - FEE);

// --- 4. read the secret back from the BCH chain, the way the taker's page does --------------------------------------
let revealed = secret;
if (claimTxid) {
  const raw = await provider.getRawTransaction(claimTxid);
  const tx = decodeTransactionUnsafe(hexToBin(raw));
  const bytecode = tx.inputs[0].unlockingBytecode;
  revealed = null;
  for (let i = 0; i + 33 <= bytecode.length; i += 1) {
    if (bytecode[i] === 0x20) {
      const cand = bytecode.slice(i + 1, i + 33);
      if (createHash("sha256").update(cand).digest().equals(secretHash)) { revealed = Buffer.from(cand); break; }
    }
  }
  if (!revealed) throw new Error("secret not found in the BCH claim");
  log("watch", `secret read from BCH claim input: sha256 matches (${binToHex(revealed).slice(0, 8)}…)`);
}

// --- 5. taker claims the USDC on Base with it ----------------------------------------------------------------------
if (!dry) {
  await sendEvm("base claim", { address: SWAP_LOCK, abi: LOCK_ABI, functionName: "claim", args: [lockId, `0x${Buffer.from(revealed).toString("hex")}`] });
  const logs = await pub.getLogs({ address: SWAP_LOCK, event: CLAIMED, args: { id: lockId }, fromBlock: (await pub.getBlockNumber()) - 50n });
  log("done", `Base Claimed event carries the same secret: ${logs.at(-1)?.args.secret === `0x${Buffer.from(revealed).toString("hex")}`}`);
  console.log("\nPROOF " + JSON.stringify({ secretHash: secretHashHex, lockId, bchContract: contract.tokenAddress, txs: proof }));
} else {
  log("base claim", "skipped in dry run");
}
process.exit(0);
