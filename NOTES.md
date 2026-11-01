# blaze-swap: learning prototype (28 Oct 2026, before BLAZE)

Learning notes from 28 Oct. Since 1 Nov 2026 this folder is the pre-hackathon base of the BLAZE project (README.md):
BLAZE allows work before 14 Nov and scores only the build week.
The tests run against local mocks; bch/scripts/chipnet-demo.mjs uses chipnet.

- `bch/SwapLock.cash` (CashScript 0.14): holds BCH or a CashToken (PUSD) until the recipient reveals a 32-byte secret
  whose sha256 matches, or the timeout (locktime) passes and the sender refunds. `cd bch && npm test` → 7 tests.
- `evm/contracts/SwapLock.sol` (Solidity 0.8.28, Hardhat 3): the same lock for an ERC-20 (USDC on Base). Claim only
  before the timeout, refund only after; the secret is published in the Claimed event. `cd evm && npx hardhat test` → 7 tests.

Swap order (buyer has USDC on Base, wants PUSD on BCH): seller picks the secret, locks PUSD on BCH with the LONGER
timeout; buyer checks it and locks USDC on Base for the seller with the SHORTER timeout under the same hash; seller
claims the USDC, which publishes the secret; buyer uses it to claim the PUSD before the BCH timeout.

Open for 14 Nov: real PUSD category id + chipnet/mainnet test, WizardConnect + WalletConnect front end, a watcher that
completes the second claim automatically, timeouts in time vs blocks on each chain, MUSD and other EVM chains.
