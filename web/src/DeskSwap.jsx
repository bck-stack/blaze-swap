import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  USER_LOCK_HOURS,
  baseTx,
  bchTx,
  checkDeskBchLock,
  checkDeskLock,
  claimDeskBchLock,
  deskQuote,
  deskQuoteToBch,
  deskRecent,
  deskReveal,
  deskStatus,
  deskSwap,
  deskTake,
  lockContract,
  lockWithWallet,
  loadDeskSwaps,
  lockUsdcForDesk,
  newSwapTerms,
  refundWithoutWallet,
  saveDeskSwap,
  short,
} from "./lib/desk.js";
import { decodeCashAddressPkh, generateSecretPair } from "./lib/swapProtocol.js";

const PRESETS_USD = [0.05, 0.1, 0.25];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUsdc = (units) => (Number(units) / 1e6).toFixed(Number(units) % 1000 === 0 ? 3 : 5).replace(/0+$/, "").replace(/\.$/, "");
const payLabel = (q) => (q.pay === "PUSD" ? `${(Number(q.payUnits) / 100).toFixed(2)} PUSD` : `${(Number(q.payUnits) / 1e8).toFixed(6)} BCH`);
const recvLabel = (q) => (q.receive === "PUSD" ? `${(Number(q.receiveUnits) / 100).toFixed(2)} PUSD` : `${(Number(q.receiveUnits) / 1e8).toFixed(6)} BCH`);
// what goes in and what comes out, whichever way the swap runs
const fromLabel = (q) => (q.dir === "toBch" ? `${fmtUsdc(q.usdcUnits)} USDC` : payLabel(q));
const toLabel = (q) => (q.dir === "toBch" ? recvLabel(q) : `${fmtUsdc(q.usdcUnits)} USDC`);

// The four moments of a swap, each on the chain where it happens.
function stepsFor(q, dir) {
  if ((q?.dir || dir) === "toBch") {
    const pay = q ? `${fmtUsdc(q.usdcUnits)} USDC` : "USDC";
    const get = q ? recvLabel(q) : "PUSD";
    return [
      { key: "user-locked", chain: "base", title: `You lock ${pay} on Base`, sub: "Your Base wallet allows and locks it. Only the desk can take it, and only with your key." },
      { key: "desk-locked", chain: "bch", title: `The desk locks ${get} for you`, sub: "Your page checks this lock on Bitcoin Cash before it shows the desk anything." },
      { key: "user-paid", chain: "bch", title: `Your key releases ${get} to you`, sub: "The claim needs no signature; the contract can only pay your address." },
      { key: "desk-claimed", chain: "base", title: "The desk takes the USDC", sub: "With the same key, now public. Nothing else could ever unlock it." },
    ];
  }
  const pay = q ? payLabel(q) : "PUSD";
  const get = q ? `${fmtUsdc(q.usdcUnits)} USDC` : "USDC";
  return [
    { key: "user-locked", chain: "bch", title: `You lock ${pay}`, sub: "One signature in your BCH wallet. Only the desk can take it, and only with your key." },
    { key: "desk-locked", chain: "base", title: `The desk locks ${get} for you`, sub: "Your page checks this lock on Base before it shows the desk anything." },
    { key: "user-paid", chain: "base", title: `Your key releases ${get} to you`, sub: "The desk sends the claim and pays the gas; the contract can only pay your address." },
    { key: "desk-claimed", chain: "bch", title: `The desk takes the ${q?.pay || "PUSD"}`, sub: "With the same key, now public. Nothing else could ever unlock it." },
  ];
}

