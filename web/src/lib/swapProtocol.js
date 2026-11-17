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
