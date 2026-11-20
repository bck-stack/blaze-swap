# BLAZE Swap

Bitcoin Cash and USDC on Base, swapped both ways in about ten seconds. Pay PUSD (ParyonUSD) or plain BCH from your
Bitcoin Cash wallet with one signature and the USDC is at your Base address; or lock USDC on Base and PUSD or BCH
arrives in your Bitcoin Cash wallet. No bridge and no custodian sit in between: two contracts, one on each chain, open
with the same key, and the key never leaves your browser until the other side is locked for you.

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/2412), Mainnet track (Stablecoin Bridge).

- Live app: https://bck-stack.github.io/blaze-swap/
- Slides: https://docs.google.com/presentation/d/1HdeE75unpU8LzudUO_zLxLNdqm_7vt2Nj27XM1ON9dE/edit?usp=sharing
- Before the build week (14 Nov): code https://github.com/bck-stack/blaze-swap/tree/nov14, demo https://bck-stack.github.io/blaze-swap-nov14/
- Desk API: https://blaze-desk.launch-engine.workers.dev/api/status

## Judge it in 90 seconds

| Check | Where | What you will see |
|---|---|---|
| A real swap, no wallet needed | [Live app](https://bck-stack.github.io/blaze-swap/) → "Watch a real mainnet swap" | the four steps replayed with their real timings, each with its transaction |
| Swap yourself | Live app → connect a BCH wallet (WizardConnect: Selene, Paytaca, Cashonize) → $0.05 → Swap | one signature; the progress fills in on both chains; USDC arrives on Base |
| The other way | Live app → ⇅ → connect a Base wallet → $0.05 → Swap | USDC locked on Base; PUSD or BCH arrives at your Bitcoin Cash address |
| No Base wallet | Live app → "Make an address in this browser" | a Base address whose key stays in your browser, with a button to copy it |
| The contracts | [`bch/SwapLockV2.cash`](bch/SwapLockV2.cash), [`evm/contracts/SwapLock.sol`](evm/contracts/SwapLock.sol) | 34 and 74 lines |
| Attacks and what stops them | [Why it is safe](#why-it-is-safe) | each row has a test |
| The tests | `npm test` in `bch`, `evm`, `web`, `desk` | 19 + 7 + 13 + 25 pass |

## How a swap runs

You are the maker: your page makes the 32-byte secret and locks first. The other side is the BLAZE Desk, a small
service that only ever puts money down after yours is on the network.

| Step | Chain | Who | What |
|---|---|---|---|
| 1 | Bitcoin Cash | you | one signature: your PUSD or BCH goes into a `SwapLockV2` that pays the desk only with your key, or pays you back after 3 hours |
| 2 | Base | desk | sees your lock on the network, locks the USDC for your address under the same hash, expiring after 1 hour |
| 3 | Base | desk, for you | your page reads that lock from Base itself (amount, recipient, hash, timeout) and only then gives the desk the key; the desk sends the claim and pays the gas, and the contract can only pay your address |
| 4 | Bitcoin Cash | desk | claims your lock with the same key, now public |

On mainnet this takes 4 to 20 seconds, most of it Base confirming two transactions.

The other way (USDC in, PUSD or BCH out) is the same dance with the chains swapped. You are still the maker:

| Step | Chain | Who | What |
|---|---|---|---|
| 1 | Base | you | your Base wallet allows and locks the USDC in `SwapLock.sol` for the desk under your hash, refundable to you after 3 hours |
| 2 | Bitcoin Cash | desk | reads your lock on Base, then funds a `SwapLockV2` that pays your address, expiring at least two hours before yours |
| 3 | Bitcoin Cash | desk, for you | your page finds the desk's coins at the contract address it rebuilt from the terms, and only then gives the key; the claim needs no signature, so the desk sends it (or the page does) and it can only pay your address |
| 4 | Base | desk | claims your USDC with the same key, only after your claim is out |

## Why it is safe

`SwapLockV2` (Bitcoin Cash) needs no signature on either path. Instead it fixes the only transaction that can spend it:
one input, one output, to the recipient (claim) or the owner (refund), with the same token category and amount, and at
most `maxFee` satoshis less. So anyone may broadcast it, and that is what lets the desk finish for you and lets anyone
send your refund.

| Someone tries to | What happens | Test |
|---|---|---|
| claim with a wrong secret | refused by the contract | `bch/test/swaplock-v2.test.js` |
| use the secret to pay themselves | refused: the output must be the recipient's | same |
| take part of the PUSD, or drop it | refused: token category and amount must match | same |
| pay themselves a big fee | refused: at most `maxFee` (2,000 sat) | same |
| add a second output or merge two locks | refused: one input, one output | same |
| refund before the timeout | refused (`tx.time`) | same |
| refund to anyone but the owner | refused | same |
| hand you a desk lock with the wrong amount or recipient | your page reads the lock on Base and keeps the key | `web/src/lib/desk.js` (`checkDeskLock`) |
| make the desk lock against a lock that is not there | the desk locks only after it reads your lock: amount, token, timeout | `desk/test/rules.test.js` |
| (other way) hand you a desk lock on Bitcoin Cash with the wrong terms | your page rebuilds the contract from the terms and checks the coins there | `web/src/lib/desk.js` (`checkDeskBchLock`) |
| (other way) take your USDC late, after you claimed at the last moment | the desk's BCH lock ends two hours before yours on Base: one hour of margin plus the hour by which BCH median time can trail the clock | `desk/test/reverse.test.js` |
| change a quote | quotes are HMAC-signed and expire after 10 minutes | same |

Mutation check: removing any one of the recipient, owner, fee, one-input, one-output, token-amount, timeout or secret
checks from the contract makes at least one of these tests fail.

If the desk never locks, your lock refunds to you after 3 hours, and the desk's cron broadcasts that refund (no
signature needed; the page has a button too). If you never hand over the key, the desk's Base lock refunds to the desk
after 1 hour, and yours still refunds to you.

## Business

The desk charges 0.5% and pays the network costs: the Base gas (about $0.004 a swap at today's prices) and, the other
way, the Bitcoin Cash fees. It runs on demo
liquidity now, so a swap is $0.05 to $0.25 and the desk stops at $3 a day. The same desk with real liquidity is a
market maker: it quotes, takes the spread, and never holds a customer's coins.

Who it is for: people and agents that hold BCH or PUSD and need USDC on Base, where most paid APIs for agents (x402)
settle. An agent with a BCH wallet can swap a few cents and pay for an API call on Base without a bridge.

## What is on mainnet

Swaps through the desk. The first two rows are a person using the live page from a phone wallet over WizardConnect
(one signature on the phone: Selene, then Paytaca); the next two were played by `bch/scripts/desk-smoke.mjs`:

| Pay | Receive | User lock (BCH) | Desk lock (Base) | USDC to user (Base) | Desk claim (BCH) | Time |
|---|---|---|---|---|---|---|
| 0.000265 BCH (Selene) | 0.050017 USDC | [d2fa4f70…6ddb](https://blockchair.com/bitcoin-cash/transaction/d2fa4f7097a783995224a0d9cc394a3fa42f419993b734e285d5bb6ae6626ddb) | [0x25cac8aa…1c09](https://basescan.org/tx/0x25cac8aaa68bf43eb8cbc42eaa61441c6c28ef552349dfeb51d3349d5ef41c09) | [0x65d02aad…1b26](https://basescan.org/tx/0x65d02aadf3d7fa26cbea27e267a47fbb037a8f64f4fca6448c5e24d7a2551b26) | [30c3b494…5b29](https://blockchair.com/bitcoin-cash/transaction/30c3b4941322a64376782a64473d77718d169614dc87709ae6c7324939dc5b29) | 4.2 s |
| 0.000267 BCH (Paytaca) | 0.049999 USDC | [b63271ce…bab8](https://blockchair.com/bitcoin-cash/transaction/b63271ce894c8f8693f30f895a11a9f39be6ca74ed15af2218784945cc04bab8) | [0xc4889ac0…824a](https://basescan.org/tx/0xc4889ac06b0085c066c672dd5682f1cb7098c2d22a0fa75d1a7a3e2801ba824a) | [0x57cc468c…cb6d](https://basescan.org/tx/0x57cc468c31a26bbf8ce82dde930dd6fc789c95b26a18dde3a312fbc2ca5ccb6d) | [8942dc8e…4559](https://blockchair.com/bitcoin-cash/transaction/8942dc8ed18609b092f7f61c2a54dcce4ea17f227e86485ab8c0d2897b934559) | 10.2 s |
| 0.05 PUSD | 0.04975 USDC | [694071db…68de](https://blockchair.com/bitcoin-cash/transaction/694071db72717b08952b1f75de7eaa43a64b7f5636b9af0870c3e6130c4568de) | [0x66d3787f…441b](https://basescan.org/tx/0x66d3787fc52c75c4f4ff1ef554aee6b38348697d6204231abe865aac46be441b) | [0x103aef62…5c9d](https://basescan.org/tx/0x103aef6217c926251eb0490f0783dedc59d5cad379eede509699f4ed92365c9d) | [2a88a173…ef17](https://blockchair.com/bitcoin-cash/transaction/2a88a1738c998f422cc7110647928e22b1c2ccf0e53363e6fa983dd02474ef17) | 11 s |
| 0.0003 BCH | 0.056202 USDC | [1893db19…1dd4](https://blockchair.com/bitcoin-cash/transaction/1893db199be795c41a55c0152ef3685bc5a2f9c1a5107cf3ba0d843a363f1dd4) | [0x66968799…72ac](https://basescan.org/tx/0x66968799b7e478210406cf50f50976b4928c6b4830c59dee600bcafbfc3972ac) | [0xd1898453…a134](https://basescan.org/tx/0xd1898453d6ef92e10bf1a7a4f0ec3fea2dd64e28899bbc41e51e22c8f9a2a134) | [d6411e08…d5bd](https://blockchair.com/bitcoin-cash/transaction/d6411e08dc9a41d58f2c0c2e77375476e949d12ea827e4f2bc9fd310fec1d5bd) | 19 s |

The desk claims (`2a88a173…`, `d6411e08…`) are SwapLockV2 claims with no signature: one input whose unlocking bytecode
is the secret and the redeem script, one output to the desk.

The other way, played by `desk/scripts/reverse-smoke.mjs` (the desk's own test wallets play the user):

| Pay | Receive | User lock (Base) | Desk lock (BCH, signed by the desk) | PUSD to user (BCH) | Desk claim (Base) | Time |
|---|---|---|---|---|---|---|
| 0.05025 USDC | 0.05 PUSD | [0xb26ff7aa…ac8a](https://basescan.org/tx/0xb26ff7aa4ae3907f71ae8fb42adc74260b2cf5c69c73a822252a54e09cc3ac8a) | [976dc3f6…c8c6](https://blockchair.com/bitcoin-cash/transaction/976dc3f6c11e79bb10f2995550e85d13b81a50061a956f57093c995468f9c8c6) | [be5bb767…4908](https://blockchair.com/bitcoin-cash/transaction/be5bb7674e16f03eae97c8b8a3148d9d77e0838260315e2c16286988c38e4908) | [0x1cbd07fd…ec30](https://basescan.org/tx/0x1cbd07fd77f2f525331d12b2cf21674e987997918de5c11bd0286ac8aab5ec30) | 7.3 s |

`SwapLock.sol` on Base: [`0xf66642c35cf4a36fcd7d3bcf87422791280f8901`](https://base.blockscout.com/address/0xf66642C35CF4A36FCD7d3Bcf87422791280F8901)
(source verified on Sourcify, exact match, and Blockscout). Earlier in the week, two person-to-person swaps with the
first contract version (signature-based): plain BCH on 17 Nov ([lock](https://basescan.org/tx/0xd350ad6f7239cc2206a16ae524c6edefab9935caa31b595ea3907358ce7f216b),
[claim](https://blockchair.com/bitcoin-cash/transaction/452e7b7cedc59ef6bdb891d42d05c9bf0370b30462744df17ac339952a6e73ea)) and PUSD on 18 Nov
([lock](https://basescan.org/tx/0xd19620f7f2766ceba2cc153c2eec279ae4acad125d153620f209ea05fc94a549),
[claim](https://blockchair.com/bitcoin-cash/transaction/7e5c671d8034865accbb75533be5ad53e95e19e6ef755b9629506e387c355b6c)).

## The desk

`desk/` is a Cloudflare Worker with a D1 table and a one-minute cron. Workers cannot compile WebAssembly at run time,
so the desk cannot load libauth. For claims and refunds it needs no crypto library: SwapLockV2 takes no signature, so
the desk rebuilds the contract from its terms, reads the lock from Electrum (Fulcrum over WebSocket) and broadcasts a
one-input, one-output spend. The other way, the desk funds a lock from its own coins and has to sign: it does that in
plain JavaScript (`desk/src/bchsign.js`: noble ECDSA with RFC 6979 nonces, the BCH signing serialization with
`SIGHASH_ALL | FORKID` and the CashTokens prefix). `desk/test/bchtx.test.js` and `desk/test/bchsign.test.js` check all
of it byte for byte against CashScript: the contract address, claims and refunds for PUSD and plain BCH, and the
desk's signed lock transactions with and without PUSD.

| Route | What it does |
|---|---|
| `GET /api/status` | desk addresses, liquidity on both chains, BCH price, limits |
| `POST /api/quote` | a signed quote: what you lock, what you get (`dir: "toBch"` for the other way) |
| `POST /api/take` | after your lock: checks it and locks its side (USDC on Base, or PUSD/BCH on Bitcoin Cash) |
| `POST /api/reveal` | your key: the desk sends your claim, then claims its side |
| `GET /api/swap/:hash`, `GET /api/recent` | swap records, used by the replay |

One thing learned on the way: Fulcrum hides token UTXOs from clients that have not negotiated protocol 1.5, so a
plain `listunspent` returned nothing for a PUSD lock. Every desk connection now starts with `server.version`.

## Peer to peer

The Peer to peer tab is the first version: two people swap with a share link that carries the terms (never the
secret), and each page rebuilds both locks from those terms before anyone locks.

## Built during the build week (14 to 22 Nov)

The `nov14` tag is where the week started: the two first contracts, their tests, a chipnet round-trip script and a page
that only connected a BCH wallet. Since then:

- the peer-to-peer page (share link, import as taker, four steps, refunds) and `SwapLock.sol` deployed to Base mainnet
- the first swaps across both mainnets (BCH 17 Nov, PUSD 18 Nov)
- `SwapLockV2.cash`, signature-free and covenant-checked, with 12 tests and a mutation check
- the BLAZE Desk (`desk/`), live on Cloudflare, and the Swap tab: one card, live progress on both chains, replays of
  real swaps, a Base address made in the browser for people without one
- desk swaps on mainnet with PUSD and with plain BCH, and from two phone wallets through the live page (Paytaca 10.2 s, Selene 4.2 s)
- the other way through the desk: USDC on Base in, PUSD or BCH out, with the desk signing its own BCH inputs in plain JavaScript; ⇅ on the card flips the direction
- found on the way: Selene sends its public keys a moment after the connection opens, so the page now waits for them
- found on the way: WizardConnect sends the sign request as relay JSON (transaction hex, BigInts as text), so the page now converts CashScript's request before sending; both the Swap and the Peer to peer flows use it

## Run it

```
cd bch && npm install && npm test          # 19 tests: SwapLock and SwapLockV2 on a local mock
cd evm && npm install && npx hardhat test  # 7 tests, SwapLock.sol
cd web && npm install && npm test          # 13 tests: lock id, offers, step logic
cd desk && npm install && npm test         # 25 tests: BCH encoding and signing vs CashScript, quotes, lock checks
cd web && npm run dev
```

## Limits

- PUSD is priced at $1 and BCH at the Coinbase spot price; the desk does not route through a market yet.
- The desk runs on demo liquidity: $0.05 to $0.25 a swap, $3 a day.
- The desk holds its Base key and its Bitcoin Cash key as Worker secrets; they only ever lock the desk's own coins,
  claim for users, and refund the desk.

## Contracts

- `bch/SwapLockV2.cash` (CashScript 0.14): `claim(secret)` and `refund()`, no signatures; the output is fixed by the covenant.
- `bch/SwapLock.cash`: the first version, signature-based (used by the Peer to peer tab).
- `evm/contracts/SwapLock.sol` (Solidity 0.8.28): the lock for an ERC-20. Anyone may submit a claim; the tokens always
  go to the recipient. The lock id is `keccak256(abi.encode(...))` of all terms.

CashTokens address for EMBER2026: `bitcoincash:zpue5yghv0f3f7860zvfslp76lagfa97eysjj4wsf0`

License: MIT
