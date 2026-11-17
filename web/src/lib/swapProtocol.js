import {
  CashAddressType,
  decodeCashAddress,
  encodeCashAddress,
  hash160,
} from "@bitauth/libauth";
import { encodeAbiParameters, keccak256 } from "viem";

export const NETWORK_CONFIG = {
  mainnet: {
    id: "mainnet",
    label: "BCH Mainnet ↔ Base",
    bchNetwork: "mainnet",
    bchPrefix: "bitcoincash",
    electrumHost: "electrum.imaginary.cash",
    pusdCategory:
      "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544",
    pusdSymbol: "PUSD",
    pusdDecimals: 2,
    bchExplorerTx: "https://blockchair.com/bitcoin-cash/transaction/",
    bchExplorerAddr: "https://blockchair.com/bitcoin-cash/address/",
    evmChainId: 8453,
    evmChainName: "Base",
    evmRpcUrl: "https://mainnet.base.org",
    evmExplorerTx: "https://basescan.org/tx/",
    evmUsdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    evmUsdcSymbol: "USDC",
    evmUsdcDecimals: 6,
    defaultSwapLockAddress:
      import.meta.env.VITE_SWAP_LOCK_BASE ||
      "0xf66642c35cf4a36fcd7d3bcf87422791280f8901",
  },
  chipnet: {
    id: "chipnet",
    label: "BCH Chipnet ↔ Base Sepolia",
    bchNetwork: "chipnet",
    bchPrefix: "bchtest",
    electrumHost: "chipnet.imaginary.cash",
    pusdCategory:
      "dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b",
    pusdSymbol: "PUSD-test",
    pusdDecimals: 2,
    bchExplorerTx: "https://chipnet.imaginary.cash/tx/",
    bchExplorerAddr: "https://chipnet.imaginary.cash/address/",
    evmChainId: 84532,
    evmChainName: "Base Sepolia",
    evmRpcUrl: "https://sepolia.base.org",
    evmExplorerTx: "https://sepolia.basescan.org/tx/",
    evmUsdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    evmUsdcSymbol: "USDC",
    evmUsdcDecimals: 6,
    defaultSwapLockAddress: import.meta.env.VITE_SWAP_LOCK_BASE_SEPOLIA || "",
  },
};

export const BLAZE_COMPLIANCE = {
  preDemoUrl: "https://bck-stack.github.io/blaze-swap-nov14/",
  preCodeUrl: "https://github.com/bck-stack/blaze-swap-nov14",
  liveDemoUrl:
    import.meta.env.VITE_LIVE_DEMO_URL ||
    "https://bck-stack.github.io/blaze-swap/",
  liveCodeUrl: "https://github.com/bck-stack/blaze-swap",
  slidesUrl:
    import.meta.env.VITE_SLIDES_URL ||
    "https://docs.google.com/presentation/d/1HdeE75unpU8LzudUO_zLxLNdqm_7vt2Nj27XM1ON9dE/edit?usp=sharing",
  donationAddress:
    import.meta.env.VITE_EMBER_DONATION_ADDR ||
    "bitcoincash:zpue5yghv0f3f7860zvfslp76lagfa97eysjj4wsf0",
};

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function normalizeHex32(hex) {
  const clean = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error("Expected 32-byte (64-hex-char) value");
  }
  return `0x${clean}`;
}

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `0x${bytesToHex(new Uint8Array(digest))}`;
}

export async function generateSecretPair() {
  const secretBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(secretBytes);
  const secret = `0x${bytesToHex(secretBytes)}`;
  const secretHash = await sha256Hex(secretBytes);
  return { secret, secretHash };
}

export function derivePkhAndAddressesFromPubkey(pubkeyBytes, networkId = "mainnet") {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  const pkh = hash160(pubkeyBytes);
  const p2pkh = encodeCashAddress({
    prefix: cfg.bchPrefix,
    type: CashAddressType.p2pkh,
    payload: pkh,
  });
  const tokenAddress = encodeCashAddress({
    prefix: cfg.bchPrefix,
    type: CashAddressType.p2pkhWithTokens,
    payload: pkh,
  });
  return {
    pkhHex: `0x${bytesToHex(pkh)}`,
    pkhBytes: pkh,
    cashAddress: typeof p2pkh === "string" ? p2pkh : p2pkh.address,
    tokenAddress:
      typeof tokenAddress === "string" ? tokenAddress : tokenAddress.address,
  };
}

