import { useCallback, useEffect, useMemo, useState } from "react";
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";
import {
  BLAZE_COMPLIANCE,
  NETWORK_CONFIG,
  computeEvmLockId,
  computePairedTimeouts,
  decodeCashAddressPkh,
  derivePkhAndAddressesFromPubkey,
  formatTokenUnits,
  generateSecretPair,
  loadSwaps,
  normalizeHex32,
  parseTokenUnits,
  saveSwaps,
} from "./lib/swapProtocol.js";
import {
  claimBchSwapLock,
  deriveSwapLockContract,
  fetchAddressBalances,
  fetchContractLockState,
  fundBchSwapLockWithWallet,
  refundBchSwapLock,
} from "./lib/bchBridge.js";
import {
  approveEvmUsdc,
  claimEvmSwap,
  connectEvmWallet,
  fetchEvmBalances,
  fetchEvmLockState,
  lockEvmSwap,
  pollEvmClaimedSecret,
  refundEvmSwap,
} from "./lib/evmBridge.js";

function shortAddr(addr) {
  if (!addr) return "";
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

export default function App() {
  const [networkId, setNetworkId] = useState("mainnet");
  const cfg = NETWORK_CONFIG[networkId];

  const {
    state: wcState,
    manager,
    uri,
    qrUri,
    walletName,
    connect: connectBch,
    disconnect: disconnectBch,
    error: wcError,
  } = useWizardConnect({ dappName: "BLAZE Swap (PUSD ↔ USDC)" });

  const [bchAccount, setBchAccount] = useState(null);
  const [evmAddress, setEvmAddress] = useState("");
  const [balances, setBalances] = useState({
    bchSatoshis: 0n,
    pusdAmount: 0n,
    usdcBalance: 0n,
    usdcAllowance: 0n,
  });

  const [showSettings, setShowSettings] = useState(false);
  const [slidesUrl, setSlidesUrl] = useState(
    () => localStorage.getItem("blaze_slides_url") || BLAZE_COMPLIANCE.slidesUrl
  );
  const [donationAddr, setDonationAddr] = useState(
    () =>
      localStorage.getItem("blaze_donation_addr") ||
      BLAZE_COMPLIANCE.donationAddress
  );
  const [swapLockAddresses, setSwapLockAddresses] = useState(() => ({
    mainnet:
      localStorage.getItem("blaze_evm_lock_mainnet") ||
      NETWORK_CONFIG.mainnet.defaultSwapLockAddress,
    chipnet:
      localStorage.getItem("blaze_evm_lock_chipnet") ||
      NETWORK_CONFIG.chipnet.defaultSwapLockAddress,
  }));

  const [direction, setDirection] = useState("BASE_TO_BCH");
  const [amountInput, setAmountInput] = useState("10.00");
  const [counterpartyBch, setCounterpartyBch] = useState("");
  const [counterpartyEvm, setCounterpartyEvm] = useState("");
  const [secretHex, setSecretHex] = useState("");
  const [secretHash, setSecretHash] = useState("");

  const [swaps, setSwaps] = useState(() => loadSwaps());
  const [selectedSwapId, setSelectedSwapId] = useState(() => loadSwaps()[0]?.id || "");
  const [lockStates, setLockStates] = useState({});
  const [watcherActive, setWatcherActive] = useState(true);
  const [statusMsg, setStatusMsg] = useState(null);
  const [busyAction, setBusyAction] = useState("");

  const evmContractAddr = swapLockAddresses[networkId] || "";

  useEffect(() => {
    saveSwaps(swaps);
  }, [swaps]);

  useEffect(() => {
    if (wcState === "connected" && manager) {
      const pubkey = manager.getPubkey(0, 0n);
      if (pubkey) {
        const derived = derivePkhAndAddressesFromPubkey(pubkey, networkId);
        setBchAccount(derived);
        return;
      }
    }
    if (wcState === "idle" || wcState === "disconnected") {
      setBchAccount(null);
    }
  }, [wcState, manager, networkId]);

  const refreshBalances = useCallback(async () => {
    try {
      const next = {
        bchSatoshis: 0n,
        pusdAmount: 0n,
        usdcBalance: 0n,
        usdcAllowance: 0n,
      };
      if (bchAccount?.tokenAddress) {
        const bchBal = await fetchAddressBalances(
          bchAccount.tokenAddress,
          networkId
        );
        next.bchSatoshis = bchBal.bchSatoshis;
        next.pusdAmount = bchBal.pusdAmount;
      }
      if (evmAddress) {
        const evmBal = await fetchEvmBalances({
          networkId,
          swapLockAddress: evmContractAddr,
          userAddress: evmAddress,
        });
        next.usdcBalance = evmBal.usdcBalance;
        next.usdcAllowance = evmBal.usdcAllowance;
      }
      setBalances(next);
    } catch {
      // Non-fatal background refresh failure
    }
  }, [bchAccount, evmAddress, evmContractAddr, networkId]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  const handleConnectEvm = async () => {
    try {
      setBusyAction("evm-connect");
      const addr = await connectEvmWallet(networkId);
      setEvmAddress(addr);
      setStatusMsg({ type: "success", text: `Base wallet connected: ${shortAddr(addr)}` });
    } catch (err) {
      setStatusMsg({ type: "error", text: err.message || "Failed to connect Base wallet" });
    } finally {
      setBusyAction("");
    }
  };

  const handleGenerateSecret = async () => {
    const pair = await generateSecretPair();
    setSecretHex(pair.secret);
    setSecretHash(pair.secretHash);
    setStatusMsg({
      type: "info",
      text: "Generated fresh 32-byte secret + SHA-256 hashlock.",
    });
  };

  const activeSwap = useMemo(
    () => swaps.find((s) => s.id === selectedSwapId) || swaps[0] || null,
    [swaps, selectedSwapId]
  );

  const handleCreateSwap = async (e) => {
    e.preventDefault();
    try {
      const pusdUnits = parseTokenUnits(amountInput, cfg.pusdDecimals);
      const usdcUnits = parseTokenUnits(amountInput, cfg.evmUsdcDecimals);
      if (pusdUnits <= 0n || usdcUnits <= 0n) {
        throw new Error("Amount must be greater than zero.");
      }

      let finalSecret = secretHex.trim();
      let finalHash = secretHash.trim();
      if (!finalHash) {
        const pair = await generateSecretPair();
        finalSecret = pair.secret;
        finalHash = pair.secretHash;
        setSecretHex(finalSecret);
        setSecretHash(finalHash);
      } else {
        finalHash = normalizeHex32(finalHash);
      }

      const bchRecipientAddr =
        direction === "BASE_TO_BCH"
          ? bchAccount?.tokenAddress || counterpartyBch
          : counterpartyBch;
      const bchRefundAddr =
        direction === "BCH_TO_BASE"
          ? bchAccount?.tokenAddress || counterpartyBch
          : counterpartyBch;
      const evmRecipientAddr =
        direction === "BCH_TO_BASE"
          ? evmAddress || counterpartyEvm
          : counterpartyEvm;
      const evmSenderAddr =
        direction === "BASE_TO_BCH"
          ? evmAddress || counterpartyEvm
          : counterpartyEvm;

      if (!bchRecipientAddr || !bchRefundAddr) {
        throw new Error("Connect WizardConnect or enter the BCH CashAddress.");
      }
      if (!evmRecipientAddr || !evmSenderAddr) {
        throw new Error("Connect Base wallet or enter the Base 0x address.");
      }

      const bchRecipientPkh = decodeCashAddressPkh(bchRecipientAddr);
      const bchRefundPkh = decodeCashAddressPkh(bchRefundAddr);
      const { makerTimeout, takerTimeout } = computePairedTimeouts();
      const bchTimeout =
        direction === "BCH_TO_BASE" ? makerTimeout : takerTimeout;
      const evmTimeout =
        direction === "BASE_TO_BCH" ? makerTimeout : takerTimeout;

      const { address: bchContractAddress, tokenAddress: bchContractTokenAddress } =
        deriveSwapLockContract({
          networkId,
          recipientPkh: bchRecipientPkh,
          refundPkh: bchRefundPkh,
          secretHash: finalHash,
          timeout: bchTimeout,
        });

      const evmLockId = computeEvmLockId({
        token: cfg.evmUsdcAddress,
        sender: evmSenderAddr,
        recipient: evmRecipientAddr,
        amount: usdcUnits,
        secretHash: finalHash,
        timeout: evmTimeout,
      });

      const newSwap = {
        id: `${Date.now()}-${finalHash.slice(2, 10)}`,
        createdAt: new Date().toISOString(),
        networkId,
        direction,
        displayAmount: amountInput,
        pusdUnits: pusdUnits.toString(),
        usdcUnits: usdcUnits.toString(),
        secret: finalSecret || "",
        secretHash: finalHash,
        bchRecipientAddr,
        bchRefundAddr,
        bchRecipientPkh,
        bchRefundPkh,
        bchTimeout,
        bchContractAddress,
        bchContractTokenAddress,
        evmSenderAddr,
        evmRecipientAddr,
        evmTimeout,
        evmLockId,
        evmContractAddr,
      };

      setSwaps((prev) => [newSwap, ...prev]);
      setSelectedSwapId(newSwap.id);
      setStatusMsg({
        type: "success",
        text: "Swap contract pair derived. Lock Maker funds first, then Taker funds.",
      });
    } catch (err) {
      setStatusMsg({ type: "error", text: err.message });
    }
  };

  const inspectSwapLocks = useCallback(
    async (swap) => {
      if (!swap) return;
      try {
        const bchState = await fetchContractLockState({
          networkId: swap.networkId,
          recipientPkh: swap.bchRecipientPkh,
          refundPkh: swap.bchRefundPkh,
          secretHash: swap.secretHash,
          timeout: swap.bchTimeout,
        });
        const lockContract =
          swap.evmContractAddr || swapLockAddresses[swap.networkId] || "";
        let evmState = null;
        if (lockContract) {
          evmState = await fetchEvmLockState({
            networkId: swap.networkId,
            swapLockAddress: lockContract,
            lockId: swap.evmLockId,
          });
          if (watcherActive && !swap.secret) {
            const revealed = await pollEvmClaimedSecret({
              networkId: swap.networkId,
              swapLockAddress: lockContract,
              lockId: swap.evmLockId,
            });
            if (revealed) {
              setSwaps((prev) =>
                prev.map((s) =>
                  s.id === swap.id ? { ...s, secret: revealed } : s
                )
              );
              setStatusMsg({
                type: "success",
                text: "Watcher captured revealed 32-byte secret from Base Claimed event!",
              });
            }
          }
        }
        setLockStates((prev) => ({
          ...prev,
          [swap.id]: {
            bchFunded: bchState.funded,
            bchPusd: bchState.pusdAmount.toString(),
            bchSats: bchState.bchSatoshis.toString(),
            evmState,
            checkedAt: new Date().toLocaleTimeString(),
          },
        }));
      } catch {
        // Ignore transient RPC polling errors
      }
    },
    [swapLockAddresses, watcherActive]
  );

  useEffect(() => {
    if (!activeSwap) return undefined;
    inspectSwapLocks(activeSwap);
    if (!watcherActive) return undefined;
    const timer = setInterval(() => inspectSwapLocks(activeSwap), 6000);
    return () => clearInterval(timer);
  }, [activeSwap, watcherActive, inspectSwapLocks]);

  const runSwapAction = async (actionKey, fn) => {
    try {
      setBusyAction(actionKey);
      await fn();
      await refreshBalances();
      if (activeSwap) await inspectSwapLocks(activeSwap);
    } catch (err) {
      setStatusMsg({ type: "error", text: err.message || "Transaction failed" });
    } finally {
      setBusyAction("");
    }
  };

  const activeLockInfo = activeSwap ? lockStates[activeSwap.id] : null;

  const saveConfig = () => {
    localStorage.setItem("blaze_slides_url", slidesUrl.trim());
    localStorage.setItem("blaze_donation_addr", donationAddr.trim());
    localStorage.setItem(
      "blaze_evm_lock_mainnet",
      swapLockAddresses.mainnet.trim()
    );
    localStorage.setItem(
      "blaze_evm_lock_chipnet",
      swapLockAddresses.chipnet.trim()
    );
    setShowSettings(false);
    setStatusMsg({ type: "success", text: "BLAZE links & contract config saved." });
  };

  return (
    <>
      <header className="blaze-banner">
        <div className="blaze-banner-inner">
          <div className="banner-links">
            <strong>BCH BLAZE 2026:</strong>
            <a
              className="banner-pill"
              href={BLAZE_COMPLIANCE.preDemoUrl}
              target="_blank"
              rel="noreferrer"
            >
              Pre-Nov 14 Demo
            </a>
            <a
              className="banner-pill"
              href={BLAZE_COMPLIANCE.preCodeUrl}
              target="_blank"
              rel="noreferrer"
            >
              Pre-Nov 14 Code
            </a>
            <a
              className="banner-pill"
              href={BLAZE_COMPLIANCE.liveDemoUrl}
              target="_blank"
              rel="noreferrer"
            >
              Live Demo
            </a>
            <a
              className="banner-pill"
              href={BLAZE_COMPLIANCE.liveCodeUrl}
              target="_blank"
              rel="noreferrer"
            >
              Current Repo
            </a>
            {slidesUrl ? (
              <a
                className="banner-pill"
                href={slidesUrl}
                target="_blank"
                rel="noreferrer"
              >
                Pitch Slides
              </a>
            ) : (
              <button
                type="button"
                className="banner-pill warn"
                onClick={() => setShowSettings(true)}
              >
                + Set Pitch Slides
              </button>
            )}
            {donationAddr ? (
              <span className="banner-pill mono" title={donationAddr}>
                EMBER2026: {shortAddr(donationAddr)}
              </span>
            ) : (
              <button
                type="button"
                className="banner-pill warn"
                onClick={() => setShowSettings(true)}
              >
                + Set CashTokens z... Addr
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setShowSettings((v) => !v)}
          >
            {showSettings ? "Close Config" : "Config"}
          </button>
        </div>
      </header>

      <nav className="topbar">
        <div className="brand">
          <span>BLAZE Swap</span>
          <span className="brand-badge">Non-Custodial HTLC</span>
        </div>

        <div className="wallet-bar">
          <select
            className="network-select"
            value={networkId}
            onChange={(e) => setNetworkId(e.target.value)}
            aria-label="Network pair"
          >
            <option value="mainnet">BCH Mainnet ↔ Base</option>
            <option value="chipnet">BCH Chipnet ↔ Base Sepolia</option>
          </select>

          {wcState === "connected" ? (
            <button
              type="button"
              className="btn"
              onClick={disconnectBch}
              title={bchAccount?.tokenAddress}
            >
              BCH: {shortAddr(bchAccount?.tokenAddress || walletName || "Connected")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={connectBch}
              disabled={wcState === "connecting"}
            >
              {wcState === "connecting" ? "Waiting BCH…" : "Connect WizardConnect"}
            </button>
          )}

          {evmAddress ? (
            <button
              type="button"
              className="btn btn-base"
              onClick={handleConnectEvm}
            >
              Base: {shortAddr(evmAddress)}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-base"
              onClick={handleConnectEvm}
              disabled={busyAction === "evm-connect"}
            >
              Connect Base Wallet
            </button>
          )}
        </div>
      </nav>

      <main className="container">
        {showSettings && (
          <section className="card" style={{ marginBottom: "1.25rem" }}>
            <h2 className="card-title">BLAZE Submission & Contract Configuration</h2>
            <div className="row-2">
              <div className="field">
                <label>Widget Factory Slides URL (5-6 slides)</label>
                <input
                  value={slidesUrl}
                  onChange={(e) => setSlidesUrl(e.target.value)}
                  placeholder="https://docs.google.com/presentation/..."
                />
              </div>
              <div className="field">
                <label>CashTokens Donation / EMBER2026 Address (z...)</label>
                <input
                  className="mono"
                  value={donationAddr}
                  onChange={(e) => setDonationAddr(e.target.value)}
                  placeholder="bitcoincash:z..."
                />
              </div>
              <div className="field">
                <label>Base Mainnet SwapLock.sol Address</label>
                <input
                  className="mono"
                  value={swapLockAddresses.mainnet}
                  onChange={(e) =>
                    setSwapLockAddresses((p) => ({ ...p, mainnet: e.target.value }))
                  }
                  placeholder="0x..."
                />
              </div>
              <div className="field">
                <label>Base Sepolia SwapLock.sol Address</label>
                <input
                  className="mono"
                  value={swapLockAddresses.chipnet}
                  onChange={(e) =>
                    setSwapLockAddresses((p) => ({ ...p, chipnet: e.target.value }))
                  }
                  placeholder="0x..."
                />
              </div>
            </div>
            <button type="button" className="btn btn-primary" onClick={saveConfig}>
              Save Configuration
            </button>
          </section>
        )}

        <section className="hero">
          <h1>Swap Base USDC and BCH ParyonUSD without a custodian.</h1>
          <p>
            One 32-byte SHA-256 secret atomically settles both CashScript P2SH32
            CashTokens and Base ERC-20 SwapLock contracts. If either side stalls,
            paired timelocks guarantee full self-refund.
          </p>
        </section>

        {wcError && <div className="alert alert-error">{String(wcError)}</div>}
        {statusMsg && (
          <div className={`alert alert-${statusMsg.type}`} style={{ marginBottom: "1rem" }}>
            {statusMsg.text}
          </div>
        )}

        <div className="grid-main">
          <section className="card">
            <h2 className="card-title">
              <span>1. Create Atomic Swap</span>
              <span className="small-muted">{cfg.label}</span>
            </h2>

            <div className="dir-toggle">
              <button
                type="button"
                className={`dir-btn ${direction === "BASE_TO_BCH" ? "active" : ""}`}
                onClick={() => setDirection("BASE_TO_BCH")}
              >
                Base {cfg.evmUsdcSymbol} → BCH {cfg.pusdSymbol}
              </button>
              <button
                type="button"
                className={`dir-btn ${direction === "BCH_TO_BASE" ? "active" : ""}`}
                onClick={() => setDirection("BCH_TO_BASE")}
              >
                BCH {cfg.pusdSymbol} → Base {cfg.evmUsdcSymbol}
              </button>
            </div>

            <form onSubmit={handleCreateSwap}>
              <div className="row-2">
                <div className="field">
                  <label>
                    <span>Swap Amount (1:1 USD Parity)</span>
                    <span>{cfg.pusdSymbol} / {cfg.evmUsdcSymbol}</span>
                  </label>
                  <input
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    placeholder="10.00"
                  />
                </div>
                <div className="field">
                  <label>
                    <span>Secret Hash (SHA-256)</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={handleGenerateSecret}
                    >
                      Generate
                    </button>
                  </label>
                  <input
                    className="mono"
                    value={secretHash}
                    onChange={(e) => setSecretHash(e.target.value)}
                    placeholder="Auto-generated if left blank"
                  />
                </div>
              </div>

              <div className="row-2">
                <div className="field">
                  <label>
                    <span>
                      {direction === "BASE_TO_BCH"
                        ? "Counterparty BCH Refund Addr"
                        : "Recipient BCH Token Addr (z...)"}
                    </span>
                  </label>
                  <input
                    className="mono"
                    value={counterpartyBch}
                    onChange={(e) => setCounterpartyBch(e.target.value)}
                    placeholder={`${cfg.bchPrefix}:z...`}
                  />
                </div>
                <div className="field">
                  <label>
                    <span>
                      {direction === "BCH_TO_BASE"
                        ? "Counterparty Base Sender (0x...)"
                        : "Recipient Base Addr (0x...)"}
                    </span>
                  </label>
                  <input
                    className="mono"
                    value={counterpartyEvm}
                    onChange={(e) => setCounterpartyEvm(e.target.value)}
                    placeholder="0x..."
                  />
                </div>
              </div>

              {secretHex && (
                <div className="field">
                  <label>Preimage Secret (keep private until Maker claims!)</label>
                  <input
                    className="mono"
                    value={secretHex}
                    onChange={(e) => setSecretHex(e.target.value)}
                  />
                </div>
              )}

              <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
                Derive CashScript P2SH32 & Base SwapLock Pair
              </button>
            </form>
          </section>

          <section className="card">
            <h2 className="card-title">
              <span>Live Bridge & Wallet Telemetry</span>
              <button type="button" className="btn btn-sm" onClick={refreshBalances}>
                Refresh
              </button>
            </h2>

            <div className="stat-grid">
              <div className="stat-box">
                <div className="stat-label">Connected {cfg.pusdSymbol}</div>
                <div className="stat-value">
                  {formatTokenUnits(balances.pusdAmount, cfg.pusdDecimals)}{" "}
                  {cfg.pusdSymbol}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Connected BCH Gas</div>
                <div className="stat-value">
                  {formatTokenUnits(balances.bchSatoshis, 8)} BCH
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Connected Base {cfg.evmUsdcSymbol}</div>
                <div className="stat-value">
                  {formatTokenUnits(balances.usdcBalance, cfg.evmUsdcDecimals)}{" "}
                  {cfg.evmUsdcSymbol}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-label">In-Browser Watcher</div>
                <div className="stat-value" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span>{watcherActive ? "Active (6s)" : "Paused"}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setWatcherActive((v) => !v)}
                  >
                    {watcherActive ? "Pause" : "Resume"}
                  </button>
                </div>
              </div>
            </div>

            <div className="small-muted">
              <div>
                <strong>{cfg.pusdSymbol} Category:</strong>{" "}
                <span className="mono">{shortAddr(cfg.pusdCategory)}</span>
              </div>
              <div>
                <strong>Base {cfg.evmUsdcSymbol}:</strong>{" "}
                <span className="mono">{shortAddr(cfg.evmUsdcAddress)}</span>
              </div>
              <div>
                <strong>Base SwapLock.sol:</strong>{" "}
                <span className="mono">
                  {evmContractAddr ? shortAddr(evmContractAddr) : "Not set (click Config)"}
                </span>
              </div>
            </div>
          </section>
        </div>

        <section className="card" style={{ marginTop: "1.25rem" }}>
          <h2 className="card-title">
            <span>2. Execute & Settle Active Swap</span>
            <span className="small-muted">{swaps.length} saved session(s)</span>
          </h2>

          {!activeSwap ? (
            <p className="small-muted">
              Create an atomic swap above to inspect live BCH P2SH32 & Base lock states.
            </p>
          ) : (
            <div className="swap-session highlight">
              <div className="row-2">
                <div>
                  <div className="small-muted">
                    Direction: <strong>{activeSwap.direction}</strong> ·{" "}
                    <strong>{activeSwap.displayAmount} USD</strong>
                  </div>
                  <div className="small-muted mono" style={{ marginTop: "0.25rem" }}>
                    Hash: {shortAddr(activeSwap.secretHash)}
                  </div>
                  <div className="small-muted mono">
                    BCH Lock (z...): {activeSwap.bchContractTokenAddress}
                  </div>
                  <div className="small-muted mono">
                    Base Lock ID: {shortAddr(activeSwap.evmLockId)}
                  </div>
                </div>
                <div>
                  <div className="small-muted">
                    <strong>BCH Contract:</strong>{" "}
                    {activeLockInfo?.bchFunded
                      ? `Funded (${formatTokenUnits(
                          activeLockInfo.bchPusd,
                          cfg.pusdDecimals
                        )} ${cfg.pusdSymbol}, ${activeLockInfo.bchSats} sats)`
                      : "Unfunded / Spent"}
                  </div>
                  <div className="small-muted">
                    <strong>Base Contract:</strong>{" "}
                    {activeLockInfo?.evmState?.exists
                      ? activeLockInfo.evmState.settled
                        ? "Settled"
                        : `Locked (${formatTokenUnits(
                            activeLockInfo.evmState.amount,
                            cfg.evmUsdcDecimals
                          )} USDC)`
                      : evmContractAddr
                      ? "Unfunded"
                      : "Set Base SwapLock.sol in Config"}
                  </div>
                  <div className="small-muted">
                    <strong>Secret Captured:</strong>{" "}
                    {activeSwap.secret ? (
                      <span className="mono">{shortAddr(activeSwap.secret)}</span>
                    ) : (
                      "Waiting for Claimed event..."
                    )}
                  </div>
                </div>
              </div>

              <div className="actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!!busyAction || !manager || !bchAccount}
                  onClick={() =>
                    runSwapAction("bch-lock", async () => {
                      const { txid } = await fundBchSwapLockWithWallet({
                        networkId: activeSwap.networkId,
                        manager,
                        senderAddress: bchAccount.cashAddress,
                        senderTokenAddress: bchAccount.tokenAddress,
                        contractTokenAddress: activeSwap.bchContractTokenAddress,
                        pusdAmount: BigInt(activeSwap.pusdUnits),
                      });
                      setStatusMsg({ type: "success", text: `BCH Lock tx: ${txid}` });
                    })
                  }
                >
                  Lock {cfg.pusdSymbol} (WizardConnect)
                </button>

                <button
                  type="button"
                  className="btn btn-base"
                  disabled={!!busyAction || !evmAddress || !evmContractAddr}
                  onClick={() =>
                    runSwapAction("evm-lock", async () => {
                      if (balances.usdcAllowance < BigInt(activeSwap.usdcUnits)) {
                        await approveEvmUsdc({
                          networkId: activeSwap.networkId,
                          account: evmAddress,
                          swapLockAddress: evmContractAddr,
                          amount: BigInt(activeSwap.usdcUnits),
                        });
                      }
                      const { hash } = await lockEvmSwap({
                        networkId: activeSwap.networkId,
                        account: evmAddress,
                        swapLockAddress: evmContractAddr,
                        recipient: activeSwap.evmRecipientAddr,
                        amount: BigInt(activeSwap.usdcUnits),
                        secretHash: activeSwap.secretHash,
                        timeout: activeSwap.evmTimeout,
                      });
                      setStatusMsg({ type: "success", text: `Base Lock tx: ${hash}` });
                    })
                  }
                >
                  Approve & Lock Base USDC
                </button>

                <button
                  type="button"
                  className="btn"
                  disabled={!!busyAction || !manager || !bchAccount || !activeSwap.secret}
                  onClick={() =>
                    runSwapAction("bch-claim", async () => {
                      const { txid } = await claimBchSwapLock({
                        networkId: activeSwap.networkId,
                        manager,
                        recipientPkh: activeSwap.bchRecipientPkh,
                        refundPkh: activeSwap.bchRefundPkh,
                        secretHash: activeSwap.secretHash,
                        timeout: activeSwap.bchTimeout,
                        secretHex: activeSwap.secret,
                        recipientTokenAddress: bchAccount.tokenAddress,
                      });
                      setStatusMsg({ type: "success", text: `BCH Claim tx: ${txid}` });
                    })
                  }
                >
                  Claim BCH {cfg.pusdSymbol}
                </button>

                <button
                  type="button"
                  className="btn"
                  disabled={
                    !!busyAction || !evmAddress || !evmContractAddr || !activeSwap.secret
                  }
                  onClick={() =>
                    runSwapAction("evm-claim", async () => {
                      const { hash } = await claimEvmSwap({
                        networkId: activeSwap.networkId,
                        account: evmAddress,
                        swapLockAddress: evmContractAddr,
                        lockId: activeSwap.evmLockId,
                        secretHex: activeSwap.secret,
                      });
                      setStatusMsg({ type: "success", text: `Base Claim tx: ${hash}` });
                    })
                  }
                >
                  Claim Base USDC
                </button>

                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!!busyAction || !manager || !bchAccount}
                  onClick={() =>
                    runSwapAction("bch-refund", async () => {
                      const { txid } = await refundBchSwapLock({
                        networkId: activeSwap.networkId,
                        manager,
                        recipientPkh: activeSwap.bchRecipientPkh,
                        refundPkh: activeSwap.bchRefundPkh,
                        secretHash: activeSwap.secretHash,
                        timeout: activeSwap.bchTimeout,
                        refundTokenAddress: bchAccount.tokenAddress,
                      });
                      setStatusMsg({ type: "success", text: `BCH Refund tx: ${txid}` });
                    })
                  }
                >
                  Refund BCH
                </button>

                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!!busyAction || !evmAddress || !evmContractAddr}
                  onClick={() =>
                    runSwapAction("evm-refund", async () => {
                      const { hash } = await refundEvmSwap({
                        networkId: activeSwap.networkId,
                        account: evmAddress,
                        swapLockAddress: evmContractAddr,
                        lockId: activeSwap.evmLockId,
                      });
                      setStatusMsg({ type: "success", text: `Base Refund tx: ${hash}` });
                    })
                  }
                >
                  Refund Base
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      {uri && qrUri && (
        <WizardConnectQRDialog
          show={wcState === "connecting"}
          onClose={disconnectBch}
          uri={uri}
          qrUri={qrUri}
        />
      )}
    </>
  );
}
