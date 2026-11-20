// The desk's hand-written BCH signing must produce exactly the transaction CashScript produces with the same key
// (ECDSA, RFC 6979 nonces), and that transaction must pass the libauth VM. Then the desk's reverse-direction lock is
// what a wallet would have made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SighashType as HashType, MockNetworkProvider, SignatureAlgorithm, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { encodeCashAddress, encodePrivateKeyWif, hash160, secp256k1 as libSecp, binToHex as libBinToHex } from '@bitauth/libauth';
import { binToHex, encodeTransaction, p2pkhLockingBytecode, p2sh32LockingBytecode, swapLockV2Redeem } from '../src/bchtx.js';
import { buildDeskLock, keyInfo, signP2pkhInputs, wifToKey } from '../src/bchsign.js';

const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const addr = (pkh, type = 'p2pkhWithTokens') => encodeCashAddress({ prefix: 'bchtest', type, payload: pkh }).address;

function key() {
  const priv = randomBytes(32);
  const wif = encodePrivateKeyWif(priv, 'testnet');
  const pub = libSecp.derivePublicKeyCompressed(priv);
  return { priv, wif, pub, pkh: hash160(pub) };
}

test('WIF decoding and the key hash match libauth', () => {
  for (let i = 0; i < 5; i += 1) {
    const k = key();
    assert.equal(binToHex(wifToKey(k.wif)), libBinToHex(k.priv));
    const mine = keyInfo(k.wif);
    assert.equal(binToHex(mine.pub), libBinToHex(k.pub));
    assert.equal(binToHex(mine.pkh), libBinToHex(k.pkh));
  }
  assert.throws(() => wifToKey(encodePrivateKeyWif(randomBytes(32), 'testnet').slice(0, -1) + '1'));
});

async function compare({ withToken }) {
  const k = key();
  const provider = new MockNetworkProvider();
  const from = addr(k.pkh);
  const coins = [randomUtxo({ satoshis: 50_000n }), randomUtxo({ satoshis: 7_000n })];
  if (withToken) coins.unshift(randomUtxo({ satoshis: 1_000n, token: { category: PUSD, amount: 40n } }));
  for (const c of coins) provider.addUtxo(from, c);
  const redeem = swapLockV2Redeem({ recipientPkh: binToHex(randomBytes(20)), refundPkh: binToHex(k.pkh), secretHash: binToHex(randomBytes(32)), timeout: 1_795_300_000n, maxFee: 2000n });
  const lockBytecode = await p2sh32LockingBytecode(redeem);

  const { tx, spent } = buildDeskLock({
    coins: coins.map((c) => ({ txid: c.txid, vout: c.vout, value: c.satoshis, token: c.token })),
    deskPkh: binToHex(k.pkh),
    lockBytecode,
    lockValue: withToken ? 1600n : 25_000n,
    pusdCategory: PUSD,
    pusdUnits: withToken ? 5n : 0n,
  });
  const mine = encodeTransaction(signP2pkhInputs(tx, spent, keyInfo(k.wif)));

  // the same inputs and outputs through CashScript with an ECDSA signature template
  const sig = new SignatureTemplate(k.wif, HashType.SIGHASH_ALL, SignatureAlgorithm.ECDSA);
  const byId = new Map((await provider.getUtxos(from)).map((c) => [`${c.txid}:${c.vout}`, c]));
  const b = new TransactionBuilder({ provider });
  b.addInputs(tx.inputs.map((i) => byId.get(`${i.txid}:${i.vout}`)), sig.unlockP2PKH());
  const lockAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2shWithTokens', payload: lockBytecode.slice(2, 34) }).address;
  for (const o of tx.outputs) {
    const to = o.lockingBytecode === lockBytecode ? lockAddress : addr(k.pkh, o.token ? 'p2pkhWithTokens' : 'p2pkh');
    b.addOutput({ to, amount: o.value, token: o.token });
  }
  const theirs = b.build();
  assert.equal(binToHex(mine), theirs);
  return { tx, spent };
}

test('a plain BCH lock signed by the desk matches CashScript byte for byte', async () => {
  const { tx } = await compare({ withToken: false });
  assert.equal(tx.outputs.length, 2); // lock + change
});

test('a PUSD lock (token input, token change) signed by the desk matches CashScript byte for byte', async () => {
  const { tx } = await compare({ withToken: true });
  assert.equal(tx.outputs[0].token.amount, 5n);
  assert.equal(tx.outputs[1].token.amount, 35n); // PUSD change back to the desk
});

test('buildDeskLock refuses when the desk is short', () => {
  const coins = [{ txid: '11'.repeat(32), vout: 0, value: 2_000n }];
  const base = { coins, deskPkh: '22'.repeat(20), lockBytecode: p2pkhLockingBytecode('33'.repeat(20)), pusdCategory: PUSD };
  assert.throws(() => buildDeskLock({ ...base, lockValue: 25_000n, pusdUnits: 0n }), /out of BCH/);
  assert.throws(() => buildDeskLock({ ...base, lockValue: 1_600n, pusdUnits: 5n }), /out of PUSD/);
});
