import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUSD_CATEGORY, RULES, checkUserLock, priceQuote, signQuote, verifyQuote } from '../src/rules.js';

test('PUSD quote: 0.10 PUSD pays 0.0995 USDC after the 0.5% fee', () => {
  const q = priceQuote({ pay: 'PUSD', payUnits: 10n });
  assert.equal(q.usdcUnits, 99_500n);
  assert.equal(q.feeUnits, 500n);
  assert.equal(q.lockSats, RULES.lockExtraSats);
});

test('BCH quote follows the price: 40,000 sat at $250 is $0.10', () => {
  const q = priceQuote({ pay: 'BCH', payUnits: 40_000n, bchUsd: 250 });
  assert.equal(q.usdMicros, 100_000n);
  assert.equal(q.usdcUnits, 99_500n);
  assert.equal(q.lockSats, 43_000n);
});

test('quotes outside $0.05–$0.25 or without a price are refused', () => {
  assert.throws(() => priceQuote({ pay: 'PUSD', payUnits: 4n }));
  assert.throws(() => priceQuote({ pay: 'PUSD', payUnits: 26n }));
  assert.throws(() => priceQuote({ pay: 'BCH', payUnits: 40_000n, bchUsd: 0 }));
  assert.throws(() => priceQuote({ pay: 'DOGE', payUnits: 1n }));
});

const now = 1_795_200_000;
const pusdQuote = priceQuote({ pay: 'PUSD', payUnits: 10n });
const goodUtxo = { value: 3_000n, token: { category: PUSD_CATEGORY, amount: 10n } };

test('a correct PUSD lock passes, and the desk lock ends an hour before the user’s', () => {
  const r = checkUserLock({ quote: pusdQuote, utxo: goodUtxo, bchTimeout: now + 3 * 3600, nowSec: now });
  assert.equal(r.ok, true);
  assert.equal(r.deskTimeout, now + 3600);
  const tight = checkUserLock({ quote: pusdQuote, utxo: goodUtxo, bchTimeout: now + 2 * 3600, nowSec: now });
  assert.equal(tight.deskTimeout, now + 3600);
});

test('the desk does not lock against a short, missing or wrong lock', () => {
  const at = (utxo, t = now + 3 * 3600) => checkUserLock({ quote: pusdQuote, utxo, bchTimeout: t, nowSec: now });
  assert.equal(at(null).retry, true);
  assert.equal(at({ ...goodUtxo, token: { category: PUSD_CATEGORY, amount: 9n } }).ok, false);
  assert.equal(at({ ...goodUtxo, token: { category: 'ab'.repeat(32), amount: 10n } }).ok, false);
  assert.equal(at({ ...goodUtxo, token: undefined }).ok, false);
  assert.equal(at({ ...goodUtxo, value: 2_999n }).ok, false);
  assert.equal(at(goodUtxo, now + 3600).ok, false);
  assert.equal(at(goodUtxo, now + 30 * 3600).ok, false);
});

test('a BCH lock must hold the BCH plus the extra and no token', () => {
  const q = priceQuote({ pay: 'BCH', payUnits: 40_000n, bchUsd: 250 });
  const at = (utxo) => checkUserLock({ quote: q, utxo, bchTimeout: now + 3 * 3600, nowSec: now });
  assert.equal(at({ value: 43_000n }).ok, true);
  assert.equal(at({ value: 42_999n }).ok, false);
  assert.equal(at({ value: 43_000n, token: { category: PUSD_CATEGORY, amount: 1n } }).ok, false);
});

test('signed quotes cannot be edited or reused after they expire', async () => {
  const body = { pay: 'PUSD', payUnits: '10', usdcUnits: '99500', expiresAt: now + 600 };
  const mac = await signQuote('k', body);
  assert.equal(await verifyQuote('k', body, mac, now), null);
  assert.match(await verifyQuote('k', { ...body, usdcUnits: '200000' }, mac, now), /changed/);
  assert.match(await verifyQuote('k', body, mac, now + 601), /expired/);
  assert.match(await verifyQuote('other', body, mac, now), /changed/);
});
