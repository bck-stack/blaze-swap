// End-to-end check of the BLAZE Desk on mainnet, playing the user from a script: quote → lock PUSD (or BCH) in a
// SwapLockV2 → /take (the desk locks USDC on Base) → /reveal (the desk pays the user on Base, then claims its BCH).
//   node scripts/desk-smoke.mjs --bch-wallet <file> --to-base <0x…> [--pay PUSD|BCH] [--units 5] [--desk <url>]
// The BCH wallet file holds CHIPNET_WIF/BCH_WIF (never printed).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Contract, ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { decodePrivateKeyWif, encodeCashAddress, hash160, secp256k1 } from '@bitauth/libauth';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') && a.push([x.slice(2), all[i + 1]]), a), []));
const DESK = args.desk || 'https://blaze-desk.launch-engine.workers.dev';
const pay = args.pay || 'PUSD';
const units = BigInt(args.units || (pay === 'PUSD' ? 5 : 30_000));
const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const artifact = JSON.parse(readFileSync(new URL('../SwapLockV2.json', import.meta.url)));

const env = Object.fromEntries(readFileSync(args['bch-wallet'], 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const wif = decodePrivateKeyWif(env.CHIPNET_WIF || env.BCH_WIF);
const pkh = hash160(secp256k1.derivePublicKeyCompressed(wif.privateKey));
const userAddr = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: pkh }).address;
const userTokenAddr = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: pkh }).address;
const signer = new SignatureTemplate(wif.privateKey);
const provider = new ElectrumNetworkProvider('mainnet');
const post = async (path, body) => (await fetch(DESK + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const t0 = Date.now();

const q = await post('/api/quote', { pay, payUnits: units.toString() });
if (!q.ok) throw new Error(q.error);
log(`quote: pay ${q.quote.payUnits} ${pay}, receive ${Number(q.quote.usdcUnits) / 1e6} USDC, lock ${q.quote.lockSats} sat`);

const secret = randomBytes(32);
const secretHash = createHash('sha256').update(secret).digest();
const bchTimeout = Math.floor(Date.now() / 1000) + 3 * 3600;
const contract = new Contract(artifact, [Buffer.from(q.quote.deskBchPkh, 'hex'), pkh, secretHash, BigInt(bchTimeout), BigInt(q.quote.maxFee)], { provider, addressType: 'p2sh32' });

const utxos = await provider.getUtxos(userAddr);
const lockSats = BigInt(q.quote.lockSats);
const tb = new TransactionBuilder({ provider });
let inSats = 0n;
if (pay === 'PUSD') {
  const tok = utxos.filter((u) => u.token?.category === PUSD && !u.token.nft).sort((a, b) => Number(b.token.amount - a.token.amount))[0];
  if (!tok || tok.token.amount < units) throw new Error('not enough PUSD');
  tb.addInput(tok, signer.unlockP2PKH());
  inSats += tok.satoshis;
  const change = tok.token.amount - units;
  tb.addOutput({ to: contract.tokenAddress, amount: lockSats, token: { category: PUSD, amount: units } });
  if (change > 0n) tb.addOutput({ to: userTokenAddr, amount: 1000n, token: { category: PUSD, amount: change } });
} else {
  tb.addOutput({ to: contract.address, amount: lockSats });
}
const plain = utxos.filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
tb.addInput(plain[0], signer.unlockP2PKH());
inSats += plain[0].satoshis;
const outSats = lockSats + (pay === 'PUSD' && tb.outputs.length > 1 ? 1000n : 0n);
const fee = 800n;
tb.addOutput({ to: userAddr, amount: inSats - outSats - fee });
const lock = await tb.send();
log(`user lock on BCH: ${lock.txid}`);

let take;
for (let i = 0; i < 20; i += 1) {
  take = await post('/api/take', { quote: q.quote, mac: q.mac, secretHash: secretHash.toString('hex'), userPkh: Buffer.from(pkh).toString('hex'), userBase: args['to-base'], bchTimeout });
  if (!take.ok) throw new Error(take.error);
  log(`take: ${take.swap.state}${take.swap.reason ? ` (${take.swap.reason})` : ''}${take.swap.lastError ? ` [${take.swap.lastError}]` : ''}`);
  if (take.swap.state !== 'waiting-for-lock') break;
  await new Promise((r) => setTimeout(r, 3000));
}
if (take.swap.state !== 'desk-locked') throw new Error('desk did not lock');
log(`desk lock on Base: ${take.swap.baseLockTx}`);

const rev = await post('/api/reveal', { secret: secret.toString('hex') });
if (!rev.ok) throw new Error(rev.error);
log(`reveal: ${rev.swap.state}; Base claim for the user ${rev.swap.baseClaimTx}; desk BCH claim ${rev.swap.bchClaimTx}`);
log(`total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(0);