export function decodeCashAddressPkh(address) {
  const decoded = decodeCashAddress(address.trim());
  if (typeof decoded === "string") {
    throw new Error(`Invalid CashAddress: ${decoded}`);
  }
  if (decoded.payload.length !== 20) {
    throw new Error("Expected a 20-byte PKH CashAddress (q... or z...)");
  }
  return `0x${bytesToHex(decoded.payload)}`;
}

export function computeEvmLockId({
  token,
  sender,
  recipient,
  amount,
  secretHash,
  timeout,
}) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [
        token,
        sender,
        recipient,
        BigInt(amount),
        normalizeHex32(secretHash),
        BigInt(timeout),
      ]
    )
  );
}

export function parseTokenUnits(input, decimals) {
  const clean = String(input ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) {
    throw new Error("Enter a valid positive amount");
  }
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > decimals) {
    throw new Error(`Maximum ${decimals} decimal places supported`);
  }
  const paddedFrac = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
}

export function formatTokenUnits(amount, decimals) {
  const val = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = val / base;
  const frac = (val % base).toString().padStart(decimals, "0");
  const trimmedFrac = frac.replace(/0+$/, "");
  return trimmedFrac ? `${whole}.${trimmedFrac}` : `${whole}`;
}

export function computePairedTimeouts(
  nowSec = Math.floor(Date.now() / 1000),
  makerHours = 12,
  takerHours = 4
) {
  const base = Math.max(Math.floor(nowSec), 500_000_000);
  return {
    makerTimeout: base + makerHours * 3600,
    takerTimeout: base + takerHours * 3600,
  };
}

const STORAGE_KEY = "blaze_swap_sessions_v1";

export function loadSwaps() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveSwaps(swaps) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(swaps));
  } catch {
    // Ignore storage quota issues in restricted browsers
  }
}

// --- Sharing a swap with the counterparty -------------------------------------------------------------------------
// The maker sends the taker a link that carries every public parameter of the swap (never the secret). The taker's
// page recomputes the BCH contract address and the Base lock id from those parameters instead of trusting any address
// in the link, so a tampered link derives locks the taker can see are empty.

const OFFER_FIELDS = [
  "networkId",
  "direction",
  "displayAmount",
  "pusdUnits",
  "usdcUnits",
  "secretHash",
  "bchRecipientAddr",
  "bchRefundAddr",
  "bchTimeout",
  "evmSenderAddr",
  "evmRecipientAddr",
  "evmTimeout",
  "evmContractAddr",
];

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64) {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const bin = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeOffer(swap) {
  const offer = { v: 1 };
  for (const k of OFFER_FIELDS) offer[k] = swap[k];
  return toBase64Url(JSON.stringify(offer));
}

export function decodeOffer(encoded) {
  let offer;
  try {
    offer = JSON.parse(fromBase64Url(String(encoded).trim()));
  } catch {
    throw new Error("This offer link is damaged.");
  }
  if (offer?.v !== 1) throw new Error("Unsupported offer version.");
  if (!NETWORK_CONFIG[offer.networkId]) throw new Error("Unknown network in offer.");
  if (!["BASE_TO_BCH", "BCH_TO_BASE"].includes(offer.direction)) throw new Error("Unknown swap direction.");
  const cfg = NETWORK_CONFIG[offer.networkId];
  const out = {
    networkId: offer.networkId,
    direction: offer.direction,
    displayAmount: String(offer.displayAmount),
    pusdUnits: BigInt(offer.pusdUnits).toString(),
    usdcUnits: BigInt(offer.usdcUnits).toString(),
    secretHash: normalizeHex32(offer.secretHash),
    bchRecipientAddr: String(offer.bchRecipientAddr),
    bchRefundAddr: String(offer.bchRefundAddr),
    bchTimeout: Number(offer.bchTimeout),
    evmSenderAddr: String(offer.evmSenderAddr),
    evmRecipientAddr: String(offer.evmRecipientAddr),
    evmTimeout: Number(offer.evmTimeout),
    evmContractAddr: String(offer.evmContractAddr || cfg.defaultSwapLockAddress || ""),
  };
  if (BigInt(out.pusdUnits) <= 0n || BigInt(out.usdcUnits) <= 0n) throw new Error("Offer amount must be positive.");
  for (const a of [out.bchRecipientAddr, out.bchRefundAddr]) {
    if (!a.startsWith(`${cfg.bchPrefix}:`)) throw new Error(`BCH address is not on ${cfg.label}.`);
  }
  for (const a of [out.evmSenderAddr, out.evmRecipientAddr]) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("Base address in offer is malformed.");
  }
  out.bchRecipientPkh = decodeCashAddressPkh(out.bchRecipientAddr);
  out.bchRefundPkh = decodeCashAddressPkh(out.bchRefundAddr);
  out.evmLockId = computeEvmLockId({
    token: cfg.evmUsdcAddress,
    sender: out.evmSenderAddr,
    recipient: out.evmRecipientAddr,
    amount: BigInt(out.usdcUnits),
    secretHash: out.secretHash,
    timeout: out.evmTimeout,
  });
  // The maker's lock must outlive the taker's, or the maker could claim and then also refund.
  const makerTimeout = out.direction === "BASE_TO_BCH" ? out.evmTimeout : out.bchTimeout;
  const takerTimeout = out.direction === "BASE_TO_BCH" ? out.bchTimeout : out.evmTimeout;
  if (makerTimeout - takerTimeout < 2 * 3600) {
    throw new Error("Unsafe offer: the maker's lock must expire at least 2 hours after the taker's.");
  }
  return out;
}

