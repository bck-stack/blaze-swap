import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  USER_LOCK_HOURS,
  baseTx,
  bchTx,
  checkDeskLock,
  deskQuote,
  deskRecent,
  deskReveal,
  deskStatus,
  deskSwap,
  deskTake,
  lockContract,
  lockWithWallet,
  loadDeskSwaps,
  newSwapTerms,
  refundWithoutWallet,
  saveDeskSwap,
  short,
} from "./lib/desk.js";

const PRESETS_USD = [0.05, 0.1, 0.25];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUsdc = (units) => (Number(units) / 1e6).toFixed(Number(units) % 1000 === 0 ? 3 : 5).replace(/0+$/, "").replace(/\.$/, "");
const payLabel = (q) => (q.pay === "PUSD" ? `${(Number(q.payUnits) / 100).toFixed(2)} PUSD` : `${(Number(q.payUnits) / 1e8).toFixed(6)} BCH`);

// The four moments of a swap, each on the chain where it happens.
function stepsFor(q) {
  const pay = q ? payLabel(q) : "PUSD";
  const get = q ? `${fmtUsdc(q.usdcUnits)} USDC` : "USDC";
  return [
    { key: "user-locked", chain: "bch", title: `You lock ${pay}`, sub: "One signature in your BCH wallet. Only the desk can take it, and only with your key." },
    { key: "desk-locked", chain: "base", title: `The desk locks ${get} for you`, sub: "Your page checks this lock on Base before it shows the desk anything." },
    { key: "user-paid", chain: "base", title: `Your key releases ${get} to you`, sub: "The desk sends the claim and pays the gas; the contract can only pay your address." },
    { key: "desk-claimed", chain: "bch", title: `The desk takes the ${q?.pay || "PUSD"}`, sub: "With the same key, now public. Nothing else could ever unlock it." },
  ];
}