function Lanes({ quote, events, startedAt, running, replay, dir }) {
  const steps = stepsFor(quote, dir);
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
  // the key goes from the page to the user's claim, then to the desk's claim
  const chainOf = (k) => steps.find((x) => x.key === k)?.chain;
  const keyPos = done.has("desk-claimed") ? chainOf("desk-claimed") : done.has("user-paid") ? chainOf("user-paid") : "page";
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
  const [dir, setDir] = useState("toBase"); // toBase: BCH side in, USDC out · toBch: USDC in, BCH side out
  const [pay, setPay] = useState("PUSD"); // the Bitcoin Cash side's asset, in either direction
  const [bchTo, setBchTo] = useState("");
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
    // round up, plus a little for the price moving between this page's price and the desk's quote
    return Math.ceil((usd / status.bchUsd) * 1e8 * (dir === "toBch" ? 1.002 : 1.005));
  }, [pay, usd, status, dir]);
  const getQuote = useCallback(() => (dir === "toBch" ? deskQuoteToBch(pay, payUnits) : deskQuote(pay, payUnits)), [dir, pay, payUnits]);

  // where the PUSD or BCH goes in the reverse direction: the connected BCH wallet, or a pasted address
  useEffect(() => {
    if (bchAccount?.tokenAddress && !bchTo) setBchTo(bchAccount.tokenAddress);
  }, [bchAccount, bchTo]);
  const bchToPkh = useMemo(() => {
    try {
      return bchTo ? decodeCashAddressPkh(bchTo).replace(/^0x/, "") : "";
    } catch {
      return "";
    }
  }, [bchTo]);

  // A live quote whenever the amount or the asset changes.
  useEffect(() => {
    if (phase === "running" || phase === "signing" || !payUnits) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await getQuote();
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
  }, [getQuote, payUnits, phase]);

  const validBase = /^0x[0-9a-fA-F]{40}$/.test(baseAddr);
  const liquidityOk = (() => {
    const l = status?.liquidity;
    if (!quote || !l) return true;
    if (quote.dir !== "toBch") return BigInt(l.usdcUnits) >= BigInt(quote.usdcUnits);
    if (l.bchSats == null) return true;
    return quote.receive === "PUSD" ? BigInt(l.pusdUnits) >= BigInt(quote.receiveUnits) && BigInt(l.bchSats) > 5000n : BigInt(l.bchSats) >= BigInt(quote.lockSats) + 2000n;
  })();

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
      const fresh = await getQuote();
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

  // The reverse direction: lock USDC on Base, the desk locks PUSD or BCH on Bitcoin Cash for the user, the page
  // checks that lock itself and only then hands over the key; the claim needs no signature.
  const runToBch = async () => {
    setReplay(null);
    setMessage("");
    try {
      if (!evmAddress) throw new Error("Connect your Base wallet first.");
      if (!bchToPkh) throw new Error("Enter the Bitcoin Cash address that should receive the coins.");
      const fresh = await getQuote();
      const q = fresh.quote;
      setQuote(q);
      setMac(fresh.mac);
      const { secret, secretHash } = await generateSecretPair();
      const hash = secretHash.replace(/^0x/, "");
      const baseTimeout = Math.floor(Date.now() / 1000) + USER_LOCK_HOURS * 3600;
      const record = { dir: "toBch", hash, secret, quote: q, mac: fresh.mac, userBase: evmAddress, userPkh: bchToPkh, baseTimeout, events: [], startedAt: null, state: "signing" };
      saveDeskSwap(record);
      setSwap(record);
      setPhase("signing");

      const lock = await lockUsdcForDesk({ account: evmAddress, quote: q, secretHash, timeout: baseTimeout });
      const startedAt = Date.now();
      setSwap((s) => ({ ...s, startedAt, lockTx: lock.hash, events: [{ step: "user-locked", at: startedAt, tx: lock.hash }] }));
      saveDeskSwap({ ...record, startedAt, lockTx: lock.hash, state: "locked" });
      setPhase("running");

      let desk;
      for (let i = 0; i < 40; i += 1) {
        const r = await deskTake({ quote: q, mac: fresh.mac, secretHash: hash, userPkh: bchToPkh, userBase: evmAddress, baseTimeout });
        desk = r.swap;
        if (desk.state !== "waiting-for-lock" && desk.state !== "desk-locking") break;
        await sleep(1500);
      }
      if (desk.state === "refused") throw Object.assign(new Error(desk.reason || "The desk did not take this swap."), { refused: true });
      if (desk.state !== "desk-locked") throw new Error(desk.lastError || "The desk has not locked yet. Your USDC is safe: it comes back to you if the desk never locks.");

      let check;
      for (let i = 0; i < 10; i += 1) {
        check = await checkDeskBchLock({ userPkh: bchToPkh, quote: q, secretHash, deskTimeout: desk.deskTimeout });
        if (check.ok) break;
        await sleep(1500);
      }
      if (!check.ok) throw new Error(check.reason);
      pushEvent("desk-locked", { tx: desk.bchLockTx });

      // the desk sends our claim (and then takes its USDC); if it does not, the page sends the claim itself
      let done = (await deskReveal(secret).catch(() => null))?.swap;
      if (!done?.bchClaimTx) {
        const txid = (await claimDeskBchLock({ contract: check.contract, utxo: check.utxo, secret, userPkh: bchToPkh })).txid;
        pushEvent("user-paid", { tx: txid });
        for (let i = 0; i < 30 && done?.state !== "done"; i += 1) {
          await sleep(2000);
          done = (await deskSwap(hash).catch(() => null))?.swap || done;
        }
      } else {
        pushEvent("user-paid", { tx: done.bchClaimTx });
      }
      if (done?.baseClaimTx) pushEvent("desk-claimed", { tx: done.baseClaimTx });
      saveDeskSwap({ ...record, startedAt, lockTx: lock.hash, state: done?.state || "paid", bchClaimTx: done?.bchClaimTx, baseClaimTx: done?.baseClaimTx });
      setPhase("done");
      deskRecent().then((r) => setRecent(r.swaps || [])).catch(() => {});
      deskStatus().then(setStatus).catch(() => {});
    } catch (e) {
      setPhase(e.refused ? "refused" : "error");
      setMessage(e.shortMessage || e.message || String(e));
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
    const tx =
      full.dir === "toBch"
        ? { "desk-locked": full.bchLockTx, "user-paid": full.bchClaimTx, "desk-claimed": full.baseClaimTx }
        : { "user-locked": full.bchLockTx, "desk-locked": full.baseLockTx, "user-paid": full.baseClaimTx, "desk-claimed": full.bchClaimTx };
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
  const canSwapToBch = !!evmAddress && deskOnline && quote?.dir === "toBch" && !!bchToPkh && liquidityOk && !busy;
  const resumeable = loadDeskSwaps().filter((s) => s.state !== "done" && s.lockTx && s !== swap).slice(0, 1);

  return (
    <div className="desk">
      <section className="desk-hero">
        <h1>
          {dir === "toBch" ? (
            <>
              <span className="usdc">USDC on Base</span> in, Bitcoin Cash out.
            </>
          ) : (
            <>
              Bitcoin Cash in, <span className="usdc">USDC on Base</span> out.
            </>
          )}
        </h1>
        <p>Either way, about ten seconds. No bridge and no custodian in between: two locks that open with the same key.</p>
      </section>

      <div className="desk-grid">
        <section className="swap-card">
          {(() => {
            const presets = (
              <div className="presets">
                {PRESETS_USD.map((v) => (
                  <button type="button" key={v} className={`chip ${usd === v ? "on" : ""}`} onClick={() => setUsd(v)} disabled={busy}>
                    ${v.toFixed(2)}
                  </button>
                ))}
              </div>
            );
            const assetToggle = (
              <div className="asset-toggle" role="group" aria-label={dir === "toBch" ? "Receive" : "Pay with"}>
                {["PUSD", "BCH"].map((a) => (
                  <button type="button" key={a} className={pay === a ? "on" : ""} onClick={() => setPay(a)} disabled={busy}>
                    {a}
                  </button>
                ))}
              </div>
            );
            const flip = (
              <button
                type="button"
                className="swap-arrow"
                onClick={() => {
                  setDir((d) => (d === "toBch" ? "toBase" : "toBch"));
                  setQuote(null);
                  setPhase((p) => (p === "running" || p === "signing" ? p : "idle"));
                }}
                disabled={busy}
                title="Swap the direction"
                aria-label="Swap the direction"
              >
                ⇅
              </button>
            );
            const baseWallet = (
              <div className="wallet-line">
                {evmAddress ? (
                  <span className="wallet-pill base">Base · {short(evmAddress)}</span>
                ) : (
                  <button type="button" className="wallet-pill base is-action" onClick={onConnectEvm} disabled={busy}>
                    Connect Base wallet
                  </button>
                )}
              </div>
            );
            const bchWallet = (
              <div className="wallet-line">
                {connected ? (
                  <span className="wallet-pill bch">Bitcoin Cash · {short(bchAccount.tokenAddress.replace(/^bitcoincash:/, ""))}</span>
                ) : (
                  <button type="button" className="wallet-pill bch is-action" onClick={connectBch} disabled={wcState === "connecting" || busy}>
                    {wcState === "connecting" ? "Waiting for your wallet…" : "Connect BCH wallet"}
                  </button>
                )}
              </div>
            );

            if (dir === "toBch") {
              return (
                <>
                  <div className="swap-row">
                    <div className="swap-row-head">
                      <span>You pay on Base</span>
                      {baseWallet}
                    </div>
                    <div className="swap-amount">{presets}</div>
                    <div className="big-amount usdc">{quote?.dir === "toBch" ? `${fmtUsdc(quote.usdcUnits)} USDC` : quoteErr || "…"}</div>
                    {quote?.dir === "toBch" && <div className="small-muted">includes the 0.5% fee ({fmtUsdc(quote.feeUnits)} USDC); the desk pays the BCH network fee</div>}
                  </div>
                  {flip}
                  <div className="swap-row receive">
                    <div className="swap-row-head">
                      <span>You receive on Bitcoin Cash</span>
                      {bchWallet}
                    </div>
                    <div className="swap-amount">{assetToggle}</div>
                    <div className="big-amount">{quote?.dir === "toBch" ? recvLabel(quote) : "…"}</div>
                    <div className="base-addr">
                      <input className="mono" value={bchTo} onChange={(e) => setBchTo(e.target.value.trim())} placeholder="Your Bitcoin Cash address bitcoincash:…" disabled={busy} />
                    </div>
                    {bchTo && !bchToPkh && <div className="small-muted">That is not a Bitcoin Cash address (q… or z…).</div>}
                  </div>
                  <button type="button" className="btn btn-primary btn-swap" onClick={evmAddress ? runToBch : onConnectEvm} disabled={evmAddress ? !canSwapToBch : busy}>
                    {!evmAddress
                      ? "Connect Base wallet"
                      : phase === "signing"
                        ? "Confirm in your Base wallet…"
                        : phase === "running"
                          ? "Swapping…"
                          : !deskOnline
                            ? "Desk offline"
                            : !liquidityOk
                              ? `Desk is out of ${pay}`
                              : "Swap"}
                  </button>
                  <ul className="swap-facts">
                    <li>
                      Desk liquidity:{" "}
                      {status?.liquidity?.bchSats != null
                        ? `${(Number(status.liquidity.pusdUnits) / 100).toFixed(2)} PUSD · ${(Number(status.liquidity.bchSats) / 1e8).toFixed(5)} BCH`
                        : status?.ok === false
                          ? "offline"
                          : "…"}
                      {status?.bchUsd ? ` · BCH $${status.bchUsd.toFixed(2)}` : ""}
                    </li>
                    <li>If the desk never pays, your USDC goes back to you after {USER_LOCK_HOURS} hours; the desk sends that refund too, and anyone can.</li>
                  </ul>
                </>
              );
            }

            return (
              <>
                <div className="swap-row">
                  <div className="swap-row-head">
                    <span>You pay on Bitcoin Cash</span>
                    {bchWallet}
                  </div>
                  <div className="swap-amount">
                    {presets}
                    {assetToggle}
                  </div>
                  <div className="big-amount">{quote && quote.dir !== "toBch" ? payLabel(quote) : pay === "PUSD" ? `${usd.toFixed(2)} PUSD` : "…"}</div>
                  {connected && (
                    <div className="small-muted">
                      In your wallet: {(Number(balances.pusdAmount) / 100).toFixed(2)} PUSD · {(Number(balances.bchSatoshis) / 1e8).toFixed(5)} BCH
                    </div>
                  )}
                </div>
                {flip}
                <div className="swap-row receive">
                  <div className="swap-row-head">
                    <span>You receive on Base</span>
                    {baseWallet}
                  </div>
                  <div className="big-amount usdc">{quote && quote.dir !== "toBch" ? `${fmtUsdc(quote.usdcUnits)} USDC` : quoteErr || "…"}</div>
                  {quote && quote.dir !== "toBch" && <div className="small-muted">after the 0.5% fee ({fmtUsdc(quote.feeUnits)} USDC); the desk pays the Base gas</div>}
                  <div className="base-addr">
                    <input className="mono" value={baseAddr} onChange={(e) => setBaseAddr(e.target.value.trim())} placeholder="Your Base address 0x…" disabled={busy} />
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
              </>
            );
          })()}
        </section>

        <section className="progress-card">
          {swap?.startedAt || phase === "signing" ? (
            <>
              <Lanes quote={swap.quote} events={swap.events} startedAt={swap.startedAt} running={phase === "running"} dir={swap.dir} />
              {phase === "done" && (
                <div className="done-box">
                  {swap.dir === "toBch" ? (
                    <>
                      <strong>{recvLabel(swap.quote)}</strong> is on its way to your Bitcoin Cash address.
                    </>
                  ) : (
                    <>
                      <strong>{fmtUsdc(swap.quote.usdcUnits)} USDC</strong> is at {short(swap.userBase)} on Base.
                    </>
                  )}
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
              <Lanes quote={quote} events={[]} dir={dir} />
              <button type="button" className="btn btn-ghost" onClick={() => recent[0] && watch(recent[0])} disabled={!recent[0]}>
                ▶ Watch a real mainnet swap (no wallet needed)
              </button>
            </div>
          )}
          {message && <div className={`alert ${phase === "error" || phase === "refused" ? "alert-error" : "alert-info"}`}>{message}</div>}
          {(phase === "error" || phase === "refused") && swap?.lockTx && swap.dir !== "toBch" && (
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
                    <td>{fromLabel(s.quote)} → {toLabel(s.quote)}</td>
                    <td className="small-muted">{t0 && t1 ? `${((t1 - t0) / 1000).toFixed(1)} s` : ""}</td>
                    <td>
                      {s.dir === "toBch" ? (
                        <>
                          <a href={baseTx(evs.find((e) => e.step === "user-locked")?.tx || s.baseClaimTx)} target="_blank" rel="noreferrer">USDC lock</a> ·{" "}
                          <a href={bchTx(s.bchClaimTx || s.bchLockTx)} target="_blank" rel="noreferrer">{s.quote.receive} paid</a>
                        </>
                      ) : (
                        <>
                          <a href={bchTx(s.bchLockTx)} target="_blank" rel="noreferrer">BCH lock</a> ·{" "}
                          <a href={baseTx(s.baseClaimTx || s.baseLockTx)} target="_blank" rel="noreferrer">USDC paid</a>
                        </>
                      )}
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