// Which chain each role locks on. The maker holds the secret and locks first, with the longer timeout.
export function swapLegs(direction) {
  return direction === "BASE_TO_BCH"
    ? { makerChain: "base", takerChain: "bch" }
    : { makerChain: "bch", takerChain: "base" };
}

// Minimum time the taker should have left on its own lock when it locks: the maker must still claim it, and the taker
// then needs the remaining window to claim the other side.
export const TAKER_MIN_WINDOW_SEC = 3600;

// Turns the live lock states into the four steps of the swap, with what this user should do next.
// lock = { bch: { funded, amountOk, spent }, base: { exists, amountOk, settled } }
export function swapSteps({ role, direction, lock, hasSecret, nowSec, bchTimeout, evmTimeout }) {
  const { makerChain, takerChain } = swapLegs(direction);
  const sideState = (chain) => {
    if (chain === "bch") {
      return { locked: !!lock.bch?.funded && !!lock.bch?.amountOk, spent: !!lock.bch?.spent };
    }
    return { locked: !!lock.base?.exists && !!lock.base?.amountOk && !lock.base?.settled, spent: !!lock.base?.settled };
  };
  const maker = sideState(makerChain);
  const taker = sideState(takerChain);
  const takerTimeout = takerChain === "bch" ? bchTimeout : evmTimeout;
  const makerTimeout = makerChain === "bch" ? bchTimeout : evmTimeout;

  const steps = [
    { key: "maker-lock", who: "maker", chain: makerChain, label: "Maker locks", done: maker.locked || maker.spent },
    { key: "taker-lock", who: "taker", chain: takerChain, label: "Taker checks it and locks", done: taker.locked || taker.spent },
    { key: "maker-claim", who: "maker", chain: takerChain, label: "Maker claims (reveals the secret)", done: taker.spent && hasSecret },
    { key: "taker-claim", who: "taker", chain: makerChain, label: "Taker claims with the secret", done: maker.spent && !maker.locked },
  ];
  const current = steps.find((s) => !s.done) || null;

  let next = "done";
  if (current) {
    if (current.who !== role) next = "wait";
    else next = current.key;
  }
  // Safety rails for the taker before it puts money in.
  if (next === "taker-lock" && nowSec > takerTimeout - TAKER_MIN_WINDOW_SEC) next = "too-late";
  // Refunds open after each side's timeout if the swap stalled.
  const canRefund =
    (role === "maker" && maker.locked && nowSec >= makerTimeout) ||
    (role === "taker" && taker.locked && nowSec >= takerTimeout);
  return { steps, current: current?.key || null, next, canRefund };
}
