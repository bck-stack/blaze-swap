// Pre-hackathon base (before BCH BLAZE, 14 Nov 2026): only the BCH wallet connection over WizardConnect.
// The swap itself (lock, claim, refund, the Base side over WalletConnect) is built during the hackathon.
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";

export default function App() {
  const { state, uri, qrUri, walletName, connect, disconnect, error } = useWizardConnect({ dappName: "BCH Stablecoin Swap" });
  return (
    <main>
      <h1>BCH Stablecoin Swap</h1>
      <p className="muted">Pre-hackathon base: wallet connection only.</p>
      <section className="card">
        <h2>BCH wallet</h2>
        {state === "connected" ? (
          <p>Connected to <b>{walletName ?? "wallet"}</b> <button onClick={disconnect}>Disconnect</button></p>
        ) : (
          <button onClick={connect} disabled={state === "connecting"}>{state === "connecting" ? "Waiting for the wallet…" : "Connect with WizardConnect"}</button>
        )}
        {error && <p className="error">{error}</p>}
      </section>
      {uri && qrUri && <WizardConnectQRDialog show={state === "connecting"} onClose={disconnect} uri={uri} qrUri={qrUri} />}
    </main>
  );
}