function Lanes({ quote, events, startedAt, running, replay }) {
  const steps = stepsFor(quote);
  const done = new Set((events || []).map((e) => e.step));
  const current = steps.find((s) => !done.has(s.key))?.key;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);
  const last = (events || []).reduce((m, e) => Math.max(m, e.at), startedAt || 0);
  const elapsed = startedAt ? ((running ? now : last) - startedAt) / 1000 : 0;
  const keyPos = done.has("desk-claimed") ? "bch" : done.has("user-paid") ? "base" : done.has("desk-locked") ? "page" : "page";
  return (
    <div className={`lanes ${running ? "is-running" : ""}`}>
      <div className="lanes-head">
        <span className="lane-name bch">Bitcoin Cash</span>
        <span className={`timer ${done.has("desk-claimed") ? "is-done" : ""}`}>
          {done.has("desk-claimed") ? `Done in ${elapsed.toFixed(1)} s` : startedAt ? `${elapsed.toFixed(1)} s` : replay ? "Replay" : ""}
        </span>
        <span className="lane-name base">Base</span>
      </div>
      <div className={`key-track key-at-${keyPos}`} aria-hidden="true">
        <span className="key-dot">🔑</span>
      </div>
      {steps.map((s, i) => {
        const ev = (events || []).find((e) => e.step === s.key);
        const state = ev ? "done" : s.key === current && running ? "active" : "todo";
        return (
          <div key={s.key} className={`lane-step ${s.chain} ${state}`}>
            <div className="lane-num">{state === "done" ? "✓" : i + 1}</div>
            <div className="lane-body">
              <div className="lane-title">{s.title}</div>
              <div className="lane-sub">{s.sub}</div>
              {ev?.tx && (
                <a className="lane-tx mono" href={s.chain === "bch" ? bchTx(ev.tx) : baseTx(ev.tx)} target="_blank" rel="noreferrer">
                  {s.chain === "bch" ? "Bitcoin Cash" : "Base"} tx {short(ev.tx)} ↗
                </a>
              )}
              {ev && startedAt && <span className="lane-at">+{((ev.at - startedAt) / 1000).toFixed(1)} s</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function DeskSwap({ manager, bchAccount, wcState, connectBch, evmAddress, onConnectEvm, balances }) {
  const [status, setStatus] = useState(null);
  const [pay, setPay] = useState("PUSD");
  const [usd, setUsd] = useState(0.1);
  const [quote, setQuote] = useState(null);
  const [mac, setMac] = useState("");
  const [quoteErr, setQuoteErr] = useState("");
  const [baseAddr, setBaseAddr] = useState(() => localStorage.getItem("blaze_desk_base") || "");
  const [burner, setBurner] = useState(() => localStorage.getItem("blaze_burner_key") || "");
  const [phase, setPhase] = useState("idle"); // idle | signing | running | done | refused | error
  const [message, setMessage] = useState("");
  const [swap, setSwap] = useState(null); // { hash, terms, quote, events, startedAt, ... }
  const [recent, setRecent] = useState([]);
  const [replay, setReplay] = useState(null);
  const replayTimer = useRef(null);

  useEffect(() => {
    deskStatus().then(setStatus).catch(() => setStatus({ ok: false }));
    deskRecent().then((r) => setRecent(r.swaps || [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (evmAddress && !baseAddr) setBaseAddr(evmAddress);
  }, [evmAddress, baseAddr]);
  useEffect(() => {
    try {
      localStorage.setItem("blaze_desk_base", baseAddr);
    } catch {
      /* ignore */
    }
  }, [baseAddr]);

  const payUnits = useMemo(() => {
    if (pay === "PUSD") return Math.round(usd * 100);
    if (!status?.bchUsd) return 0;
    return Math.round((usd / status.bchUsd) * 1e8);
  }, [pay, usd, status]);

  // A live quote whenever the amount or the asset changes.
  useEffect(() => {
    if (phase === "running" || phase === "signing" || !payUnits) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await deskQuote(pay, payUnits);
        if (!cancelled) {
          setQuote(r.quote);
          setMac(r.mac);
          setQuoteErr("");
        }
      } catch (e) {
        if (!cancelled) {
          setQuote(null);
          setQuoteErr(e.message);
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pay, payUnits, phase]);

  const validBase = /^0x[0-9a-fA-F]{40}$/.test(baseAddr);
  const liquidityOk = !quote || !status?.liquidity || BigInt(status.liquidity.usdcUnits) >= BigInt(quote.usdcUnits);

  const makeBurner = () => {
    const key = generatePrivateKey();
    try {
      localStorage.setItem("blaze_burner_key", key);
    } catch {
      /* ignore */
    }
    setBurner(key);
    setBaseAddr(privateKeyToAccount(key).address);
  };

  const pushEvent = useCallback((step, extra = {}) => {
    setSwap((s) => (s && !s.events.some((e) => e.step === step) ? { ...s, events: [...s.events, { step, at: Date.now(), ...extra }] } : s));
  }, []);

  const run = async () => {
    setReplay(null);
    setMessage("");
    let q = quote;
    let m = mac;
    try {
      if (!bchAccount || !manager) throw new Error("Connect your BCH wallet first.");
      if (!validBase) throw new Error("Enter the Base address that should receive the USDC.");
      // a fresh quote right before signing, so it cannot expire while the wallet is open
      const fresh = await deskQuote(pay, payUnits);
      q = fresh.quote;
      m = fresh.mac;
      setQuote(q);
      setMac(m);
      const terms = await newSwapTerms({ quote: q, userPkh: bchAccount.pkhHex.replace(/^0x/, "") });
      const hash = terms.secretHash.replace(/^0x/, "");
      const record = { hash, terms, quote: q, mac: m, userBase: baseAddr, events: [], startedAt: null, state: "signing" };
      saveDeskSwap(record);
      setSwap(record);
      setPhase("signing");

      const contract = lockContract(terms);
      const lockTxid = await lockWithWallet({ manager, account: bchAccount, quote: q, contract });
      const startedAt = Date.now();
      setSwap((s) => ({ ...s, startedAt, lockTx: lockTxid, events: [{ step: "user-locked", at: startedAt, tx: lockTxid }] }));
      saveDeskSwap({ ...record, startedAt, lockTx: lockTxid, state: "locked" });
      setPhase("running");

      // The desk locks USDC once it sees our lock on the network.
      let desk;
      for (let i = 0; i < 40; i += 1) {
        const r = await deskTake({ quote: q, mac: m, secretHash: hash, userPkh: terms.userPkh, userBase: baseAddr, bchTimeout: terms.timeout });
        desk = r.swap;
        if (desk.state !== "waiting-for-lock" && desk.state !== "desk-locking") break;
        await sleep(1500);
      }
      if (desk.state === "refused") throw Object.assign(new Error(desk.reason || "The desk did not take this swap."), { refused: true });
      if (desk.state !== "desk-locked") throw new Error(desk.lastError || "The desk has not locked yet. Your lock is safe: it comes back to you if the desk never does.");

      // Our own check of the desk's lock, on Base, before the key leaves this page.
      let check;
      for (let i = 0; i < 10; i += 1) {
        check = await checkDeskLock({ deskBase: status.desk.base, userBase: baseAddr, quote: q, secretHash: terms.secretHash, deskTimeout: desk.deskTimeout, userTimeout: terms.timeout });
        if (check.ok) break;
        await sleep(1500);
      }
      if (!check.ok) throw new Error(check.reason);
      pushEvent("desk-locked", { tx: desk.baseLockTx });

      const done = await deskReveal(terms.secret);
      const ev = done.swap.events || [];
      const paid = ev.find((e) => e.step === "user-paid");
      pushEvent("user-paid", { tx: done.swap.baseClaimTx || paid?.tx });
      if (done.swap.bchClaimTx) pushEvent("desk-claimed", { tx: done.swap.bchClaimTx });
      saveDeskSwap({ ...record, startedAt, lockTx: lockTxid, state: done.swap.state, baseClaimTx: done.swap.baseClaimTx, bchClaimTx: done.swap.bchClaimTx });
      setPhase("done");
      deskRecent().then((r) => setRecent(r.swaps || [])).catch(() => {});
      deskStatus().then(setStatus).catch(() => {});
    } catch (e) {
      setPhase(e.refused ? "refused" : "error");
      setMessage(e.message || String(e));
    }
  };

  const tryRefund = async () => {
    try {
      const r = await refundWithoutWallet({ terms: swap.terms, toPkh: swap.terms.userPkh });
      setMessage(`Refunded: ${r.txid}`);
    } catch (e) {
      setMessage(`Not yet: ${e.message}. The network accepts the refund about an hour after the lock's time passes; the desk also sends it for you.`);
    }
  };

  // Replay the latest real swap the desk finished, with its real timings and transactions.
  const watch = async (s) => {
    clearTimeout(replayTimer.current);
    const full = s.events ? s : (await deskSwap(s.hash)).swap;
    const evs = (full.events || []).filter((e) => ["user-locked", "desk-locked", "user-paid", "desk-claimed"].includes(e.step));
    const tx = { "user-locked": full.bchLockTx, "desk-locked": full.baseLockTx, "user-paid": full.baseClaimTx, "desk-claimed": full.bchClaimTx };
    const t0 = evs[0]?.at || Date.now();
    const shown = { quote: full.quote, startedAt: Date.now(), events: [], running: true, createdAt: full.created, hash: full.hash };
    setReplay(shown);
    evs.forEach((e) => {
      replayTimer.current = setTimeout(() => {
        setReplay((r) => (r ? { ...r, events: [...r.events, { step: e.step, at: shown.startedAt + (e.at - t0), tx: e.tx || tx[e.step] }] } : r));
      }, e.at - t0 + 400);
    });
    setTimeout(() => setReplay((r) => (r ? { ...r, running: false } : r)), (evs.at(-1)?.at || t0) - t0 + 600);
  };

  const connected = wcState === "connected" && bchAccount;
  const busy = phase === "signing" || phase === "running";
  const deskOnline = status?.ok;
  const canSwap = connected && deskOnline && quote && validBase && liquidityOk && !busy;
  const resumeable = loadDeskSwaps().filter((s) => s.state !== "done" && s.lockTx && s !== swap).slice(0, 1);

  return (
    <div className="desk">
      <section className="desk-hero">
        <h1>
          Bitcoin Cash in, <span className="usdc">USDC on Base</span> out.
        </h1>
        <p>One signature. About ten seconds. No bridge and no custodian in between: two locks that open with the same key.</p>
      </section>

      <div className="desk-grid">
        <section className="swap-card">
          <div className="swap-row">
            <div className="swap-row-head">
              <span>You pay on Bitcoin Cash</span>
              {connected && (
                <span className="small-muted">
                  Wallet: {(Number(balances.pusdAmount) / 100).toFixed(2)} PUSD · {(Number(balances.bchSatoshis) / 1e8).toFixed(5)} BCH
                </span>
              )}
            </div>
            <div className="swap-amount">
              <div className="presets">
                {PRESETS_USD.map((v) => (
                  <button type="button" key={v} className={`chip ${usd === v ? "on" : ""}`} onClick={() => setUsd(v)} disabled={busy}>
                    ${v.toFixed(2)}
                  </button>
                ))}
              </div>
              <div className="asset-toggle" role="group" aria-label="Pay with">
                {["PUSD", "BCH"].map((a) => (
                  <button type="button" key={a} className={pay === a ? "on" : ""} onClick={() => setPay(a)} disabled={busy}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <div className="big-amount">{quote ? payLabel(quote) : pay === "PUSD" ? `${usd.toFixed(2)} PUSD` : "…"}</div>
          </div>

          <div className="swap-arrow" aria-hidden="true">↓</div>

          <div className="swap-row receive">
            <div className="swap-row-head">
              <span>You receive on Base</span>
              <span className="small-muted">{quote ? `fee ${fmtUsdc(quote.feeUnits)} USDC (0.5%)` : ""}</span>
            </div>
            <div className="big-amount usdc">{quote ? `${fmtUsdc(quote.usdcUnits)} USDC` : quoteErr || "…"}</div>
            <div className="base-addr">
              <input className="mono" value={baseAddr} onChange={(e) => setBaseAddr(e.target.value.trim())} placeholder="Your Base address 0x…" disabled={busy} />
              {!evmAddress && (
                <button type="button" className="btn btn-sm btn-base" onClick={onConnectEvm} disabled={busy}>
                  Use my wallet
                </button>
              )}
            </div>
            {!baseAddr && (
              <button type="button" className="link-btn" onClick={makeBurner} disabled={busy}>
                No Base wallet? Make an address in this browser
              </button>
            )}
            {burner && baseAddr === privateKeyToAccount(burner).address && (
              <div className="small-muted">
                This address&apos;s key lives only in this browser.{" "}
                <button type="button" className="link-btn" onClick={() => navigator.clipboard?.writeText(burner)}>
                  Copy the key
                </button>{" "}
                to keep the USDC.
              </div>
            )}
          </div>

          {!connected ? (
            <button type="button" className="btn btn-primary btn-swap" onClick={connectBch} disabled={wcState === "connecting"}>
              {wcState === "connecting" ? "Waiting for your wallet…" : "Connect BCH wallet"}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-swap" onClick={run} disabled={!canSwap}>
              {phase === "signing" ? "Sign in your wallet…" : phase === "running" ? "Swapping…" : !deskOnline ? "Desk offline" : !liquidityOk ? "Desk is out of USDC" : "Swap"}
            </button>
          )}

          <ul className="swap-facts">
            <li>
              Desk liquidity:{" "}
              {status?.liquidity ? `${fmtUsdc(status.liquidity.usdcUnits)} USDC on Base` : status?.ok === false ? "offline" : "…"}
              {status?.bchUsd ? ` · BCH $${status.bchUsd.toFixed(2)}` : ""}
            </li>
            <li>If the desk never pays, your {pay} comes back to you after {USER_LOCK_HOURS} hours, with no signature needed.</li>
          </ul>
        </section>

        <section className="progress-card">
          {swap?.startedAt || phase === "signing" ? (
            <>
              <Lanes quote={swap.quote} events={swap.events} startedAt={swap.startedAt} running={phase === "running"} />
              {phase === "done" && (
                <div className="done-box">
                  <strong>{fmtUsdc(swap.quote.usdcUnits)} USDC</strong> is at {short(swap.userBase)} on Base.
                </div>
              )}
            </>
          ) : replay ? (
            <>
              <div className="replay-tag">
                ▶ Replay of a real mainnet swap{replay.createdAt ? ` · ${new Date(replay.createdAt * 1000).toUTCString().slice(5, 22)} UTC` : ""}, real timings and transactions
              </div>
              <Lanes quote={replay.quote} events={replay.events} startedAt={replay.startedAt} running={replay.running} replay />
            </>
          ) : (
            <div className="progress-empty">
              <Lanes quote={quote} events={[]} />
              <button type="button" className="btn btn-ghost" onClick={() => recent[0] && watch(recent[0])} disabled={!recent[0]}>
                ▶ Watch a real mainnet swap (no wallet needed)
              </button>
            </div>
          )}
          {message && <div className={`alert ${phase === "error" || phase === "refused" ? "alert-error" : "alert-info"}`}>{message}</div>}
          {(phase === "error" || phase === "refused") && swap?.lockTx && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={tryRefund}>
              Get my {swap.quote.pay} back now (after the {USER_LOCK_HOURS} h timeout)
            </button>
          )}
          {resumeable.length > 0 && phase === "idle" && (
            <div className="small-muted">An earlier swap of yours did not finish in this browser ({short(resumeable[0].hash)}); its lock refunds itself after its timeout.</div>
          )}
        </section>
      </div>

      {recent.length > 0 && (
        <section className="recent">
          <h2>Latest swaps on mainnet</h2>
          <table>
            <tbody>
              {recent.slice(0, 6).map((s) => {
                const evs = s.events || [];
                const t0 = evs.find((e) => e.step === "user-locked")?.at;
                const t1 = evs.find((e) => e.step === "desk-claimed")?.at || evs.find((e) => e.step === "user-paid")?.at;
                return (
                  <tr key={s.hash}>
                    <td>{payLabel(s.quote)} → {fmtUsdc(s.quote.usdcUnits)} USDC</td>
                    <td className="small-muted">{t0 && t1 ? `${((t1 - t0) / 1000).toFixed(1)} s` : ""}</td>
                    <td>
                      <a href={bchTx(s.bchLockTx)} target="_blank" rel="noreferrer">BCH lock</a> ·{" "}
                      <a href={baseTx(s.baseClaimTx || s.baseLockTx)} target="_blank" rel="noreferrer">USDC paid</a>
                    </td>
                    <td>
                      <button type="button" className="link-btn" onClick={() => watch(s)}>▶ replay</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section className="how">
        <div>
          <h3>Why it is safe</h3>
          <p>Your coins sit in a Bitcoin Cash contract that pays the desk only with a key your browser made. The desk locks your USDC on Base under the same lock first; your page checks it on chain before it shares the key.</p>
        </div>
        <div>
          <h3>Why it needs one signature</h3>
          <p>The new SwapLockV2 contract fixes where the coins can go, so the claim and the refund need no signature: the desk can finish for you, and anyone can send your refund.</p>
        </div>
        <div>
          <h3>Why no bridge</h3>
          <p>Nobody holds the money in between. Each chain only ever pays the party its contract names: you on Base, the desk on Bitcoin Cash, or the owner after the timeout.</p>
        </div>
      </section>
    </div>
  );
}

export { lockContract };
