// SwapLockV2: no signatures; the contract alone decides where the coins may go. Each test is one attempt a broadcaster
// could make, honest or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Contract, MockNetworkProvider, TransactionBuilder, randomUtxo, randomToken } from 'cashscript';
import { secp256k1, hash160, encodeCashAddress } from '@bitauth/libauth';

const artifact = JSON.parse(readFileSync(new URL('../SwapLockV2.json', import.meta.url)));
const TIMEOUT = 900_000; // a block height here; mainnet swaps use a unix time
const MAX_FEE = 2_000n;
const LOCKED = 10_000n;

function wallet() {
  const pkh = hash160(secp256k1.derivePublicKeyCompressed(randomBytes(32)));
  return { pkh, address: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address };
}

function setup({ withToken = true } = {}) {
  const provider = new MockNetworkProvider();
  const recipient = wallet(), owner = wallet();
  const secret = randomBytes(32);
  const secretHash = createHash('sha256').update(secret).digest();
  const contract = new Contract(artifact, [recipient.pkh, owner.pkh, secretHash, BigInt(TIMEOUT), MAX_FEE], { provider });
  const token = withToken ? randomToken({ amount: 100n }) : undefined;
  provider.addUtxo(contract.address, randomUtxo({ satoshis: LOCKED, token }));
  return { provider, contract, recipient, owner, secret, token };
}

const out = (who, token, amount = LOCKED - 1_000n) => ({
  to: who.address,
  amount,
  token: token ? { category: token.category, amount: token.amount } : undefined,
});

async function claimTx(s, secret, output, extra = (b) => b) {
  const [utxo] = await s.contract.getUtxos();
  return extra(new TransactionBuilder({ provider: s.provider, allowImplicitFungibleTokenBurn: true }).addInput(utxo, s.contract.unlock.claim(secret)).addOutput(output));
}
async function refundTx(s, locktime, output, extra = (b) => b) {
  const [utxo] = await s.contract.getUtxos();
  return extra(new TransactionBuilder({ provider: s.provider, allowImplicitFungibleTokenBurn: true }).addInput(utxo, s.contract.unlock.refund()).addOutput(output).setLocktime(locktime));
}

test('anyone can broadcast the claim, and the PUSD goes to the recipient', async () => {
  const s = setup();
  (await claimTx(s, s.secret, out(s.recipient, s.token))).debug();
});

test('plain BCH locks claim the same way', async () => {
  const s = setup({ withToken: false });
  (await claimTx(s, s.secret, out(s.recipient))).debug();
});

test('a wrong secret is refused', async () => {
  const s = setup();
  await assert.rejects(async () => (await claimTx(s, randomBytes(32), out(s.recipient, s.token))).debug());
});

test('a broadcaster who knows the secret cannot send the coins to itself', async () => {
  const s = setup();
  await assert.rejects(async () => (await claimTx(s, s.secret, out(wallet(), s.token))).debug());
});

test('the claim cannot drop or shrink the PUSD', async () => {
  const s = setup();
  const fewer = { to: s.recipient.address, amount: LOCKED - 1_000n, token: { category: s.token.category, amount: s.token.amount - 1n } };
  await assert.rejects(async () => (await claimTx(s, s.secret, fewer)).debug());
  await assert.rejects(async () => (await claimTx(s, s.secret, out(s.recipient, undefined))).debug());
});

test('the claim cannot spend more than maxFee on fees', async () => {
  const s = setup();
  await assert.rejects(async () => (await claimTx(s, s.secret, out(s.recipient, s.token, LOCKED - MAX_FEE - 1n))).debug());
  (await claimTx(s, s.secret, out(s.recipient, s.token, LOCKED - MAX_FEE))).debug();
});

test('a second output (to skim value) is refused', async () => {
  const s = setup();
  await assert.rejects(async () =>
    (await claimTx(s, s.secret, out(s.recipient, s.token, LOCKED - 1_500n), (b) => b.addOutput({ to: wallet().address, amount: 1_000n }))).debug()
  );
});

test('two locks cannot be merged into one claim', async () => {
  // plain BCH, so nothing but the contract's one-input rule stops the broadcaster keeping the extra fee
  const s = setup({ withToken: false });
  s.provider.addUtxo(s.contract.address, randomUtxo({ satoshis: LOCKED }));
  const [a, b] = await s.contract.getUtxos();
  const tx = new TransactionBuilder({ provider: s.provider, allowImplicitFungibleTokenBurn: true })
    .addInput(a, s.contract.unlock.claim(s.secret))
    .addInput(b, s.contract.unlock.claim(s.secret))
    .addOutput(out(s.recipient, undefined, 2n * LOCKED - 3_000n));
  assert.throws(() => tx.debug());
});

test('the refund is refused before the timeout', async () => {
  const s = setup();
  await assert.rejects(async () => (await refundTx(s, TIMEOUT - 1, out(s.owner, s.token))).debug());
});

test('after the timeout anyone can broadcast the refund, and it pays the owner', async () => {
  const s = setup();
  (await refundTx(s, TIMEOUT, out(s.owner, s.token))).debug();
});

test('the refund cannot pay anyone but the owner', async () => {
  const s = setup();
  await assert.rejects(async () => (await refundTx(s, TIMEOUT, out(s.recipient, s.token))).debug());
  await assert.rejects(async () => (await refundTx(s, TIMEOUT, out(wallet(), s.token))).debug());
});

test('the refund keeps the PUSD and the fee cap too', async () => {
  const s = setup();
  await assert.rejects(async () => (await refundTx(s, TIMEOUT, out(s.owner, undefined))).debug());
  await assert.rejects(async () => (await refundTx(s, TIMEOUT, out(s.owner, s.token, LOCKED - MAX_FEE - 1n))).debug());
});
