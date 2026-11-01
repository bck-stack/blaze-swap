// Chipnet test wallet helpers. The wallet file (WIF and addresses) lives outside the repo; its path is the first
// argument or BLAZE_WALLET. Nothing here prints the WIF.
import { readFileSync } from "node:fs";
import { ElectrumNetworkProvider } from "cashscript";
import { decodePrivateKeyWif, secp256k1, hash160 } from "@bitauth/libauth";

export function loadWallet(path = process.argv[2] ?? process.env.BLAZE_WALLET) {
  if (!path) throw new Error("wallet file path missing (argument or BLAZE_WALLET)");
  const env = Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
  const decoded = decodePrivateKeyWif(env.CHIPNET_WIF);
  if (typeof decoded === "string") throw new Error(`bad WIF: ${decoded}`);
  const priv = decoded.privateKey;
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  return { priv, pub, pkh: hash160(pub), address: env.CHIPNET_ADDRESS, tokenAddress: env.CHIPNET_TOKEN_ADDRESS };
}

// chipnet.imaginary.cash was the only chipnet Electrum server that answered on 29 Oct 2026.
export const chipnet = () => new ElectrumNetworkProvider("chipnet", { hostname: "chipnet.imaginary.cash" });
