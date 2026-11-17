import {
  cashAddressToLockingBytecode,
  decodeTransactionUnsafe,
} from "@bitauth/libauth";
import {
  Contract,
  ElectrumNetworkProvider,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  placeholderPublicKey,
  placeholderSignature,
} from "cashscript";
import SwapLockArtifact from "../contracts/SwapLock.json";
import {
  NETWORK_CONFIG,
  bytesToHex,
  hexToBytes,
  normalizeHex32,
  sha256Hex,
} from "./swapProtocol.js";

const providerCache = new Map();

export function getElectrumProvider(networkId = "mainnet") {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  if (!providerCache.has(cfg.id)) {
    providerCache.set(
      cfg.id,
      new ElectrumNetworkProvider(cfg.bchNetwork, {
        hostname: cfg.electrumHost,
      })
    );
  }
  return providerCache.get(cfg.id);
}

export function deriveSwapLockContract({
  networkId = "mainnet",
  recipientPkh,
  refundPkh,
  secretHash,
  timeout,
}) {
  const provider = getElectrumProvider(networkId);
  const contract = new Contract(
    SwapLockArtifact,
    [
      hexToBytes(recipientPkh),
      hexToBytes(refundPkh),
      hexToBytes(normalizeHex32(secretHash)),
      BigInt(timeout),
    ],
    { provider, addressType: "p2sh32" }
  );
  return {
    contract,
    address: contract.address,
    tokenAddress: contract.tokenAddress,
  };
}

export async function fetchAddressBalances(address, networkId = "mainnet") {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  const provider = getElectrumProvider(networkId);
  const utxos = await provider.getUtxos(address);
  let bchSatoshis = 0n;
  let pusdAmount = 0n;
  for (const u of utxos) {
    bchSatoshis += u.satoshis;
    if (u.token?.category === cfg.pusdCategory) {
      pusdAmount += u.token.amount;
    }
  }
  return {
    bchSatoshis,
    pusdAmount,
    utxoCount: utxos.length,
    utxos,
  };
}

export async function fetchContractLockState({
  networkId = "mainnet",
  recipientPkh,
  refundPkh,
  secretHash,
  timeout,
}) {
  const { contract, address, tokenAddress } = deriveSwapLockContract({
    networkId,
    recipientPkh,
    refundPkh,
    secretHash,
    timeout,
  });
  const balances = await fetchAddressBalances(tokenAddress, networkId);
  const history = await fetchScriptHistory(address, networkId);
  return {
    address,
    tokenAddress,
    contract,
    ...balances,
    funded: balances.utxoCount > 0,
    // Seen on chain but nothing left: the lock was claimed or refunded.
    spent: balances.utxoCount === 0 && history.length > 0,
    history,
  };
}

async function contractScriptHash(contractAddress) {
  const decoded = cashAddressToLockingBytecode(contractAddress);
  if (typeof decoded === "string") return null;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", decoded.bytecode);
  return bytesToHex(new Uint8Array(digest).reverse());
}

export async function fetchScriptHistory(contractAddress, networkId = "mainnet") {
  const scriptHash = await contractScriptHash(contractAddress);
  if (!scriptHash) return [];
  const provider = getElectrumProvider(networkId);
  const history = await provider.performRequest("blockchain.scripthash.get_history", scriptHash);
  return Array.isArray(history) ? history : [];
}

