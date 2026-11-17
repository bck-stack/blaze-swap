import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const SWAP_LOCK = "0xf66642c35cf4a36fcd7d3bcf87422791280f8901";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AMOUNT = 50_000n; // 0.05 USDC

const envPath = process.argv[2] ?? process.env.EVM_KEY_FILE;
if (!envPath) {
  throw new Error("Pass key file path as argument or set EVM_KEY_FILE");
}
const rawKey = readFileSync(envPath, "utf8").trim();
const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const account = privateKeyToAccount(key);

const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const walletClient = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });

const artifact = JSON.parse(
  readFileSync(new URL("../artifacts/contracts/SwapLock.sol/SwapLock.json", import.meta.url), "utf8")
);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const ethBefore = await publicClient.getBalance({ address: account.address });
const usdcBefore = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log("Account:", account.address);
console.log("Before:", formatEther(ethBefore), "ETH |", formatUnits(usdcBefore, 6), "USDC");

const approveHash = await walletClient.writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "approve",
  args: [SWAP_LOCK, AMOUNT],
});
await publicClient.waitForTransactionReceipt({ hash: approveHash });
console.log("Approve tx:", approveHash);

const secret = randomBytes(32);
const secretHex = `0x${secret.toString("hex")}`;
const secretHash = `0x${createHash("sha256").update(secret).digest("hex")}`;
const timeout = BigInt(Math.floor(Date.now() / 1000) + 3600);

const lockId = await publicClient.readContract({
  address: SWAP_LOCK,
  abi: artifact.abi,
  functionName: "lockId",
  args: [USDC, account.address, account.address, AMOUNT, secretHash, timeout],
});

const lockHash = await walletClient.writeContract({
  address: SWAP_LOCK,
  abi: artifact.abi,
  functionName: "lock",
  args: [USDC, account.address, AMOUNT, secretHash, timeout],
});
await publicClient.waitForTransactionReceipt({ hash: lockHash });
console.log("Lock tx:", lockHash);
console.log("Lock ID:", lockId);

const claimHash = await walletClient.writeContract({
  address: SWAP_LOCK,
  abi: artifact.abi,
  functionName: "claim",
  args: [lockId, secretHex],
});
await publicClient.waitForTransactionReceipt({ hash: claimHash });
console.log("Claim tx:", claimHash);

const ethAfter = await publicClient.getBalance({ address: account.address });
const usdcAfter = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log("After:", formatEther(ethAfter), "ETH |", formatUnits(usdcAfter, 6), "USDC");
