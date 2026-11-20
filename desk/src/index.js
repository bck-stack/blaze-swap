// BLAZE Desk: the automatic other side of a BLAZE swap, so one person with one BCH wallet can swap on their own.
//
// The user stays the maker: they pick the secret and lock first, on Bitcoin Cash, in a SwapLockV2 that pays the desk.
// The desk locks USDC on Base for them only after it sees that lock on the network. When the user's page hands over
// the secret, the desk broadcasts the Base claim for them (the USDC can only go to the user, the desk pays the gas),
// then claims its BCH side with the same secret. If anything stalls, both locks pay their owners back after their
// timeouts, and the desk's cron broadcasts the user's refund too (SwapLockV2 refunds need no signature).
//
// Routes: GET /api/status · POST /api/quote · POST /api/take · POST /api/reveal · GET /api/swap/:hash · GET /api/recent
import { createPublicClient, createWalletClient, encodeAbiParameters, fallback, http, keccak256, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  binToHex,
  claimUnlocking,
  electrumScripthash,
  hexToBin,
  p2sh32LockingBytecode,
  refundUnlocking,
  sha256,
  spendLockTx,
  swapLockV2Redeem,
  txid as txidOf,
} from "./bchtx.js";
import { PUSD_CATEGORY, RULES, SWAP_LOCK_BASE, USDC_BASE, checkUserLock, priceQuote, signQuote, verifyQuote } from "./rules.js";

const ELECTRUM = ["https://electrum.imaginary.cash:50004", "https://bch.imaginary.cash:50004", "https://bch.loping.net:50004", "https://fulcrum.greyh.at:50004"];
const SWAP_LOCK_ABI = [
  { type: "function", name: "lock", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [] },
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "locks", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }, { type: "bool" }] },
];
const ERC20_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const CLAIMED = parseAbiItem("event Claimed(bytes32 indexed id, bytes32 secret)");

const now = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" },
  });
