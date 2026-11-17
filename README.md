# BLAZE Swap

Swap USDC on Base for ParyonUSD (PUSD) on Bitcoin Cash, person to person, with nobody holding the coins in between.
Both sides are locked under the same sha256 hash. Claiming one side puts the secret on chain, and that secret is what
unlocks the other side. If the other party walks away, each lock pays its owner back after its timeout.

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/2412), Mainnet track (Stablecoin Bridge).

- Live app: https://bck-stack.github.io/blaze-swap/
- Slides: https://docs.google.com/presentation/d/1HdeE75unpU8LzudUO_zLxLNdqm_7vt2Nj27XM1ON9dE/edit?usp=sharing
- Before the build week (14 Nov): code https://github.com/bck-stack/blaze-swap/tree/nov14, demo https://bck-stack.github.io/blaze-swap-nov14/

## Why

Base has most of the USDC that is easy to reach from an EVM wallet. Getting it into PUSD today means trusting a desk or a
bridge pool with your money for a while. We wanted the move to need no third party at all, so that anyone holding USDC
can become PUSD demand on BCH, and anyone holding PUSD can exit to Base, without asking anyone.

## How a swap runs

The maker picks the secret and creates the swap. The page derives both locks from the terms and gives a share link.

| Step | Who | Where | What |
|---|---|---|---|
| 1 | maker | Base (or BCH) | locks their side, timeout 12 h |
| 2 | taker | the other chain | opens the link, waits until the page sees the maker's lock with the right amount, locks their side, timeout 4 h |
| 3 | maker | taker's chain | claims; the claim reveals the secret on chain |
| 4 | taker | maker's chain | the page has already read the secret from step 3; one click claims |

The maker's lock always outlives the taker's by 8 hours, so the taker has time to claim after the secret appears. If
nobody claims, the "Refund" button shows up for the owner once their lock expires.

Things we decided on purpose:

- **The share link carries terms, not addresses to trust.** The taker's page rebuilds the BCH contract address and the
  Base lock id from the amounts, hash, parties and timeouts. A tampered link derives locks that are simply empty, and
  the page will not tell the taker to lock until the maker's lock is really there with the agreed amount.
- **Unsafe offers are refused.** If the maker's timeout is not at least 2 hours after the taker's, the link is
  rejected. If less than an hour is left on the taker's window, the page says not to lock.
- **The watcher runs in the browser.** It checks Electrum and Base RPC every 6 seconds and only scans for the secret
  once a lock has been spent, so no server or relayer is involved.
- **Anyone can submit the Base claim.** `SwapLock.sol` always pays the recipient, so a third party could pay the gas.

## What is on mainnet

`SwapLock.sol` on Base: [`0xf66642c35cf4a36fcd7d3bcf87422791280f8901`](https://base.blockscout.com/address/0xf66642C35CF4A36FCD7d3Bcf87422791280F8901)
(source verified on Sourcify, exact match, and Blockscout).

| What | Transaction |
|---|---|
| Deploy | [0xd3e8ba9c…dd46b](https://basescan.org/tx/0xd3e8ba9cdf673271ec88cb5b85ccefcd5d57afdedcaa5ac5b61019a8391dd46b) |
| Approve 0.05 USDC | [0xa62e829e…68f4](https://basescan.org/tx/0xa62e829eb4127dacf65c0b01a20d0b56a95556574d3628028187f42e52f368f4) |
| Lock | [0x9d2c64da…bbe6](https://basescan.org/tx/0x9d2c64dada3e465ff4c5567e9fc35c88f3a5c9795d46b3fd05b44e3aa071bbe6) |
| Claim with the secret | [0x1a3c0b8e…1d1c](https://basescan.org/tx/0x1a3c0b8e98f14e7dda9df90365a04e08deac7217946e4d0b722c1620a71e1d1c) |

`web/scripts/mainnet-swap.mjs` runs a whole swap across both mainnets (USDC lock on Base, PUSD lock on BCH, BCH claim,
secret read back from the BCH claim, Base claim) with one operator holding both wallets.

## Built during the build week (14 to 22 Nov)

The `nov14` tag is where the week started: the two contracts, their tests, a chipnet round-trip script and a page that
only connected a BCH wallet. Since then:

- the swap page: create, share link, import as taker, the four steps with the next action for your role, refunds
- the Base side over the browser wallet (approve, lock, claim, refund) and `SwapLock.sol` deployed to Base mainnet
- the watcher on both chains (Base `Claimed` logs, BCH unlocking bytecode) that picks up the secret for the taker
- BCH transactions signed through WizardConnect with fees sized from the inputs, token change kept, NFT UTXOs skipped
- a fix found in review: the page derived the Base lock id with `encodePacked` while the contract uses `abi.encode`,
  so the taker would have looked for a lock that never exists; a test now pins the id to the contract's output
- `mainnet-swap.mjs`, the deploy script and the Base proof transactions above

## Run it

```
cd bch && npm install && npm test          # 7 tests, CashScript contract on a local mock
cd evm && npm install && npx hardhat test  # 7 tests, SwapLock.sol
cd web && npm install && npm test          # 13 tests: lock id, offers, step logic
cd web && npm run dev
```

The network switch also has BCH chipnet with Base Sepolia. The chipnet contract works with the PUSD test token; for the
Base Sepolia side, deploy `SwapLock.sol` with `evm/scripts/deploy.mjs --network baseSepolia` and paste its address in
Config.

## Limits

- One price: 1 PUSD for 1 USDC. A spread or quote would be a small addition to the offer terms.
- Takers find makers through the share link; there is no order board yet.
- Swaps live in the browser's storage. Clearing it loses the secret of an open swap you made, so the page should not be
  cleared mid-swap (the locks still refund after their timeouts).

## Contracts

- `bch/SwapLock.cash` (CashScript 0.14): holds BCH or a CashToken until the recipient shows a 32-byte secret whose
  sha256 matches, or `tx.time` passes the timeout and the sender takes it back.
- `evm/contracts/SwapLock.sol` (Solidity 0.8.28): the same lock for an ERC-20. The lock id is `keccak256(abi.encode(...))`
  of all terms, so the other side can recompute it before locking.

CashTokens address for EMBER2026: `bitcoincash:zpue5yghv0f3f7860zvfslp76lagfa97eysjj4wsf0`

License: MIT
