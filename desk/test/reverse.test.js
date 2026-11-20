// The reverse direction's rules: what the user locks on Base for what they receive on Bitcoin Cash, and when the
// desk may put its coins down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVERSE, checkUserBaseLock, priceQuoteToBch } from '../src/rules.js';

test('receiving 0.10 PUSD costs 0.1005 USDC; the lock carries dust plus the claim fee', () => {
  const q = priceQuoteToBch({ receive: 'PUSD', receiveUnits: 10n });
  assert.equal(q.usdcUnits, 100_500n);
  assert.equal(q.feeUnits, 500n);
  assert.equal(q.lockSats, REVERSE.pusdLockSats);
});

test('receiving BCH follows the price, and the lock adds exactly the claim fee', () => {
  const q = priceQuoteToBch({ receive: 'BCH', receiveUnits: 40_000n, bchUsd: 250 });
  assert.equal(q.usdMicros, 100_000n);
  assert.equal(q.usdcUnits, 100_500n);
  assert.equal(q.lockSats, 40_600n);
});

test('reverse quotes outside $0.05–$0.25 or without a price are refused', () => {
  assert.throws(() => priceQuoteToBch({ receive: 'PUSD', receiveUnits: 4n }), /at least/);
  assert.throws(() => priceQuoteToBch({ receive: 'PUSD', receiveUnits: 26n }), /at most/);
  assert.throws(() => priceQuoteToBch({ receive: 'BCH', receiveUnits: 30_000n, bchUsd: 0 }), /price/);
  assert.throws(() => priceQuoteToBch({ receive: 'ETH', receiveUnits: 10n }));
});

test('the desk locks only against a live, unsettled Base lock that leaves it time', () => {
  const now = 1_800_000_000;
  const live = { exists: true, settled: false };
  const ok = checkUserBaseLock({ state: live, baseTimeout: now + 3 * 3600, nowSec: now });
  assert.equal(ok.ok, true);
  assert.equal(ok.deskTimeout, now + 3600);
  // the desk's lock always ends two hours before the user's (one hour of margin, one of BCH median-time lag)
  const tight = checkUserBaseLock({ state: live, baseTimeout: now + 2.6 * 3600, nowSec: now });
  assert.equal(tight.deskTimeout, now + 0.6 * 3600);
  assert.equal(checkUserBaseLock({ state: { exists: false }, baseTimeout: now + 3 * 3600, nowSec: now }).retry, true);
  assert.equal(checkUserBaseLock({ state: { exists: true, settled: true }, baseTimeout: now + 3 * 3600, nowSec: now }).ok, false);
  assert.equal(checkUserBaseLock({ state: live, baseTimeout: now + 2 * 3600, nowSec: now }).ok, false);
  assert.equal(checkUserBaseLock({ state: live, baseTimeout: now + 25 * 3600, nowSec: now }).ok, false);
});
