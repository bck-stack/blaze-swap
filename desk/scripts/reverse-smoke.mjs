// End-to-end check of the desk's reverse direction on mainnet, playing the user from a script: quote → approve + lock
// USDC on Base → /take (the desk locks PUSD or BCH on Bitcoin Cash for the user) → check that lock → /reveal (the
// desk delivers the BCH side to the user, then claims the USDC).
//   node scripts/reverse-smoke.mjs --evm-key <file> --to-pkh <hex20> [--receive PUSD|BCH] [--units 5] [--desk <url>]
// The key file holds a Base private key (never printed).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, fallback, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { binToHex, electrumScripthash, p2sh32LockingBytecode, swapLockV2Redeem } from '../src/bchtx.js';
import { SWAP_LOCK_BASE, USDC_BASE } from '../src/rules.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') && a.push([x.slice(2), all[i + 1]]), a), []));
const DESK = args.desk || 'https://blaze-desk.launch-engine.workers.dev';
const receive = args.receive || 'PUSD';
const units = BigInt(args.units || (receive === 'PUSD' ? 5 : 27_000));
const key = readFileSync(args['evm-key'], 'utf8').match(/(0x)?([0-9a-fA-F]{64})\s*$/m)[2];
const account = privateKeyToAccount(`0x${key}`);
const transport = fallback(['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'].map((u) => http(u)));
const pub = createPublicClient({ chain: base, transport });
const wallet = createWalletClient({ chain: base, transport, account });
const ERC20 = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const LOCK = [{ type: 'function', name: 'lock', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint64' }], outputs: [{ type: 'bytes32' }] }];
const post = async (path, body) => (await fetch(DESK + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (path) => (await fetch(DESK + path)).json();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const t0 = Date.now();

const q = await post('/api/quote', { dir: 'toBch', receive, receiveUnits: units.toString() });
if (!q.ok) throw new Error(q.error);
log(`quote: lock ${Number(q.quote.usdcUnits) / 1e6} USDC, receive ${q.quote.receiveUnits} ${receive}, desk lock ${q.quote.lockSats} sat`);

const secret = randomBytes(32);
const secretHash = createHash('sha256').update(secret).digest('hex');
const baseTimeout = Math.floor(Date.now() / 1000) + 3 * 3600;
const amount = BigInt(q.quote.usdcUnits);

const allowance = await pub.readContract({ address: USDC_BASE, abi: ERC20, functionName: 'allowance', args: [account.address, SWAP_LOCK_BASE] });
if (allowance < amount) {
  const h = await wallet.writeContract({ address: USDC_BASE, abi: ERC20, functionName: 'approve', args: [SWAP_LOCK_BASE, amount] });
  await pub.waitForTransactionReceipt({ hash: h });
  log(`approve: ${h}`);
}
const lockTx = await wallet.writeContract({ address: SWAP_LOCK_BASE, abi: LOCK, functionName: 'lock', args: [USDC_BASE, q.quote.deskBase, amount, `0x${secretHash}`, BigInt(baseTimeout)] });
await pub.waitForTransactionReceipt({ hash: lockTx });
log(`user lock on Base: ${lockTx}`);

let r = await post('/api/take', { quote: q.quote, mac: q.mac, secretHash, userPkh: args['to-pkh'], userBase: account.address, baseTimeout });
if (!r.ok) throw new Error(r.error);
for (let i = 0; i < 40 && r.swap.state !== 'desk-locked'; i += 1) {
  if (['refused', 'abandoned'].includes(r.swap.state)) throw new Error(`desk refused: ${r.swap.reason}`);
  await new Promise((res) => setTimeout(res, 3000));
  r = await get(`/api/swap/${secretHash}`);
}
if (r.swap.state !== 'desk-locked') throw new Error(`desk did not lock: ${JSON.stringify(r.swap).slice(0, 300)}`);
log(`desk lock on BCH: ${r.swap.bchLockTx}`);

// what the page will do: rebuild the contract from the terms and look for the coins at that address
const redeem = swapLockV2Redeem({ recipientPkh: args['to-pkh'], refundPkh: q.quote.deskBchPkh, secretHash, timeout: BigInt(r.swap.deskTimeout), maxFee: BigInt(q.quote.maxFee) });
const lb = await p2sh32LockingBytecode(redeem);
log(`contract scripthash ${await electrumScripthash(lb)} (desk timeout in ${Math.round((r.swap.deskTimeout - Date.now() / 1000) / 60)} min)`);

r = await post('/api/reveal', { secret: secret.toString('hex') });
if (!r.ok) throw new Error(r.error);
for (let i = 0; i < 40 && r.swap.state !== 'done'; i += 1) {
  await new Promise((res) => setTimeout(res, 3000));
  r = await get(`/api/swap/${secretHash}`);
}
for (const e of r.swap.events) log(e.step.padEnd(14), e.tx || '', e.by || '');
log(`state ${r.swap.state} in ${((Date.now() - t0) / 1000).toFixed(1)} s${r.swap.lastError ? ` (last error: ${r.swap.lastError})` : ''}`);
void binToHex;
