// One-time setup for the desk's Base wallet: let SwapLock.sol move up to LIMIT USDC for the desk's locks.
//   node scripts/setup-base.mjs <evm-key-file> [--approve]   (without --approve it only prints the state)
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { SWAP_LOCK_BASE, USDC_BASE } from "../src/rules.js";

const LIMIT = 10_000_000n; // 10 USDC: the most the desk can ever have locked through the contract before a new approve
const m = readFileSync(process.argv[2], "utf8").match(/(0x)?([0-9a-fA-F]{64})\s*$/m);
const account = privateKeyToAccount(`0x${m[2]}`);
const transport = http(process.env.BASE_RPC_URL || "https://mainnet.base.org");
const pub = createPublicClient({ chain: base, transport });
const ERC20 = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];
const allowance = await pub.readContract({ address: USDC_BASE, abi: ERC20, functionName: "allowance", args: [account.address, SWAP_LOCK_BASE] });
console.log(`desk ${account.address}: allowance to SwapLock ${Number(allowance) / 1e6} USDC`);
if (process.argv.includes("--approve") && allowance < LIMIT) {
  const wallet = createWalletClient({ chain: base, transport, account });
  const hash = await wallet.writeContract({ address: USDC_BASE, abi: ERC20, functionName: "approve", args: [SWAP_LOCK_BASE, LIMIT] });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`approve ${Number(LIMIT) / 1e6} USDC: ${hash} ${r.status}`);
}
