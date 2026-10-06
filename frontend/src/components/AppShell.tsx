import type { ReactNode } from "react";
import { TopNav, type Screen } from "./TopNav";
import { Toast, type ToastMessage } from "./Toast";
import { useState } from "react";
import { HealthIndicator } from "./Primitives";

export function AppShell({
  screen,
  onScreenChange,
  health,
  notice,
  children,
}: {
  screen: Screen;
  onScreenChange: (screen: Screen) => void;
  health: string | undefined;
  notice: ToastMessage | null;
  children: ReactNode;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  function changeScreen(next: Screen) {
    onScreenChange(next);
    setMobileNavOpen(false);
  }
  return (
    <div className="app-frame">
      <header>
        <div className="header-primary">
          <a className="brand" href="/" aria-label="Setra402 home">
            <span className="brand-symbol" aria-hidden="true">
              S
            </span>
            <span className="brand-name">Setra402</span>
          </a>
          <div className="header-status">
            <span className="environment-label">Local environment</span>
            <HealthIndicator
              state={health}
              label={
                health === "HEALTHY" ? "Operational" : health ?? "Checking"
              }
            />
          </div>
          <button
            className="mobile-nav-toggle"
            type="button"
            aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
            aria-controls="primary-navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
        <div className={`header-navigation ${mobileNavOpen ? "is-open" : ""}`}>
          <div id="primary-navigation">
            <TopNav active={screen} onChange={changeScreen} />
          </div>
        </div>
      </header>
      <main>
        <Toast message={notice} />
        {children}
      </main>
      <footer>
        <span>Setra402 · local control plane</span>
        <span>Deterministic contracts · independent verification</span>
      </footer>
    </div>
  );
}
