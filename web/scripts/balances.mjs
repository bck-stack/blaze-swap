// Print the addresses and balances behind a BCH wallet file and an EVM key file (keys are never printed).
//   node scripts/balances.mjs --bch-wallet <file> --evm-key <file>
import { readFileSync } from "node:fs";
import { ElectrumNetworkProvider } from "cashscript";
import { decodePrivateKeyWif, encodeCashAddress, hash160, secp256k1 } from "@bitauth/libauth";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);
const PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

if (args["bch-wallet"]) {
  const env = Object.fromEntries(
    readFileSync(args["bch-wallet"], "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
  );
  const wif = decodePrivateKeyWif(env.CHIPNET_WIF || env.BCH_WIF);
  const pkh = hash160(secp256k1.derivePublicKeyCompressed(wif.privateKey));
  const addr = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload: pkh }).address;
  const utxos = await new ElectrumNetworkProvider("mainnet").getUtxos(addr);
  const sats = utxos.reduce((s, u) => s + u.satoshis, 0n);
  const pusd = utxos.filter((u) => u.token?.category === PUSD).reduce((s, u) => s + (u.token.amount ?? 0n), 0n);
  console.log(`BCH ${addr}: ${sats} sat in ${utxos.length} utxos, PUSD ${Number(pusd) / 100}`);
}

if (args["evm-key"]) {
  const m = readFileSync(args["evm-key"], "utf8").match(/(0x)?([0-9a-fA-F]{64})\s*$/m);
  const account = privateKeyToAccount(`0x${m[2]}`);
  const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
  const [eth, usdc] = await Promise.all([
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: USDC, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [account.address] }),
  ]);
  console.log(`Base ${account.address}: ${Number(eth) / 1e18} ETH, ${Number(usdc) / 1e6} USDC`);
}
process.exit(0);
