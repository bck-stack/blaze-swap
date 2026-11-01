// node scripts/balance.mjs <wallet file>: the test wallet's UTXOs on chipnet (BCH and CashTokens).
import { loadWallet, chipnet } from "./wallet.mjs";

const w = loadWallet();
const p = chipnet();
console.log(`address ${w.address}`);
for (const u of await p.getUtxos(w.address)) console.log(`${u.txid}:${u.vout} ${u.satoshis} sat${u.token ? ` + ${u.token.amount} of ${u.token.category}` : ""}`);
console.log(`chipnet height ${await p.getBlockHeight()}`);
process.exit(0);
