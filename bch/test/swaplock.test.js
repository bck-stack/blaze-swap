import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, randomToken } from 'cashscript';
import { secp256k1, hash160, encodeCashAddress } from '@bitauth/libauth';

const artifact = JSON.parse(readFileSync(new URL('../SwapLock.json', import.meta.url)));
const TIMEOUT = 900_000; // a block height; refund only once the transaction's locktime reaches it

function wallet() {
  const priv = randomBytes(32);
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const pkh = hash160(pub);
  return { priv, pub, pkh, address: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address };
}

// A fresh swap: the contract holds 10,000 sats and 100 units of a token (stands in for PUSD).
function setup() {
  const provider = new MockNetworkProvider();
  const buyer = wallet(), seller = wallet();
  const secret = randomBytes(32);
  const secretHash = createHash('sha256').update(secret).digest();
  const contract = new Contract(artifact, [buyer.pkh, seller.pkh, secretHash, BigInt(TIMEOUT)], { provider });
  const token = randomToken({ amount: 100n });
  provider.addUtxo(contract.address, randomUtxo({ satoshis: 10_000n, token }));
  return { provider, contract, buyer, seller, secret, token };
}

const payTo = (who, token) => ({ to: who.address, amount: 9_000n, token: { category: token.category, amount: token.amount } });

test('recipient claims the tokens with the right secret', async () => {
  const { provider, contract, buyer, secret, token } = setup();
  const [utxo] = await contract.getUtxos();
  const tx = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.claim(buyer.pub, new SignatureTemplate(buyer.priv), secret))
    .addOutput(payTo(buyer, token));
  assert.doesNotThrow(() => tx.debug());
});

test('a wrong secret is refused', async () => {
  const { provider, contract, buyer, token } = setup();
  const [utxo] = await contract.getUtxos();
  const tx = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.claim(buyer.pub, new SignatureTemplate(buyer.priv), randomBytes(32)))
    .addOutput(payTo(buyer, token));
  assert.throws(() => tx.debug());
});

test('a 31-byte secret is refused even if it hashes right', async () => {
  const provider = new MockNetworkProvider();
  const buyer = wallet(), seller = wallet();
  const secret = randomBytes(31);
  const contract = new Contract(artifact, [buyer.pkh, seller.pkh, createHash('sha256').update(secret).digest(), BigInt(TIMEOUT)], { provider });
  const token = randomToken({ amount: 100n });
  provider.addUtxo(contract.address, randomUtxo({ satoshis: 10_000n, token }));
  const [utxo] = await contract.getUtxos();
  const tx = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.claim(buyer.pub, new SignatureTemplate(buyer.priv), secret))
    .addOutput(payTo(buyer, token));
  assert.throws(() => tx.debug());
});

test('someone who is not the recipient cannot claim, even with the secret', async () => {
  const { provider, contract, secret, token } = setup();
  const thief = wallet();
  const [utxo] = await contract.getUtxos();
  const tx = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.claim(thief.pub, new SignatureTemplate(thief.priv), secret))
    .addOutput(payTo(thief, token));
  assert.throws(() => tx.debug());
});

test('the sender cannot refund before the timeout', async () => {
  const { provider, contract, seller, token } = setup();
  const [utxo] = await contract.getUtxos();
  const tx = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.refund(seller.pub, new SignatureTemplate(seller.priv)))
    .addOutput(payTo(seller, token))
    .setLocktime(TIMEOUT - 1);
  assert.throws(() => tx.debug());
});

test('the sender refunds after the timeout', async () => {
  const { provider, contract, seller, token } = setup();
  const [utxo] = await contract.getUtxos();
  const tx = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.refund(seller.pub, new SignatureTemplate(seller.priv)))
    .addOutput(payTo(seller, token))
    .setLocktime(TIMEOUT);
  assert.doesNotThrow(() => tx.debug());
});

test('the recipient cannot use the refund path', async () => {
  const { provider, contract, buyer, token } = setup();
  const [utxo] = await contract.getUtxos();
  const tx = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.refund(buyer.pub, new SignatureTemplate(buyer.priv)))
    .addOutput(payTo(buyer, token))
    .setLocktime(TIMEOUT);
  assert.throws(() => tx.debug());
});
