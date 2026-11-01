import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { network } from "hardhat";
import { toHex } from "viem";

const { viem, networkHelpers } = await network.connect();
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

// A fresh swap: the seller locks 0.10 USDC for the buyer under the hash of a 32-byte secret.
async function setup() {
  const [seller, buyer, stranger] = await viem.getWalletClients();
  const usdc = await viem.deployContract("TestUSDC");
  const swap = await viem.deployContract("SwapLock");
  await usdc.write.mint([seller.account.address, USDC(1)]);
  await usdc.write.approve([swap.address, USDC(0.1)], { account: seller.account });
  const secret = randomBytes(32);
  const secretHash = toHex(createHash("sha256").update(secret).digest());
  const timeout = BigInt(await networkHelpers.time.latest()) + 3600n;
  const terms = [usdc.address, buyer.account.address, USDC(0.1), secretHash, timeout] as const;
  await swap.write.lock(terms, { account: seller.account });
  const id = await swap.read.lockId([usdc.address, seller.account.address, ...terms.slice(1)] as any);
  return { usdc, swap, seller, buyer, stranger, secret: toHex(secret), id, timeout };
}

describe("SwapLock", () => {
  it("anyone can submit the right secret and the USDC goes to the recipient", async () => {
    const { usdc, swap, buyer, stranger, secret, id } = await setup();
    await swap.write.claim([id, secret], { account: stranger.account });
    assert.equal(await usdc.read.balanceOf([buyer.account.address]), USDC(0.1));
    assert.equal(await usdc.read.balanceOf([stranger.account.address]), 0n);
  });

  it("a wrong secret is refused", async () => {
    const { swap, buyer, id } = await setup();
    await assert.rejects(swap.write.claim([id, toHex(randomBytes(32))], { account: buyer.account }), /WrongSecret/);
  });

  it("no claim after the timeout, so the secret cannot be used once the sender may refund", async () => {
    const { swap, buyer, secret, id, timeout } = await setup();
    await networkHelpers.time.increaseTo(timeout);
    await assert.rejects(swap.write.claim([id, secret], { account: buyer.account }), /Expired/);
  });

  it("no refund before the timeout", async () => {
    const { swap, seller, id } = await setup();
    await assert.rejects(swap.write.refund([id], { account: seller.account }), /NotExpired/);
  });

  it("after the timeout the USDC goes back to the sender, whoever calls", async () => {
    const { usdc, swap, seller, stranger, id, timeout } = await setup();
    await networkHelpers.time.increaseTo(timeout);
    await swap.write.refund([id], { account: stranger.account });
    assert.equal(await usdc.read.balanceOf([seller.account.address]), USDC(1));
  });

  it("a settled lock cannot pay twice", async () => {
    const { swap, buyer, secret, id, timeout } = await setup();
    await swap.write.claim([id, secret], { account: buyer.account });
    await assert.rejects(swap.write.claim([id, secret], { account: buyer.account }), /AlreadySettled/);
    await networkHelpers.time.increaseTo(timeout);
    await assert.rejects(swap.write.refund([id]), /AlreadySettled/);
  });

  it("the secret is published in the Claimed event, so the other side can take its coins", async () => {
    const { swap, buyer, secret, id } = await setup();
    await swap.write.claim([id, secret], { account: buyer.account });
    const [ev] = await swap.getEvents.Claimed();
    assert.equal(ev.args.id, id);
    assert.equal(ev.args.secret, secret);
  });
});