export async function fundBchSwapLockWithWallet({
  networkId = "mainnet",
  manager,
  senderAddress,
  senderTokenAddress,
  contractTokenAddress,
  pusdAmount,
  contractSatoshis = 2000n,
}) {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  const provider = getElectrumProvider(networkId);
  const senderPubkey = manager.getPubkey(0, 0n);
  if (!senderPubkey) {
    throw new Error("WizardConnect wallet public key is unavailable.");
  }

  const utxos = await provider.getUtxos(senderTokenAddress || senderAddress);
  const tokenUtxos = utxos.filter(
    (u) =>
      u.token?.category === cfg.pusdCategory &&
      !u.token.nft &&
      u.token.amount > 0n
  );
  const bchUtxos = utxos
    .filter((u) => !u.token && u.satoshis >= 1000n)
    .sort((a, b) => Number(b.satoshis - a.satoshis));

  let collectedPusd = 0n;
  const selectedTokenUtxos = [];
  for (const u of tokenUtxos) {
    selectedTokenUtxos.push(u);
    collectedPusd += u.token.amount;
    if (collectedPusd >= pusdAmount) break;
  }
  if (collectedPusd < pusdAmount) {
    throw new Error(
      `Insufficient ${cfg.pusdSymbol} balance in connected BCH wallet.`
    );
  }

  let collectedBch = selectedTokenUtxos.reduce((acc, u) => acc + u.satoshis, 0n);
  const selectedBchUtxos = [];
  const hasTokenChange = collectedPusd > pusdAmount;
  const minNeeded =
    contractSatoshis + (hasTokenChange ? 1000n : 0n) + 1200n;
  for (const u of bchUtxos) {
    if (collectedBch >= minNeeded) break;
    selectedBchUtxos.push(u);
    collectedBch += u.satoshis;
  }
  if (collectedBch < minNeeded) {
    throw new Error("Insufficient BCH for dust + miner fee.");
  }

  const unlocker = placeholderP2PKHUnlocker(senderAddress);
  const builder = new TransactionBuilder({ provider });
  const allInputs = [...selectedTokenUtxos, ...selectedBchUtxos];
  builder.addInputs(allInputs, unlocker);

  builder.addOutput({
    to: contractTokenAddress,
    amount: contractSatoshis,
    token: {
      category: cfg.pusdCategory,
      amount: pusdAmount,
    },
  });

  builder.addTokenChangeOutputIfNeeded({
    category: cfg.pusdCategory,
    to: senderTokenAddress || senderAddress,
  });
  builder.addBchChangeOutputIfNeeded({
    to: senderAddress,
    feeRate: 1.1,
  });

  const wcTransaction = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: `Lock ${cfg.pusdSymbol} into Atomic Swap`,
  });
  const inputPaths = allInputs.map((_, idx) => [idx, "receive", 0]);
  const signed = await manager.signTransaction({
    transaction: wcTransaction,
    inputPaths,
  });
  if (signed.error) {
    throw new Error(signed.error);
  }
  const txid = await provider.sendRawTransaction(signed.signedTransaction);
  return { txid };
}

function selectLockedUtxo(utxos, pusdCategory) {
  return (
    utxos.find((u) => u.token?.category === pusdCategory && u.token.amount > 0n) ||
    utxos[0]
  );
}

export async function claimBchSwapLock({
  networkId = "mainnet",
  manager,
  recipientPkh,
  refundPkh,
  secretHash,
  timeout,
  secretHex,
  recipientTokenAddress,
}) {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  const provider = getElectrumProvider(networkId);
  const pubkey = manager.getPubkey(0, 0n);
  if (!pubkey) {
    throw new Error("Connect WizardConnect BCH wallet first.");
  }

  const { contract, utxos } = await fetchContractLockState({
    networkId,
    recipientPkh,
    refundPkh,
    secretHash,
    timeout,
  });
  if (utxos.length === 0) {
    throw new Error("No locked UTXOs found in BCH SwapLock contract.");
  }

  const locked = selectLockedUtxo(utxos, cfg.pusdCategory);
  const fee = 700n;
  if (locked.satoshis < fee + 546n) {
    throw new Error(
      "Contract UTXO needs at least 1,246 sats to cover dust + claim fee."
    );
  }

  const builder = new TransactionBuilder({ provider });
  builder.addInput(
    locked,
    contract.unlock.claim(
      placeholderPublicKey(),
      placeholderSignature(),
      hexToBytes(normalizeHex32(secretHex))
    )
  );
  builder.addOutput({
    to: recipientTokenAddress,
    amount: locked.satoshis - fee,
    token: locked.token
      ? { category: cfg.pusdCategory, amount: locked.token.amount }
      : undefined,
  });

  const wcTransaction = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: `Claim ${cfg.pusdSymbol} from Atomic Swap`,
  });
  const signed = await manager.signTransaction({
    transaction: wcTransaction,
    inputPaths: [[0, "receive", 0]],
  });
  if (signed.error) {
    throw new Error(signed.error);
  }
  const txid = await provider.sendRawTransaction(signed.signedTransaction);
  return { txid };
}

