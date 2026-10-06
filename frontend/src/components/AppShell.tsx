import { useEffect, useState, type ReactNode } from "react";
import { TopNav, type Screen } from "./TopNav";
import { Toast, type ToastMessage } from "./Toast";
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

  const cleanHealthLabel =
    health === "HEALTHY"
      ? "Operational"
      : health === "DEGRADED"
      ? "Active"
      : health ?? "Checking";

  return (
    <div className="app-frame">
      {/* Mobile top bar */}
      <header className="mobile-header">
        <a className="brand" href="/" aria-label="Setra402 home">
          <img src="/logo.png" alt="Setra402" className="brand-logo" />
        </a>
        <div className="header-status">
          <HealthIndicator state={health} label={cleanHealthLabel} />
        </div>
        <button
          className="mobile-nav-toggle"
          type="button"
          aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
      </header>

      {/* Mobile backdrop */}
      <div
        className={`nav-overlay ${mobileNavOpen ? "is-open" : ""}`}
        onClick={() => setMobileNavOpen(false)}
        aria-hidden="true"
      />

      {/* Vertical Navigation Rail */}
      <aside className={`nav-rail ${mobileNavOpen ? "is-open" : ""}`}>
        <a className="nav-rail-brand" href="/" aria-label="Setra402 home">
          <img src="/logo.png" alt="Setra402" className="brand-logo" />
        </a>
        <div
          id="primary-navigation"
          style={{ flex: 1, display: "flex", flexDirection: "column" }}
        >
          <TopNav active={screen} onChange={changeScreen} />
        </div>
        <div className="nav-rail-footer">
          <HealthIndicator state={health} label={cleanHealthLabel} />
        </div>
      </aside>

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
