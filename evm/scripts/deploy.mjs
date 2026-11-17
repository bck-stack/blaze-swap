import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const NETWORKS = {
  base: {
    chain: base,
    rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    explorer: "https://basescan.org/address/",
  },
  baseSepolia: {
    chain: baseSepolia,
    rpc: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org/address/",
  },
};

function parseArgs(argv) {
  const out = { network: "base", dry: false, envFile: "" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--network" && argv[i + 1]) {
      out.network = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--env" && argv[i + 1]) {
      out.envFile = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--dry") {
      out.dry = true;
    }
  }
  return out;
}

function readPrivateKey(envFile) {
  if (process.env.DEPLOYER_KEY) return process.env.DEPLOYER_KEY.trim();
  if (!envFile) {
    throw new Error("Set DEPLOYER_KEY env var or pass --env <path>");
  }
  const raw = readFileSync(envFile, "utf8").trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    return raw;
  }
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, idx).trim();
    if (k === "DEPLOYER_KEY" || k === "PRIVATE_KEY" || k === "EVM_PRIVATE_KEY") {
      return line.slice(idx + 1).trim();
    }
  }
  throw new Error("No DEPLOYER_KEY / PRIVATE_KEY / EVM_PRIVATE_KEY found in env file");
}

const args = parseArgs(process.argv);
const target = NETWORKS[args.network];
if (!target) {
  throw new Error(`Unsupported network "${args.network}". Use "base" or "baseSepolia".`);
}

const artifact = JSON.parse(
  readFileSync(new URL("../artifacts/contracts/SwapLock.sol/SwapLock.json", import.meta.url), "utf8")
);

const publicClient = createPublicClient({
  chain: target.chain,
  transport: http(target.rpc),
});

const rawKey = readPrivateKey(args.envFile);
const normalizedKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const account = privateKeyToAccount(normalizedKey);

const balance = await publicClient.getBalance({ address: account.address });
const gasPrice = await publicClient.getGasPrice();
const gasEstimate = await publicClient.estimateGas({
  account: account.address,
  data: artifact.bytecode,
});
const estimatedCost = gasEstimate * gasPrice;

console.log(`Network: ${target.chain.name} (${target.chain.id})`);
console.log(`Deployer: ${account.address}`);
console.log(`Balance: ${formatEther(balance)} ETH`);
console.log(`Estimated deploy cost: ~${formatEther(estimatedCost)} ETH (${gasEstimate} gas)`);

if (args.dry) {
  console.log("Dry run complete. Nothing broadcast.");
  process.exit(0);
}

if (balance < estimatedCost) {
  throw new Error(`Insufficient ETH on ${target.chain.name} to deploy SwapLock.`);
}

const walletClient = createWalletClient({
  account,
  chain: target.chain,
  transport: http(target.rpc),
});

const txHash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [],
});

console.log(`Deploy tx sent: ${txHash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log(`SwapLock deployed at: ${receipt.contractAddress}`);
console.log(`Explorer: ${target.explorer}${receipt.contractAddress}`);
