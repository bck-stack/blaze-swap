import { useCallback, useEffect, useMemo, useState } from "react";
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";
import DeskSwap from "./DeskSwap.jsx";
import {
  BLAZE_COMPLIANCE,
  NETWORK_CONFIG,
  computeEvmLockId,
  computePairedTimeouts,
  decodeCashAddressPkh,
  decodeOffer,
  encodeOffer,
  swapLegs,
  swapSteps,
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
  pollBchClaimedSecret,
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

function txUrl(networkId, chain, hash) {
  const cfg = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.mainnet;
  return chain === "bch" ? `${cfg.bchExplorerTx}${hash}` : `${cfg.evmExplorerTx}${hash}`;
}

function readOfferFromHash() {
  const m = globalThis.location?.hash?.match(/^#offer=([A-Za-z0-9_-]+)$/);
  if (!m) return { offer: null, error: "" };
  try {
    return { offer: decodeOffer(m[1]), error: "" };
  } catch (err) {
    return { offer: null, error: err.message };
  }
}

const PROOF = {
  baseContract: "0xf66642c35cf4a36fcd7d3bcf87422791280f8901",
  baseTxs: [
    ["Deploy SwapLock.sol", "0xd3e8ba9cdf673271ec88cb5b85ccefcd5d57afdedcaa5ac5b61019a8391dd46b"],
    ["Approve USDC", "0xa62e829eb4127dacf65c0b01a20d0b56a95556574d3628028187f42e52f368f4"],
    ["Lock 0.05 USDC", "0x9d2c64dada3e465ff4c5567e9fc35c88f3a5c9795d46b3fd05b44e3aa071bbe6"],
    ["Claim with the secret", "0x1a3c0b8e98f14e7dda9df90365a04e08deac7217946e4d0b722c1620a71e1d1c"],
  ],
  // 17 Nov 2026, web/scripts/mainnet-swap.mjs: one swap across both mainnets under one sha256 hash.
  swap: [
    ["1. Maker locks 0.05 USDC on Base", "base", "0xd350ad6f7239cc2206a16ae524c6edefab9935caa31b595ea3907358ce7f216b"],
    ["2. Taker locks 0.00005 BCH on Bitcoin Cash", "bch", "b37aed3b840f683eadfc1f0a2dab9847077df5f833de1baa7a0364e3e023c574"],
    ["3. Maker claims the BCH, the secret goes on chain", "bch", "452e7b7cedc59ef6bdb891d42d05c9bf0370b30462744df17ac339952a6e73ea"],
    ["4. Taker claims the USDC with that secret", "base", "0x837b4c5097123f761e2baf34e00b88dd43a47b4265b6f0255dd15b0b7f9e1a0e"],
  ],
  // 18 Nov 2026, the same script with --asset pusd: PUSD (ParyonUSD) on the Bitcoin Cash side.
  pusdSwap: [
    ["1. Maker locks 0.05 USDC on Base", "base", "0xd19620f7f2766ceba2cc153c2eec279ae4acad125d153620f209ea05fc94a549"],
    ["2. Taker locks 0.05 PUSD on Bitcoin Cash", "bch", "1303e2e848abfc1e5d2c888691308f3dbf4e70e66237b6e7826bfa2340a5652e"],
    ["3. Maker claims the PUSD, the secret goes on chain", "bch", "7e5c671d8034865accbb75533be5ad53e95e19e6ef755b9629506e387c355b6c"],
    ["4. Taker claims the USDC with that secret", "base", "0x7bebee51e3c1cf08a21e0618b667fc39ab0b66f88adee0e4421d932d72867ac7"],
  ],
};

export default function App() {
  // "desk": one wallet swaps against the BLAZE Desk (default). "p2p": two people swap with a share link.
  const [view, setView] = useState(() => (globalThis.location?.hash?.startsWith("#offer=") ? "p2p" : "desk"));
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

  const [incoming, setIncoming] = useState(() => readOfferFromHash());
  const [copied, setCopied] = useState(false);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
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
    const onHash = () => setIncoming(readOfferFromHash());
    globalThis.addEventListener("hashchange", onHash);
    const tick = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 15000);
    return () => {
      globalThis.removeEventListener("hashchange", onHash);
      clearInterval(tick);
    };
  }, []);

  const appendTx = useCallback((swapId, label, chain, hash) => {
    setSwaps((prev) =>
      prev.map((s) =>
        s.id === swapId && !(s.txs || []).some((t) => t.hash === hash)
          ? { ...s, txs: [...(s.txs || []), { label, chain, hash, at: new Date().toISOString() }] }
          : s
      )
    );
  }, []);

  const importIncoming = () => {
    const offer = incoming.offer;
    if (!offer) return;
    const existing = swaps.find((s) => s.secretHash === offer.secretHash);
    if (existing) {
      setSelectedSwapId(existing.id);
    } else {
      const { address, tokenAddress } = deriveSwapLockContract({
        networkId: offer.networkId,
        recipientPkh: offer.bchRecipientPkh,
        refundPkh: offer.bchRefundPkh,
        secretHash: offer.secretHash,
        timeout: offer.bchTimeout,
      });
      const swap = {
        ...offer,
        id: `${Date.now()}-${offer.secretHash.slice(2, 10)}`,
        createdAt: new Date().toISOString(),
        role: "taker",
        secret: "",
        bchContractAddress: address,
        bchContractTokenAddress: tokenAddress,
        txs: [],
      };
      setSwaps((prev) => [swap, ...prev]);
      setSelectedSwapId(swap.id);
    }
    setNetworkId(offer.networkId);
    setIncoming({ offer: null, error: "" });
    globalThis.history?.replaceState(null, "", globalThis.location.pathname);
    setStatusMsg({
      type: "info",
      text: "Offer imported. The page recomputed both lock addresses from its terms; wait for the maker's lock to show up before you lock yours.",
    });
  };

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
        role: "maker",
        txs: [],
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
        text: "Swap created. Lock your side, then send the share link to the other party.",
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
        const evmState = lockContract
          ? await fetchEvmLockState({
              networkId: swap.networkId,
              swapLockAddress: lockContract,
              lockId: swap.evmLockId,
            })
          : null;

        // The secret only exists on chain after a claim, so look for it only once a lock has been spent.
        let captured = null;
        if (watcherActive && !swap.secret) {
          if (evmState?.settled) {
            captured = await pollEvmClaimedSecret({
              networkId: swap.networkId,
              swapLockAddress: lockContract,
              lockId: swap.evmLockId,
            });
            if (captured) captured.chain = "base";
          }
          if (!captured && bchState.spent) {
            captured = await pollBchClaimedSecret({
              networkId: swap.networkId,
              contractAddress: swap.bchContractAddress,
              secretHash: swap.secretHash,
              history: bchState.history,
            });
            if (captured) captured.chain = "bch";
          }
        }
        if (captured) {
          setSwaps((prev) =>
            prev.map((s) =>
              s.id === swap.id ? { ...s, secret: captured.secret } : s
            )
          );
          appendTx(swap.id, "Maker's claim (secret revealed)", captured.chain, captured.txid);
          setStatusMsg({
            type: "success",
            text: "The maker claimed and the secret is now public on chain. You can claim your side.",
          });
        }
        setLockStates((prev) => ({
          ...prev,
          [swap.id]: {
            bch: {
              funded: bchState.funded,
              spent: bchState.spent,
              amountOk: bchState.pusdAmount >= BigInt(swap.pusdUnits),
              pusd: bchState.pusdAmount.toString(),
              sats: bchState.bchSatoshis.toString(),
            },
            base: evmState
              ? {
                  exists: evmState.exists,
                  settled: evmState.settled,
                  amountOk: evmState.exists && evmState.amount >= BigInt(swap.usdcUnits),
                  amount: evmState.amount.toString(),
                }
              : null,
            checkedAt: new Date().toLocaleTimeString(),
          },
        }));
      } catch {
        // Ignore transient RPC polling errors
      }
    },
    [swapLockAddresses, watcherActive, appendTx]
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

  const sameEvm = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  const lockSide = async (swap, chain) => {
    if (chain === "bch") {
      if (!manager || !bchAccount) throw new Error("Connect your BCH wallet with WizardConnect first.");
      if (bchAccount.pkhHex !== swap.bchRefundPkh) {
        throw new Error("The connected BCH wallet is not the one named in this swap as the sender.");
      }
      const { txid } = await fundBchSwapLockWithWallet({
        networkId: swap.networkId,
        manager,
        senderAddress: bchAccount.cashAddress,
        senderTokenAddress: bchAccount.tokenAddress,
        contractTokenAddress: swap.bchContractTokenAddress,
        pusdAmount: BigInt(swap.pusdUnits),
      });
      appendTx(swap.id, `Lock ${NETWORK_CONFIG[swap.networkId].pusdSymbol}`, "bch", txid);
      return;
    }
    if (!evmAddress) throw new Error("Connect your Base wallet first.");
    if (!sameEvm(evmAddress, swap.evmSenderAddr)) {
      throw new Error("The connected Base wallet is not the one named in this swap as the sender.");
    }
    const lockAddr = swap.evmContractAddr || evmContractAddr;
    if (balances.usdcAllowance < BigInt(swap.usdcUnits)) {
      const { hash } = await approveEvmUsdc({
        networkId: swap.networkId,
        account: evmAddress,
        swapLockAddress: lockAddr,
        amount: BigInt(swap.usdcUnits),
      });
      appendTx(swap.id, "Approve USDC", "base", hash);
    }
    const { hash } = await lockEvmSwap({
      networkId: swap.networkId,
      account: evmAddress,
      swapLockAddress: lockAddr,
      recipient: swap.evmRecipientAddr,
      amount: BigInt(swap.usdcUnits),
      secretHash: swap.secretHash,
      timeout: swap.evmTimeout,
    });
    appendTx(swap.id, "Lock USDC", "base", hash);
  };

  const claimSide = async (swap, chain) => {
    if (!swap.secret) throw new Error("The secret is not known yet.");
    if (chain === "bch") {
      if (!manager || !bchAccount) throw new Error("Connect your BCH wallet with WizardConnect first.");
      if (bchAccount.pkhHex !== swap.bchRecipientPkh) {
        throw new Error("The connected BCH wallet is not the recipient of this lock.");
      }
      const { txid } = await claimBchSwapLock({
        networkId: swap.networkId,
        manager,
        recipientPkh: swap.bchRecipientPkh,
        refundPkh: swap.bchRefundPkh,
        secretHash: swap.secretHash,
        timeout: swap.bchTimeout,
        secretHex: swap.secret,
        recipientTokenAddress: bchAccount.tokenAddress,
      });
      appendTx(swap.id, `Claim ${NETWORK_CONFIG[swap.networkId].pusdSymbol}`, "bch", txid);
      return;
    }
    if (!evmAddress) throw new Error("Connect a Base wallet first (any wallet can submit; the USDC always goes to the recipient).");
    const { hash } = await claimEvmSwap({
      networkId: swap.networkId,
      account: evmAddress,
      swapLockAddress: swap.evmContractAddr || evmContractAddr,
      lockId: swap.evmLockId,
      secretHex: swap.secret,
    });
    appendTx(swap.id, "Claim USDC", "base", hash);
  };

  const refundSide = async (swap, chain) => {
    if (chain === "bch") {
      if (!manager || !bchAccount) throw new Error("Connect your BCH wallet with WizardConnect first.");
      if (bchAccount.pkhHex !== swap.bchRefundPkh) {
        throw new Error("The connected BCH wallet is not the refund address of this lock.");
      }
      const { txid } = await refundBchSwapLock({
        networkId: swap.networkId,
        manager,
        recipientPkh: swap.bchRecipientPkh,
        refundPkh: swap.bchRefundPkh,
        secretHash: swap.secretHash,
        timeout: swap.bchTimeout,
        refundTokenAddress: bchAccount.tokenAddress,
      });
      appendTx(swap.id, "Refund on BCH", "bch", txid);
      return;
    }
    if (!evmAddress) throw new Error("Connect a Base wallet first.");
    const { hash } = await refundEvmSwap({
      networkId: swap.networkId,
      account: evmAddress,
      swapLockAddress: swap.evmContractAddr || evmContractAddr,
      lockId: swap.evmLockId,
    });
    appendTx(swap.id, "Refund on Base", "base", hash);
  };

  const shareLink = activeSwap
    ? `${globalThis.location.origin}${globalThis.location.pathname}#offer=${encodeOffer(activeSwap)}`
    : "";

  const copyShareLink = async () => {
    try {
      await globalThis.navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setStatusMsg({ type: "error", text: "Copy failed; select the link and copy it by hand." });
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

        <div className="view-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view === "desk"} className={view === "desk" ? "on" : ""} onClick={() => { setView("desk"); setNetworkId("mainnet"); }}>
            Swap
          </button>
          <button type="button" role="tab" aria-selected={view === "p2p"} className={view === "p2p" ? "on" : ""} onClick={() => setView("p2p")}>
            Peer to peer
          </button>
        </div>

        {view === "desk" ? (
          <DeskSwap
            manager={manager}
            bchAccount={bchAccount}
            wcState={wcState}
            connectBch={connectBch}
            evmAddress={evmAddress}
            onConnectEvm={handleConnectEvm}
            balances={balances}
          />
        ) : (
        <>
        <section className="hero">
          <h1>Swap with someone you know, using a share link.</h1>
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

        {incoming.error && (
          <div className="alert alert-error">Offer link rejected: {incoming.error}</div>
        )}
        {incoming.offer && (
          <section className="card offer-card">
            <h2 className="card-title">
              <span>Swap offer for you</span>
              <span className="small-muted">{NETWORK_CONFIG[incoming.offer.networkId].label}</span>
            </h2>
            <p>
              {incoming.offer.direction === "BASE_TO_BCH"
                ? `The maker locks ${incoming.offer.displayAmount} USDC on Base for you. You lock ${incoming.offer.displayAmount} ${NETWORK_CONFIG[incoming.offer.networkId].pusdSymbol} on BCH for them.`
                : `The maker locks ${incoming.offer.displayAmount} ${NETWORK_CONFIG[incoming.offer.networkId].pusdSymbol} on BCH for you. You lock ${incoming.offer.displayAmount} USDC on Base for them.`}
            </p>
            <div className="small-muted mono">
              <div>Your BCH address: {incoming.offer.direction === "BASE_TO_BCH" ? incoming.offer.bchRefundAddr : incoming.offer.bchRecipientAddr}</div>
              <div>Your Base address: {incoming.offer.direction === "BASE_TO_BCH" ? incoming.offer.evmRecipientAddr : incoming.offer.evmSenderAddr}</div>
              <div>Your lock refunds after: {new Date((incoming.offer.direction === "BASE_TO_BCH" ? incoming.offer.bchTimeout : incoming.offer.evmTimeout) * 1000).toLocaleString()}</div>
            </div>
            <p className="small-muted">
              Nothing is locked yet. Import the offer, connect the two wallets above, and lock only after the page shows the maker&apos;s lock on chain.
            </p>
            <button type="button" className="btn btn-primary" onClick={importIncoming}>
              Import offer as taker
            </button>
          </section>
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
              <span>Wallet & Lock Status</span>
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

        <SwapSession
          swap={activeSwap}
          swaps={swaps}
          onSelect={setSelectedSwapId}
          lockInfo={activeLockInfo}
          nowSec={nowSec}
          busyAction={busyAction}
          shareLink={shareLink}
          copied={copied}
          onCopy={copyShareLink}
          onLock={(chain) => runSwapAction(`lock-${chain}`, () => lockSide(activeSwap, chain))}
          onClaim={(chain) => runSwapAction(`claim-${chain}`, () => claimSide(activeSwap, chain))}
          onRefund={(chain) => runSwapAction(`refund-${chain}`, () => refundSide(activeSwap, chain))}
        />

        <section className="card proof">
          <h2 className="card-title">
            <span>On mainnet</span>
            <span className="small-muted">Bitcoin Cash + Base 8453</span>
          </h2>
          <p className="small-muted">One swap settled across both mainnets under the same hash:</p>
          <ul className="tx-list">
            {PROOF.swap.map(([label, chain, hash]) => (
              <li key={hash}>
                <span>{label}</span>
                <a className="mono" href={txUrl("mainnet", chain, hash)} target="_blank" rel="noreferrer">
                  {shortAddr(hash)}
                </a>
              </li>
            ))}
          </ul>
          <p className="small-muted">The same with PUSD, the BCH stablecoin, on the Bitcoin Cash side:</p>
          <ul className="tx-list">
            {PROOF.pusdSwap.map(([label, chain, hash]) => (
              <li key={hash}>
                <span>{label}</span>
                <a className="mono" href={txUrl("mainnet", chain, hash)} target="_blank" rel="noreferrer">
                  {shortAddr(hash)}
                </a>
              </li>
            ))}
          </ul>
          <p className="small-muted">
            SwapLock.sol is deployed and source-verified at{" "}
            <a className="mono" href={`https://base.blockscout.com/address/${PROOF.baseContract}`} target="_blank" rel="noreferrer">
              {shortAddr(PROOF.baseContract)}
            </a>
            . A real 0.05 USDC lock was claimed with its secret:
          </p>
          <ul className="tx-list">
            {PROOF.baseTxs.map(([label, hash]) => (
              <li key={hash}>
                <span>{label}</span>
                <a className="mono" href={txUrl("mainnet", "base", hash)} target="_blank" rel="noreferrer">
                  {shortAddr(hash)}
                </a>
              </li>
            ))}
          </ul>
        </section>
        </>
        )}
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

const CHAIN_NAME = { bch: "BCH", base: "Base" };

function SwapSession({
  swap,
  swaps,
  onSelect,
  lockInfo,
  nowSec,
  busyAction,
  shareLink,
  copied,
  onCopy,
  onLock,
  onClaim,
  onRefund,
}) {
  if (!swap) {
    return (
      <section className="card" style={{ marginTop: "1.25rem" }}>
        <h2 className="card-title">2. Settle the swap</h2>
        <p className="small-muted">
          Create a swap above, or open a share link from the other party, to follow both locks live.
        </p>
      </section>
    );
  }
  const cfg = NETWORK_CONFIG[swap.networkId] || NETWORK_CONFIG.mainnet;
  const role = swap.role || "maker";
  const { makerChain, takerChain } = swapLegs(swap.direction);
  const lock = { bch: lockInfo?.bch, base: lockInfo?.base };
  const flow = swapSteps({
    role,
    direction: swap.direction,
    lock,
    hasSecret: !!swap.secret,
    nowSec,
    bchTimeout: swap.bchTimeout,
    evmTimeout: swap.evmTimeout,
  });
  const myLockChain = role === "maker" ? makerChain : takerChain;
  const myClaimChain = role === "maker" ? takerChain : makerChain;
  const timeoutOf = (chain) => (chain === "bch" ? swap.bchTimeout : swap.evmTimeout);
  const busy = !!busyAction;
  const fmtTime = (t) => new Date(t * 1000).toLocaleString();
  const sideText = (chain) => {
    if (chain === "bch") {
      const b = lock.bch;
      if (!b) return "checking…";
      if (b.funded) {
        const amt = `${formatTokenUnits(b.pusd, cfg.pusdDecimals)} ${cfg.pusdSymbol}`;
        return b.amountOk ? `locked: ${amt}` : `locked with the WRONG amount: ${amt}`;
      }
      return b.spent ? "spent (claimed or refunded)" : "empty";
    }
    const e = lock.base;
    if (!e) return swap.evmContractAddr ? "checking…" : "no Base contract set";
    if (!e.exists) return "empty";
    if (e.settled) return "spent (claimed or refunded)";
    return `locked: ${formatTokenUnits(e.amount, cfg.evmUsdcDecimals)} USDC`;
  };

  let nextBox;
  if (flow.next === "maker-lock" || flow.next === "taker-lock") {
    nextBox = (
      <>
        <p>
          {flow.next === "taker-lock"
            ? `The maker's lock on ${CHAIN_NAME[makerChain]} is on chain with the right amount. Lock your side on ${CHAIN_NAME[takerChain]}; it comes back to you after ${fmtTime(timeoutOf(takerChain))} if the maker never claims.`
            : `Lock your side on ${CHAIN_NAME[makerChain]}. It comes back to you after ${fmtTime(timeoutOf(makerChain))} if the swap stalls. Then send the share link below.`}
        </p>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onLock(myLockChain)}>
          {myLockChain === "bch" ? `Lock ${cfg.pusdSymbol} on BCH` : "Approve & lock USDC on Base"}
        </button>
      </>
    );
  } else if (flow.next === "maker-claim" || flow.next === "taker-claim") {
    nextBox = (
      <>
        <p>
          {flow.next === "maker-claim"
            ? `The taker locked on ${CHAIN_NAME[takerChain]}. Claim it now. Your claim puts the secret on chain, and that is what lets the taker claim your side.`
            : `The secret is public. Claim your side on ${CHAIN_NAME[makerChain]} before ${fmtTime(timeoutOf(makerChain))}.`}
        </p>
        <button type="button" className="btn btn-primary" disabled={busy || !swap.secret} onClick={() => onClaim(myClaimChain)}>
          {myClaimChain === "bch" ? `Claim ${cfg.pusdSymbol} on BCH` : "Claim USDC on Base"}
        </button>
      </>
    );
  } else if (flow.next === "too-late") {
    nextBox = <p>Less than an hour is left on the taker&apos;s lock window. Do not lock; ask the maker for a fresh offer.</p>;
  } else if (flow.next === "wait") {
    nextBox = <p>Waiting for the {role === "maker" ? "taker" : "maker"}. This page checks both chains every 6 seconds.</p>;
  } else {
    nextBox = <p>Both sides settled. The swap is complete.</p>;
  }

  return (
    <section className="card" style={{ marginTop: "1.25rem" }}>
      <h2 className="card-title">
        <span>2. Settle the swap</span>
        {swaps.length > 1 ? (
          <select className="network-select" value={swap.id} onChange={(e) => onSelect(e.target.value)} aria-label="Saved swaps">
            {swaps.map((s) => (
              <option key={s.id} value={s.id}>
                {(s.role || "maker") === "maker" ? "Maker" : "Taker"} · {s.displayAmount} · {new Date(s.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        ) : null}
      </h2>

      <div className="swap-session highlight">
        <div className="small-muted">
          You are the <strong>{role}</strong> · {swap.displayAmount} {cfg.pusdSymbol} ⇄ {swap.displayAmount} USDC · {cfg.label}
        </div>
        <div className="small-muted mono" style={{ marginTop: "0.25rem" }}>
          Hash {shortAddr(swap.secretHash)} · BCH lock {shortAddr(swap.bchContractTokenAddress)} · Base lock id {shortAddr(swap.evmLockId)}
        </div>

        <ol className="steps">
          {flow.steps.map((st) => (
            <li key={st.key} className={st.done ? "done" : st.key === flow.current ? "current" : ""}>
              <span className="step-label">{st.label}</span>
              <span className="small-muted">
                {CHAIN_NAME[st.chain]}
                {st.key.endsWith("lock") ? ` · ${sideText(st.chain)}` : ""}
              </span>
            </li>
          ))}
        </ol>

        <div className="next-box">{nextBox}</div>

        {flow.canRefund ? (
          <div className="next-box warn">
            <p>Your lock expired without a claim. Take your coins back.</p>
            <button type="button" className="btn" disabled={busy} onClick={() => onRefund(myLockChain)}>
              Refund on {CHAIN_NAME[myLockChain]}
            </button>
          </div>
        ) : null}

        {role === "maker" ? (
          <div className="field" style={{ marginTop: "0.75rem" }}>
            <label>
              <span>Share link for the taker (no secret inside; their page rebuilds both locks from it)</span>
              <button type="button" className="btn btn-sm" onClick={onCopy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </label>
            <input className="mono" readOnly value={shareLink} onFocus={(e) => e.target.select()} />
          </div>
        ) : null}

        {(swap.txs || []).length > 0 ? (
          <ul className="tx-list">
            {swap.txs.map((t) => (
              <li key={t.hash}>
                <span>
                  {t.label} ({CHAIN_NAME[t.chain]})
                </span>
                <a className="mono" href={txUrl(swap.networkId, t.chain, t.hash)} target="_blank" rel="noreferrer">
                  {shortAddr(t.hash)}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {lockInfo?.checkedAt ? <div className="small-muted">Last checked {lockInfo.checkedAt}</div> : null}
      </div>
    </section>
  );
}