const fail = (message, status = 400, extra = {}) => json({ ok: false, error: message, ...extra }, status);
const isHex = (s, bytes) => typeof s === "string" && new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`).test(s);
const strip0x = (s) => s.replace(/^0x/, "").toLowerCase();

// --- Bitcoin Cash over Electrum (WebSocket from the Worker) -------------------------------------------------------
async function electrum(calls) {
  let lastError;
  for (const url of ELECTRUM) {
    try {
      const resp = await fetch(url, { headers: { Upgrade: "websocket" } });
      const ws = resp.webSocket;
      if (!ws) throw new Error(`no websocket (${resp.status})`);
      ws.accept();
      const pending = new Map();
      // Fulcrum sends one JSON-RPC message per WebSocket frame (sometimes with a trailing newline).
      ws.addEventListener("message", (e) => {
        for (const line of String(e.data).split("\n")) {
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.id == null) continue; // subscription notifications
          pending.get(m.id)?.(m);
          pending.delete(m.id);
        }
      });
      const results = [];
      let id = 0;
      // Fulcrum hides token UTXOs from clients that have not negotiated protocol 1.5 (so old wallets cannot burn
      // them by accident), so every connection starts with server.version.
      for (const [method, params] of [["server.version", ["blaze-desk", "1.5"]], ...calls]) {
        id += 1;
        const answered = new Promise((r) => pending.set(id, r));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        const reply = await Promise.race([
          answered,
          new Promise((_, rej) => setTimeout(() => rej(new Error(`electrum timeout: ${method}`)), 15000)),
        ]);
        if (reply.error) throw Object.assign(new Error(reply.error.message || JSON.stringify(reply.error)), { rpc: true });
        results.push(reply.result);
      }
      ws.close();
      return results.slice(1);
    } catch (err) {
      if (err.rpc) throw err; // the server answered: a node-level refusal, not a connection problem
      lastError = err;
    }
  }
  throw lastError;
}

async function contractFor(terms) {
  const redeem = swapLockV2Redeem(terms);
  const lockingBytecode = await p2sh32LockingBytecode(redeem);
  return { redeem, lockingBytecode, scripthash: await electrumScripthash(lockingBytecode) };
}

async function lockUtxo(scripthash) {
  const [list] = await electrum([["blockchain.scripthash.listunspent", [scripthash]]]);
  const u = (list || [])[0];
  if (!u) return null;
  const t = u.token_data;
  return {
    txid: u.tx_hash,
    vout: u.tx_pos,
    value: BigInt(u.value),
    height: u.height,
    token: t ? { category: t.category, amount: BigInt(t.amount || 0), nft: t.nft || undefined } : undefined,
  };
}

async function broadcast(raw) {
  const [res] = await electrum([["blockchain.transaction.broadcast", [binToHex(raw)]]]);
  return res;
}

// --- Base ----------------------------------------------------------------------------------------------------------
function baseClients(env) {
  // Public Base RPCs rate-limit shared Cloudflare IPs now and then, so try several in turn.
  const urls = [env.BASE_RPC_URL, "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base", "https://mainnet.base.org"].filter(Boolean);
  const transport = fallback(urls.map((u) => http(u, { retryCount: 1, timeout: 15_000 })));
  const account = privateKeyToAccount(env.DESK_EVM_KEY.startsWith("0x") ? env.DESK_EVM_KEY : `0x${env.DESK_EVM_KEY}`);
  return {
    account,
    pub: createPublicClient({ chain: base, transport }),
    wallet: createWalletClient({ chain: base, transport, account }),
  };
}

function lockIdOf({ sender, recipient, amount, secretHash, timeout }) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }],
      [USDC_BASE, sender, recipient, BigInt(amount), `0x${strip0x(secretHash)}`, BigInt(timeout)]
    )
  );
}

async function sendBase(env, functionName, args) {
  const { pub, wallet } = baseClients(env);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const hash = await wallet.writeContract({ address: SWAP_LOCK_BASE, abi: SWAP_LOCK_ABI, functionName, args });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 45_000 });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
      return hash;
    } catch (err) {
      lastErr = err;
      if (!/nonce|replacement|underpriced/i.test(String(err.message))) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

async function baseLockState(env, lockId) {
  const { pub } = baseClients(env);
  const r = await pub.readContract({ address: SWAP_LOCK_BASE, abi: SWAP_LOCK_ABI, functionName: "locks", args: [lockId] });
  return { exists: r[1] !== "0x0000000000000000000000000000000000000000", settled: r[6] };
}

async function secretFromBase(env, lockId) {
  const { pub } = baseClients(env);
  const latest = await pub.getBlockNumber();
  const logs = await pub.getLogs({ address: SWAP_LOCK_BASE, event: CLAIMED, args: { id: lockId }, fromBlock: latest - 5000n, toBlock: latest });
  return logs[0]?.args?.secret ? strip0x(logs[0].args.secret) : null;
}

// --- Prices --------------------------------------------------------------------------------------------------------
async function bchUsd() {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/BCH-USD/spot");
    const v = Number((await r.json())?.data?.amount);
    if (v > 0) return v;
  } catch {
    /* fall through */
  }
  try {
    const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=BCHUSD");
    const j = await r.json();
    const v = Number(Object.values(j.result || {})[0]?.c?.[0]);
    if (v > 0) return v;
  } catch {
    /* no price */
  }
  return 0;
}

// --- Storage (D1) --------------------------------------------------------------------------------------------------
async function getSwap(env, hash) {
  const row = await env.DB.prepare("SELECT data FROM swaps WHERE hash = ?").bind(hash).first();
  return row ? JSON.parse(row.data) : null;
}
async function putSwap(env, s) {
  s.updated = now();
  await env.DB.prepare(
    "INSERT INTO swaps (hash, state, data, created, updated) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(hash) DO UPDATE SET state = ?2, data = ?3, updated = ?5"
  )
    .bind(s.hash, s.state, JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v)), s.created, s.updated)
    .run();
}
const event = (s, step, extra = {}) => {
  s.events = s.events || [];
  s.events.push({ step, at: Date.now(), ...extra });
};
async function dailyCents(env) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT cents FROM daily WHERE day = ?").bind(day).first();
  return { day, cents: BigInt(row?.cents || 0) };
}
async function addDaily(env, cents) {
  const { day } = await dailyCents(env);
  await env.DB.prepare("INSERT INTO daily (day, cents) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET cents = cents + ?2").bind(day, Number(cents)).run();
}

// --- The swap ------------------------------------------------------------------------------------------------------
function termsOf(s, env) {
  return { recipientPkh: env.DESK_BCH_PKH, refundPkh: s.userPkh, secretHash: s.hash, timeout: BigInt(s.bchTimeout), maxFee: RULES.maxFee };
}

// Tries to move a swap forward: lock USDC once the user's BCH lock is there, claim BCH once the secret is known,
// refund whichever side has expired. Safe to call again and again (from /take, /reveal and the cron).
async function advance(env, s) {
  const c = await contractFor(termsOf(s, env));
  const t = now();

  // A /take that sent the Base lock but stopped before saving: the lock either exists (go on) or not (try again;
  // the contract refuses a second lock with the same terms, so a retry can never lock twice).
  if (s.state === "desk-locking") {
    const st = await baseLockState(env, s.lockId);
    if (st.exists) {
      event(s, "desk-locked", { recovered: true });
      s.state = "desk-locked";
    } else {
      s.state = "waiting-for-lock";
    }
  }

  if (s.state === "waiting-for-lock" || s.state === "refused") {
    const utxo = await lockUtxo(c.scripthash);
    if (s.state === "waiting-for-lock") {
      if (!utxo) {
        if (t > s.quote.expiresAt + 3600) s.state = "abandoned"; // never locked: nothing to do
        return s;
      }
      s.bchLockTx = utxo.txid;
      if (t > s.quote.expiresAt) {
        s.state = "refused";
        s.reason = "The lock arrived after the quote expired.";
      } else {
        const check = checkUserLock({ quote: { ...s.quote, lockSats: BigInt(s.quote.lockSats), payUnits: BigInt(s.quote.payUnits) }, utxo, bchTimeout: s.bchTimeout, nowSec: t });
        if (!check.ok) {
          s.state = "refused";
          s.reason = check.reason;
        } else {
          const { cents } = await dailyCents(env);
          if (cents + BigInt(s.quote.usdCents) > RULES.dailyUsdCents) {
            s.state = "refused";
            s.reason = "The desk reached today's limit.";
          } else {
            event(s, "user-locked", { tx: utxo.txid });
            s.deskTimeout = check.deskTimeout;
            s.lockId = lockIdOf({ sender: baseClients(env).account.address, recipient: s.userBase, amount: s.quote.usdcUnits, secretHash: s.hash, timeout: s.deskTimeout });
            s.state = "desk-locking";
            await putSwap(env, s);
            s.baseLockTx = await sendBase(env, "lock", [USDC_BASE, s.userBase, BigInt(s.quote.usdcUnits), `0x${s.hash}`, BigInt(s.deskTimeout)]);
            await addDaily(env, BigInt(s.quote.usdCents));
            event(s, "desk-locked", { tx: s.baseLockTx });
            s.state = "desk-locked";
          }
        }
      }
      if (s.state === "refused") event(s, "refused", { reason: s.reason });
      return s;
    }
    // refused: give the user's coins back once their timeout has passed (the network enforces it via median time)
    if (!utxo) {
      s.state = "user-refunded";
      return s;
    }
    if (t >= s.bchTimeout) {
      try {
        const raw = spendLockTx({ utxo, unlocking: refundUnlocking(c.redeem), toPkh: s.userPkh, locktime: s.bchTimeout });
        s.userRefundTx = await broadcast(raw);
        event(s, "user-refunded", { tx: s.userRefundTx });
        s.state = "user-refunded";
      } catch (err) {
        s.lastError = String(err.message).slice(0, 200); // usually "non-final" until median time passes the timeout
      }
    }
    return s;
  }

  if (s.state === "desk-locked" || s.state === "user-paid") {
    if (!s.secret) {
      const onChain = await secretFromBase(env, s.lockId).catch(() => null);
      if (onChain) {
        s.secret = onChain;
        event(s, "user-paid", { by: "user" });
        s.state = "user-paid";
      }
    }
    if (s.secret) {
      const utxo = await lockUtxo(c.scripthash);
      if (utxo) {
        const raw = spendLockTx({ utxo, unlocking: claimUnlocking(s.secret, c.redeem), toPkh: env.DESK_BCH_PKH });
        try {
          s.bchClaimTx = await broadcast(raw);
        } catch (err) {
          s.lastError = String(err.message).slice(0, 200);
          return s;
        }
      }
      event(s, "desk-claimed", { tx: s.bchClaimTx });
      s.state = "done";
      s.doneAt = Date.now();
      return s;
    }
    if (t >= s.deskTimeout) {
      const st = await baseLockState(env, s.lockId);
      if (!st.settled) {
        s.deskRefundTx = await sendBase(env, "refund", [s.lockId]);
        event(s, "desk-refunded", { tx: s.deskRefundTx });
        // the user's BCH lock still refunds to them after its own timeout
        s.state = "refused";
        s.reason = "The secret never came; both sides go back to their owners.";
      }
    }
  }
  return s;
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return json({});
  const t = now();

  if (url.pathname === "/api/status") {
    const { pub, account } = baseClients(env);
    const [usdc, eth, price, day] = await Promise.all([
      pub.readContract({ address: USDC_BASE, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
      pub.getBalance({ address: account.address }),
      bchUsd(),
      dailyCents(env),
    ]);
    return json({
      ok: true,
      desk: { bchPkh: env.DESK_BCH_PKH, base: account.address },
      liquidity: { usdcUnits: usdc, ethWei: eth },
      bchUsd: price,
      rules: { feeBps: RULES.feeBps, minUsdCents: RULES.minUsdCents, maxUsdCents: RULES.maxUsdCents, maxFee: RULES.maxFee, lockExtraSats: RULES.lockExtraSats },
      todayUsdCents: day.cents,
      dailyUsdCents: RULES.dailyUsdCents,
      contracts: { swapLockBase: SWAP_LOCK_BASE, usdc: USDC_BASE, pusdCategory: PUSD_CATEGORY },
    });
  }

  if (url.pathname === "/api/quote" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    try {
      const price = body.pay === "BCH" ? await bchUsd() : 0;
      const q = priceQuote({ pay: body.pay, payUnits: BigInt(body.payUnits ?? 0), bchUsd: price });
      const usdCents = (q.usdMicros + 9_999n) / 10_000n;
      const quote = {
        pay: q.pay,
        payUnits: q.payUnits.toString(),
        usdcUnits: q.usdcUnits.toString(),
        feeUnits: q.feeUnits.toString(),
        usdCents: usdCents.toString(),
        lockSats: q.lockSats.toString(),
        bchUsd: price || undefined,
        deskBchPkh: env.DESK_BCH_PKH,
        maxFee: RULES.maxFee.toString(),
        expiresAt: t + RULES.quoteTtlSec,
      };
      return json({ ok: true, quote, mac: await signQuote(env.QUOTE_KEY, quote) });
    } catch (err) {
      return fail(err.message);
    }
  }

  if (url.pathname === "/api/take" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const bad = await verifyQuote(env.QUOTE_KEY, body.quote, body.mac, t);
    if (bad) return fail(bad);
    if (!isHex(body.secretHash, 32)) return fail("secretHash must be 32 bytes of hex.");
    if (!isHex(body.userPkh, 20)) return fail("userPkh must be 20 bytes of hex.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.userBase || "")) return fail("userBase must be a Base address.");
    const bchTimeout = Number(body.bchTimeout);
    if (!Number.isInteger(bchTimeout)) return fail("bchTimeout must be a unix time.");
    const hash = strip0x(body.secretHash);
    let s = await getSwap(env, hash);
    if (!s) {
      s = { hash, state: "waiting-for-lock", created: t, quote: body.quote, userPkh: strip0x(body.userPkh), userBase: body.userBase, bchTimeout, events: [] };
      event(s, "quoted");
      await putSwap(env, s);
    }
    try {
      s = await advance(env, s);
    } catch (err) {
      s.lastError = String(err.message).slice(0, 200);
    }
    await putSwap(env, s);
    return json({ ok: true, swap: publicSwap(s) });
  }

  if (url.pathname === "/api/reveal" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!isHex(body.secret, 32)) return fail("secret must be 32 bytes of hex.");
    const secret = strip0x(body.secret);
    const hash = binToHex(await sha256(hexToBin(secret)));
    let s = await getSwap(env, hash);
    if (!s) return fail("No swap with this secret.", 404);
    if (s.state === "desk-locked" && !s.secret) {
      // Pay the user first: the claim can only send the USDC to their address, the desk only pays the gas.
      const st = await baseLockState(env, s.lockId);
      if (!st.settled) {
        s.baseClaimTx = await sendBase(env, "claim", [s.lockId, `0x${secret}`]);
        event(s, "user-paid", { tx: s.baseClaimTx, by: "desk" });
      }
      s.secret = secret;
      s.state = "user-paid";
      await putSwap(env, s);
    }
    try {
      s = await advance(env, s);
    } catch (err) {
      s.lastError = String(err.message).slice(0, 200);
    }
    await putSwap(env, s);
    return json({ ok: true, swap: publicSwap(s) });
  }

  const m = url.pathname.match(/^\/api\/swap\/([0-9a-fA-F]{64})$/);
  if (m) {
    const s = await getSwap(env, m[1].toLowerCase());
    return s ? json({ ok: true, swap: publicSwap(s) }) : fail("Unknown swap.", 404);
  }

  if (url.pathname === "/api/recent") {
    const rows = await env.DB.prepare("SELECT data FROM swaps WHERE state = 'done' ORDER BY updated DESC LIMIT 10").all();
    return json({ ok: true, swaps: (rows.results || []).map((r) => publicSwap(JSON.parse(r.data))) });
  }

  return fail("Not found.", 404);
}

// What the page may see: everything except nothing secret (the secret is public once it is on chain anyway).
function publicSwap(s) {
  const { secret, ...rest } = s;
  return { ...rest, secretKnown: !!secret };
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      return fail(String(err?.message || err).slice(0, 300), 500);
    }
  },
  async scheduled(_event, env) {
    const rows = await env.DB.prepare(
      "SELECT data FROM swaps WHERE state IN ('waiting-for-lock','desk-locking','desk-locked','user-paid','refused') ORDER BY updated ASC LIMIT 20"
    ).all();
    for (const r of rows.results || []) {
      let s = JSON.parse(r.data);
      // a /take still running right now: leave it a minute
      if (s.state === "desk-locking" && now() - s.updated < 90) continue;
      try {
        s = await advance(env, s);
      } catch (err) {
        s.lastError = String(err.message).slice(0, 200);
      }
      await putSwap(env, s);
    }
  },
};

export { txidOf };
