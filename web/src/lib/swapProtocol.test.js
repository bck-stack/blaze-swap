import { describe, expect, it } from "vitest";
import {
  BLAZE_COMPLIANCE,
  NETWORK_CONFIG,
  computeEvmLockId,
  computePairedTimeouts,
  decodeCashAddressPkh,
  derivePkhAndAddressesFromPubkey,
  formatTokenUnits,
  generateSecretPair,
  hexToBytes,
  normalizeHex32,
  parseTokenUnits,
  sha256Hex,
} from "./swapProtocol.js";

describe("swapProtocol", () => {
  it("generates a 32-byte secret and matching sha256 hash", async () => {
    const { secret, secretHash } = await generateSecretPair();
    expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(secretHash).toMatch(/^0x[0-9a-f]{64}$/);
    const recomputed = await sha256Hex(hexToBytes(secret));
    expect(recomputed).toBe(secretHash);
  });

  it("derives valid mainnet & chipnet CashAddresses and decodes PKH symmetrically", () => {
    const dummyPubkey = hexToBytes(
      "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    );
    const mainnet = derivePkhAndAddressesFromPubkey(dummyPubkey, "mainnet");
    expect(mainnet.cashAddress.startsWith("bitcoincash:q")).toBe(true);
    expect(mainnet.tokenAddress.startsWith("bitcoincash:z")).toBe(true);
    expect(decodeCashAddressPkh(mainnet.cashAddress)).toBe(mainnet.pkhHex);
    expect(decodeCashAddressPkh(mainnet.tokenAddress)).toBe(mainnet.pkhHex);

    const chipnet = derivePkhAndAddressesFromPubkey(dummyPubkey, "chipnet");
    expect(chipnet.cashAddress.startsWith("bchtest:q")).toBe(true);
    expect(chipnet.tokenAddress.startsWith("bchtest:z")).toBe(true);
    expect(decodeCashAddressPkh(chipnet.tokenAddress)).toBe(chipnet.pkhHex);
  });

  it("parses and formats token units without precision loss", () => {
    expect(parseTokenUnits("10.5", 2)).toBe(1050n);
    expect(parseTokenUnits("25.123456", 6)).toBe(25_123_456n);
    expect(formatTokenUnits(1050n, 2)).toBe("10.5");
    expect(formatTokenUnits(25_000_000n, 6)).toBe("25");
  });

  it("computes Solidity-matching EVM lockId and paired timeouts", () => {
    const id = computeEvmLockId({
      token: NETWORK_CONFIG.mainnet.evmUsdcAddress,
      sender: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: 10_000_000n,
      secretHash: "0x" + "aa".repeat(32),
      timeout: 1800000000,
    });
    expect(id).toBe(
      "0x62737d53bac4648e86287a8f068b3933c56503a77ec1c10968126f828a759647"
    );

    const { makerTimeout, takerTimeout } = computePairedTimeouts(1760000000, 12, 4);
    expect(makerTimeout).toBe(1760000000 + 12 * 3600);
    expect(takerTimeout).toBe(1760000000 + 4 * 3600);
    expect(makerTimeout).toBeGreaterThan(takerTimeout);
  });

  it("validates 32-byte hex values and BLAZE CashTokens donation address", () => {
    expect(normalizeHex32("aa".repeat(32))).toBe("0x" + "aa".repeat(32));
    expect(() => normalizeHex32("0x1234")).toThrow();
    expect(BLAZE_COMPLIANCE.donationAddress.startsWith("bitcoincash:z")).toBe(true);
    expect(decodeCashAddressPkh(BLAZE_COMPLIANCE.donationAddress)).toMatch(
      /^0x[0-9a-f]{40}$/
    );
  });
});
