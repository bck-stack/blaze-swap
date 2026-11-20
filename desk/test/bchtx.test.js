// The desk's hand-written BCH encoding must match CashScript byte for byte: same contract address, same claim and
// refund transactions. If these pass, what the desk broadcasts is exactly what the tested contract expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Contract, MockNetworkProvider, TransactionBuilder, randomUtxo, randomToken } from 'cashscript';
import { cashAddressToLockingBytecode, encodeCashAddress, binToHex as libBinToHex, bigIntToVmNumber, encodeDataPush } from '@bitauth/libauth';
import {
  binToHex,
  claimUnlocking,
  electrumScripthash,
  encodeTransaction,
  p2sh32LockingBytecode,
  pushData,
  refundUnlocking,
  spendLockTx,
  swapLockV2Redeem,
  txid,
  vmNumber,
} from '../src/bchtx.js';

const artifact = JSON.parse(readFileSync(new URL('../../bch/SwapLockV2.json', import.meta.url)));

function terms() {
  const secret = randomBytes(32);
  return {
    secret: secret.toString('hex'),
    recipientPkh: randomBytes(20).toString('hex'),
    refundPkh: randomBytes(20).toString('hex'),
    secretHash: createHash('sha256').update(secret).digest('hex'),
    timeout: 1_795_300_000n,
    maxFee: 2_000n,
  };
}
const contractFor = (t, provider) =>
  new Contract(
    artifact,
    [Buffer.from(t.recipientPkh, 'hex'), Buffer.from(t.refundPkh, 'hex'), Buffer.from(t.secretHash, 'hex'), t.timeout, t.maxFee],
    { provider, addressType: 'p2sh32' }
  );
const addr = (pkhHex) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: Buffer.from(pkhHex, 'hex') }).address;

test('script numbers and pushes match libauth', () => {
  for (const n of [0n, 1n, 16n, 17n, 127n, 128n, 255n, 256n, 2000n, 32767n, 32768n, -1n, -128n, 1_795_300_000n]) {
    assert.equal(binToHex(vmNumber(n)), libBinToHex(bigIntToVmNumber(n)), `vmNumber(${n})`);
    assert.equal(binToHex(pushData(vmNumber(n))), libBinToHex(encodeDataPush(bigIntToVmNumber(n))), `push(${n})`);
  }
  for (const len of [20, 32, 75, 76, 200, 255, 256]) {
    const d = randomBytes(len);
    assert.equal(binToHex(pushData(d)), libBinToHex(encodeDataPush(d)), `push ${len} bytes`);
  }
});

test('the contract address (P2SH32 locking bytecode) matches CashScript', async () => {
  for (let i = 0; i < 5; i += 1) {
    const t = terms();
    const c = contractFor(t, new MockNetworkProvider());
    const mine = await p2sh32LockingBytecode(swapLockV2Redeem(t));
    const theirs = cashAddressToLockingBytecode(c.address).bytecode;
    assert.equal(binToHex(mine), libBinToHex(theirs));
  }
});

test('the Electrum scripthash is the reversed sha256 of the locking bytecode', async () => {
  const lb = Uint8Array.of(0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac);
  const expected = createHash('sha256').update(lb).digest().reverse().toString('hex');
  assert.equal(await electrumScripthash(lb), expected);
});

async function compare(withToken, path) {
  const t = terms();
  const provider = new MockNetworkProvider();
  const c = contractFor(t, provider);
  const token = withToken ? randomToken({ amount: 37n }) : undefined;
  provider.addUtxo(c.address, randomUtxo({ satoshis: 3_000n, token }));
  const [utxo] = await c.getUtxos();
  const toPkh = path === 'claim' ? t.recipientPkh : t.refundPkh;
  const locktime = path === 'claim' ? 0 : Number(t.timeout);
  const unlocker = path === 'claim' ? c.unlock.claim(Buffer.from(t.secret, 'hex')) : c.unlock.refund();
  const theirs = new TransactionBuilder({ provider })
    .addInput(utxo, unlocker)
    .addOutput({ to: addr(toPkh), amount: 2_400n, token: token ? { category: token.category, amount: token.amount } : undefined })
    .setLocktime(locktime)
    .build();
  const redeem = swapLockV2Redeem(t);
  const mine = spendLockTx({
    utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.satoshis, token: token ? { category: token.category, amount: token.amount } : undefined },
    unlocking: path === 'claim' ? claimUnlocking(t.secret, redeem) : refundUnlocking(redeem),
    toPkh,
    fee: 600n,
    locktime,
  });
  assert.equal(binToHex(mine), theirs);
}

test('a PUSD claim is byte-identical to CashScript', () => compare(true, 'claim'));
test('a plain BCH claim is byte-identical to CashScript', () => compare(false, 'claim'));
test('a PUSD refund is byte-identical to CashScript', () => compare(true, 'refund'));
test('a plain BCH refund is byte-identical to CashScript', () => compare(false, 'refund'));

test('txid is the reversed double sha256', async () => {
  const raw = encodeTransaction({ inputs: [{ txid: '11'.repeat(32), vout: 1, unlocking: Uint8Array.of(0x51) }], outputs: [{ value: 1000n, lockingBytecode: Uint8Array.of(0x51) }] });
  const h = createHash('sha256').update(createHash('sha256').update(raw).digest()).digest().reverse().toString('hex');
  assert.equal(await txid(raw), h);
});

test('a lock too small to cover the fee is refused before broadcasting', () => {
  assert.throws(() => spendLockTx({ utxo: { txid: '00'.repeat(32), vout: 0, value: 1_000n }, unlocking: new Uint8Array(1), toPkh: '00'.repeat(20) }));
});
