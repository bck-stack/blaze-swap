# BCH Stablecoin Swap

Trustless swaps between a Bitcoin Cash stablecoin (PUSD, a CashToken) and USDC on Base: the same sha256 hash locks
both sides, so revealing the secret to claim one side lets the other side be claimed too. Nobody holds the funds in
between; if either side walks away, each lock returns its coins after its timeout.

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/2412) (Stablecoin Bridge bounty).

## Pre-hackathon base (before 14 Nov 2026)

BLAZE allows work before the build week; judges score only what is built from 14 to 22 Nov. This base was prepared
before then and is tagged `nov14` when the build week starts:

- `bch/SwapLock.cash` (CashScript 0.14): the BCH side. Holds BCH or a CashToken until the recipient reveals a 32-byte
  secret whose sha256 matches, or the timeout passes and the sender refunds. `cd bch && npm test` (7 tests, local mock).
- `evm/contracts/SwapLock.sol` (Solidity 0.8.28, Hardhat 3): the same lock for an ERC-20 such as USDC on Base.
  `cd evm && npx hardhat test` (7 tests).
- `bch/scripts/chipnet-demo.mjs`: real lock → claim and lock → refund round trips on chipnet with PUSD-test.
- `web/`: a Vite + React page with the BCH wallet connection over WizardConnect only.

Not in the base (the build week): the swap flow in the page, the Base side over WalletConnect, the watcher that
completes the second claim, mainnet transactions, more stablecoins and chains.

## Run

```
cd bch && npm install && npm test
cd evm && npm install && npx hardhat test
cd web && npm install && npm run dev
```

Chipnet round trip (needs a test wallet file with CHIPNET_WIF, CHIPNET_ADDRESS, CHIPNET_TOKEN_ADDRESS; never commit it):

```
cd bch && node scripts/chipnet-demo.mjs <wallet file> claim
cd bch && node scripts/chipnet-demo.mjs <wallet file> refund
```
