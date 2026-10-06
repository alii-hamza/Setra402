import { useState, type ReactNode } from "react";
import { BrandLogo } from "./BrandLogo";
import { TopNav, type Screen } from "./TopNav";
import { Toast, type ToastMessage } from "./Toast";

export function AppShell({
  screen,
  onScreenChange,
  notice,
  children,
}: {
  screen: Screen;
  onScreenChange: (screen: Screen) => void;
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
      {/* Mobile top bar */}
      <header className="mobile-header">
        <a className="brand" href="/" aria-label="Setra402 home">
          <BrandLogo />
        </a>
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
          <BrandLogo />
        </a>
        <div
          id="primary-navigation"
          style={{ flex: 1, display: "flex", flexDirection: "column" }}
        >
          <TopNav active={screen} onChange={changeScreen} />
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
