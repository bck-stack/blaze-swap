import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbiItem,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import SwapLockEvmArtifact from "../contracts/SwapLockEvm.json";
import {
  NETWORK_CONFIG,
  computeEvmLockId,
  normalizeHex32,
} from "./swapProtocol.js";

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

const CLAIMED_EVENT = parseAbiItem(
  "event Claimed(bytes32 indexed id, bytes32 secret)"
);

function getViemChain(networkId) {
  return networkId === "chipnet" ? baseSepolia : base;
}

export function getEvmPublicClient(networkId = "mainnet") {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  return createPublicClient({
    chain: getViemChain(cfg.id),
    transport: http(cfg.evmRpcUrl),
  });
}

export async function connectEvmWallet(networkId = "mainnet") {
  if (!globalThis.ethereum) {
    throw new Error(
      "No EVM browser wallet found. Install MetaMask, Coinbase Wallet, or Rabby."
    );
  }
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  const accounts = await globalThis.ethereum.request({
    method: "eth_requestAccounts",
  });
  const chainHex = `0x${cfg.evmChainId.toString(16)}`;
  try {
    await globalThis.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainHex }],
    });
  } catch (err) {
    if (err?.code === 4902) {
      await globalThis.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainHex,
            chainName: cfg.evmChainName,
            rpcUrls: [cfg.evmRpcUrl],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: [cfg.evmExplorerTx.replace(/\/tx\/$/, "")],
          },
        ],
      });
    }
  }
  return accounts[0];
}

function getEvmWalletClient(networkId = "mainnet", account) {
  if (!globalThis.ethereum) {
    throw new Error("No EVM browser wallet detected.");
  }
  return createWalletClient({
    account,
    chain: getViemChain(networkId),
    transport: custom(globalThis.ethereum),
  });
}

export async function fetchEvmBalances({
  networkId = "mainnet",
  swapLockAddress,
  userAddress,
}) {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  const client = getEvmPublicClient(networkId);
  const usdcBalance = await client.readContract({
    address: cfg.evmUsdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [userAddress],
  });
  let usdcAllowance = 0n;
  if (swapLockAddress) {
    usdcAllowance = await client.readContract({
      address: cfg.evmUsdcAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [userAddress, swapLockAddress],
    });
  }
  return { usdcBalance, usdcAllowance };
}

export async function fetchEvmLockState({
  networkId = "mainnet",
  swapLockAddress,
  lockId,
}) {
  if (!swapLockAddress || !lockId) return null;
  const client = getEvmPublicClient(networkId);
  const res = await client.readContract({
    address: swapLockAddress,
    abi: SwapLockEvmArtifact.abi,
    functionName: "locks",
    args: [lockId],
  });
  const [token, sender, recipient, amount, secretHash, timeout, settled] = res;
  const exists =
    sender !== "0x0000000000000000000000000000000000000000" && amount > 0n;
  return {
    exists,
    token,
    sender,
    recipient,
    amount,
    secretHash,
    timeout: Number(timeout),
    settled,
  };
}

export async function approveEvmUsdc({
  networkId = "mainnet",
  account,
  swapLockAddress,
  amount,
}) {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  const wallet = getEvmWalletClient(networkId, account);
  const publicClient = getEvmPublicClient(networkId);
  const hash = await wallet.writeContract({
    address: cfg.evmUsdcAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [swapLockAddress, BigInt(amount)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function lockEvmSwap({
  networkId = "mainnet",
  account,
  swapLockAddress,
  recipient,
  amount,
  secretHash,
  timeout,
}) {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  const wallet = getEvmWalletClient(networkId, account);
  const publicClient = getEvmPublicClient(networkId);
  const normalizedHash = normalizeHex32(secretHash);
  const lockId = computeEvmLockId({
    token: cfg.evmUsdcAddress,
    sender: account,
    recipient,
    amount,
    secretHash: normalizedHash,
    timeout,
  });
  const hash = await wallet.writeContract({
    address: swapLockAddress,
    abi: SwapLockEvmArtifact.abi,
    functionName: "lock",
    args: [
      cfg.evmUsdcAddress,
      recipient,
      BigInt(amount),
      normalizedHash,
      BigInt(timeout),
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, lockId };
}

export async function claimEvmSwap({
  networkId = "mainnet",
  account,
  swapLockAddress,
  lockId,
  secretHex,
}) {
  const wallet = getEvmWalletClient(networkId, account);
  const publicClient = getEvmPublicClient(networkId);
  const hash = await wallet.writeContract({
    address: swapLockAddress,
    abi: SwapLockEvmArtifact.abi,
    functionName: "claim",
    args: [lockId, normalizeHex32(secretHex)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function refundEvmSwap({
  networkId = "mainnet",
  account,
  swapLockAddress,
  lockId,
}) {
  const wallet = getEvmWalletClient(networkId, account);
  const publicClient = getEvmPublicClient(networkId);
  const hash = await wallet.writeContract({
    address: swapLockAddress,
    abi: SwapLockEvmArtifact.abi,
    functionName: "refund",
    args: [lockId],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function pollEvmClaimedSecret({
  networkId = "mainnet",
  swapLockAddress,
  lockId,
  lookbackBlocks = 24000n,
  chunkSize = 4000n,
}) {
  if (!swapLockAddress || !lockId) return null;
  const client = getEvmPublicClient(networkId);
  const latest = await client.getBlockNumber();
  const minBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  for (let to = latest; to >= minBlock; ) {
    const from = to > chunkSize ? (to - chunkSize > minBlock ? to - chunkSize : minBlock) : minBlock;
    const logs = await client.getLogs({
      address: swapLockAddress,
      event: CLAIMED_EVENT,
      args: { id: lockId },
      fromBlock: from,
      toBlock: to,
    });
    if (logs.length > 0) {
      return logs[logs.length - 1].args.secret || null;
    }
    if (from === 0n || from <= minBlock) break;
    to = from - 1n;
  }
  return null;
}