export async function refundBchSwapLock({
  networkId = "mainnet",
  manager,
  recipientPkh,
  refundPkh,
  secretHash,
  timeout,
  refundTokenAddress,
}) {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  const provider = getElectrumProvider(networkId);
  const pubkey = manager.getPubkey(0, 0n);
  if (!pubkey) {
    throw new Error("Connect WizardConnect BCH wallet first.");
  }

  const { contract, utxos } = await fetchContractLockState({
    networkId,
    recipientPkh,
    refundPkh,
    secretHash,
    timeout,
  });
  if (utxos.length === 0) {
    throw new Error("No locked UTXOs found to refund.");
  }

  const locked = selectLockedUtxo(utxos, cfg.pusdCategory);
  const fee = 700n;
  const builder = new TransactionBuilder({ provider });
  builder.setLocktime(Number(timeout));
  builder.addInput(
    locked,
    contract.unlock.refund(placeholderPublicKey(), placeholderSignature())
  );
  builder.addOutput({
    to: refundTokenAddress,
    amount: locked.satoshis - fee,
    token: locked.token
      ? { category: cfg.pusdCategory, amount: locked.token.amount }
      : undefined,
  });

  const wcTransaction = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: `Refund expired ${cfg.pusdSymbol} Atomic Swap`,
  });
  const signed = await manager.signTransaction({
    transaction: wcTransaction,
    inputPaths: [[0, "receive", 0]],
  });
  if (signed.error) {
    throw new Error(signed.error);
  }
  const txid = await provider.sendRawTransaction(signed.signedTransaction);
  return { txid };
}

function extractPushDatas(script) {
  const chunks = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i];
    i += 1;
    if (op >= 1 && op <= 0x4b) {
      if (i + op <= script.length) {
        chunks.push(script.slice(i, i + op));
      }
      i += op;
    } else if (op === 0x4c && i < script.length) {
      const len = script[i];
      i += 1;
      if (i + len <= script.length) {
        chunks.push(script.slice(i, i + len));
      }
      i += len;
    } else if (op === 0x4d && i + 1 < script.length) {
      const len = script[i] | (script[i + 1] << 8);
      i += 2;
      if (i + len <= script.length) {
        chunks.push(script.slice(i, i + len));
      }
      i += len;
    } else if (op === 0x4e && i + 3 < script.length) {
      const len =
        (script[i] |
          (script[i + 1] << 8) |
          (script[i + 2] << 16) |
          (script[i + 3] << 24)) >>>
        0;
      i += 4;
      if (i + len <= script.length) {
        chunks.push(script.slice(i, i + len));
      }
      i += len;
    }
  }
  return chunks;
}

export async function pollBchClaimedSecret({
  networkId = "mainnet",
  contractAddress,
  secretHash,
  history,
}) {
  if (!contractAddress || !secretHash) return null;
  const items = history || (await fetchScriptHistory(contractAddress, networkId));
  if (items.length === 0) return null;

  const provider = getElectrumProvider(networkId);
  const targetHash = normalizeHex32(secretHash);
  for (const item of items) {
    if (!item?.tx_hash) continue;
    const rawHex = await provider.getRawTransaction(item.tx_hash);
    const tx = decodeTransactionUnsafe(hexToBytes(rawHex));
    for (const input of tx.inputs) {
      for (const push of extractPushDatas(input.unlockingBytecode)) {
        if (push.length === 32 && (await sha256Hex(push)) === targetHash) {
          return { secret: `0x${bytesToHex(push)}`, txid: item.tx_hash };
        }
      }
    }
  }
  return null;
}
