import { describe, expect, it } from "vitest";
import {
  computeEvmLockId,
  computePairedTimeouts,
  decodeOffer,
  derivePkhAndAddressesFromPubkey,
  encodeOffer,
  hexToBytes,
  NETWORK_CONFIG,
  swapSteps,
} from "./swapProtocol.js";

const maker = derivePkhAndAddressesFromPubkey(
  hexToBytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  "mainnet"
);
const taker = derivePkhAndAddressesFromPubkey(
  hexToBytes("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"),
  "mainnet"
);
const now = 1_795_000_000;
const { makerTimeout, takerTimeout } = computePairedTimeouts(now);

function makerSwap(overrides = {}) {
  const secretHash = "0x" + "ab".repeat(32);
  return {
    networkId: "mainnet",
    direction: "BASE_TO_BCH",
    displayAmount: "1.00",
    pusdUnits: "100",
    usdcUnits: "1000000",
    secret: "0x" + "cd".repeat(32),
    secretHash,
    bchRecipientAddr: maker.tokenAddress,
    bchRefundAddr: taker.tokenAddress,
    bchTimeout: takerTimeout,
    evmSenderAddr: "0x1111111111111111111111111111111111111111",
    evmRecipientAddr: "0x2222222222222222222222222222222222222222",
    evmTimeout: makerTimeout,
    evmContractAddr: NETWORK_CONFIG.mainnet.defaultSwapLockAddress,
    ...overrides,
  };
}

describe("offer links", () => {
  it("round-trips the public terms and never carries the secret", () => {
    const swap = makerSwap();
    const encoded = encodeOffer(swap);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const offer = decodeOffer(encoded);
    expect(offer.secret).toBeUndefined();
    expect(JSON.stringify(offer)).not.toContain("cdcdcd");
    expect(offer.secretHash).toBe(swap.secretHash);
    expect(offer.bchRecipientPkh).toBe(maker.pkhHex);
    expect(offer.bchRefundPkh).toBe(taker.pkhHex);
    // The Base lock id is recomputed from the terms, not copied from the link.
    expect(offer.evmLockId).toBe(
      computeEvmLockId({
        token: NETWORK_CONFIG.mainnet.evmUsdcAddress,
        sender: swap.evmSenderAddr,
        recipient: swap.evmRecipientAddr,
        amount: 1_000_000n,
        secretHash: swap.secretHash,
        timeout: makerTimeout,
      })
    );
  });

  it("rejects an offer where the maker's lock does not outlive the taker's", () => {
    const bad = makerSwap({ evmTimeout: takerTimeout + 600 });
    expect(() => decodeOffer(encodeOffer(bad))).toThrow(/Unsafe offer/);
  });

  it("rejects damaged links and addresses from the wrong network", () => {
    expect(() => decodeOffer("not-json")).toThrow();
    const chipnetAddr = derivePkhAndAddressesFromPubkey(
      hexToBytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
      "chipnet"
    ).tokenAddress;
    expect(() => decodeOffer(encodeOffer(makerSwap({ bchRecipientAddr: chipnetAddr })))).toThrow(/not on/);
  });
});

describe("swap steps", () => {
  const base = { direction: "BASE_TO_BCH", nowSec: now + 60, bchTimeout: takerTimeout, evmTimeout: makerTimeout };
  const empty = { bch: { funded: false, spent: false, amountOk: false }, base: { exists: false, settled: false, amountOk: false } };

  it("tells the maker to lock first and the taker to wait", () => {
    expect(swapSteps({ ...base, role: "maker", lock: empty, hasSecret: true }).next).toBe("maker-lock");
    expect(swapSteps({ ...base, role: "taker", lock: empty, hasSecret: false }).next).toBe("wait");
  });

  it("lets the taker lock only once the maker's lock has the right amount", () => {
    const wrongAmount = { ...empty, base: { exists: true, settled: false, amountOk: false } };
    expect(swapSteps({ ...base, role: "taker", lock: wrongAmount, hasSecret: false }).next).toBe("wait");
    const makerLocked = { ...empty, base: { exists: true, settled: false, amountOk: true } };
    expect(swapSteps({ ...base, role: "taker", lock: makerLocked, hasSecret: false }).next).toBe("taker-lock");
  });

  it("refuses a late taker lock that would leave less than an hour", () => {
    const makerLocked = { ...empty, base: { exists: true, settled: false, amountOk: true } };
    const late = { ...base, nowSec: takerTimeout - 1800 };
    expect(swapSteps({ ...late, role: "taker", lock: makerLocked, hasSecret: false }).next).toBe("too-late");
  });

  it("walks maker claim, then taker claim, then done", () => {
    const bothLocked = {
      bch: { funded: true, spent: false, amountOk: true },
      base: { exists: true, settled: false, amountOk: true },
    };
    expect(swapSteps({ ...base, role: "maker", lock: bothLocked, hasSecret: true }).next).toBe("maker-claim");
    const makerClaimed = { ...bothLocked, bch: { funded: false, spent: true, amountOk: false } };
    expect(swapSteps({ ...base, role: "taker", lock: makerClaimed, hasSecret: true }).next).toBe("taker-claim");
    const allDone = { ...makerClaimed, base: { exists: true, settled: true, amountOk: true } };
    expect(swapSteps({ ...base, role: "taker", lock: allDone, hasSecret: true }).next).toBe("done");
  });

  it("offers a refund only to the owner of an expired, unclaimed lock", () => {
    const makerLocked = { ...empty, base: { exists: true, settled: false, amountOk: true } };
    const expired = { ...base, nowSec: makerTimeout + 1 };
    expect(swapSteps({ ...expired, role: "maker", lock: makerLocked, hasSecret: true }).canRefund).toBe(true);
    expect(swapSteps({ ...expired, role: "taker", lock: makerLocked, hasSecret: false }).canRefund).toBe(false);
  });
});
