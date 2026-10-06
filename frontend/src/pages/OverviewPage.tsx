import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { HealthIndicator, MetricCard } from "../components/Primitives";
import { StatusBadge } from "../components/StatusBadge";
import type { Screen } from "../components/TopNav";

export function OverviewPage({
  hidden,
  health,
  services,
  tasks,
  verified,
  onNavigate,
}: {
  hidden: boolean;
  health: string | undefined;
  services: number;
  tasks: number;
  verified: number;
  onNavigate: (screen: Screen, developerTab?: string) => void;
}) {
  const tools: Array<[Screen, string, string, string, string]> = [
    [
      "onboarding",
      "Services",
      "Manage providers",
      "Browse and register services",
      "◎",
    ],
    [
      "lifecycle",
      "Tasks",
      "Protected execution",
      "Quote, fund, execute and verify",
      "◌",
    ],
    [
      "audit",
      "Activity",
      "Audit lifecycle",
      "Inspect reports and chain actions",
      "⟳",
    ],
    [
      "developers",
      "Developers",
      "MCP / REST / x402",
      "Build a control-plane integration",
      "</>",
    ],
  ];

  const lifecycleStages = [
    { name: "DISCOVER", label: "01", desc: "Catalog resolution & terms" },
    { name: "QUOTE", label: "02", desc: "Committed challenge" },
    { name: "FUND", label: "03", desc: "On-chain escrow lock" },
    { name: "EXECUTE", label: "04", desc: "Off-chain work" },
    { name: "VERIFY", label: "05", desc: "Multi-level validation" },
    { name: "SETTLE", label: "06", desc: "Conditional release" },
  ];

  return (
    <section id="overview" className="screen" hidden={hidden}>
      {/* ── Section 01: Protocol Hero & Operational Status ── */}
      <div
        className={`operational-banner ${
          health === "HEALTHY" ? "is-healthy" : ""
        }`}
      >
        <div className="operational-mark" aria-hidden="true">
          ●
        </div>
        <div>
          <strong>
            Setra402 {health === "HEALTHY" ? "operational" : "status"}
          </strong>
          <p>
            {health === "HEALTHY"
              ? "All required local services report healthy. Transaction state machine active."
              : health
              ? `Operator health reports ${health.toLowerCase()}. Review resource status before operating.`
              : "Checking operator health from the local control plane."}
          </p>
        </div>
        <HealthIndicator state={health} label={health ?? "Checking"} />
        <Button className="text-button" onClick={() => onNavigate("audit")}>
          View activity <span aria-hidden="true">→</span>
        </Button>
      </div>

      <div className="overview-section-head">
        <div>
          <div className="eyebrow">SETRA402 CONTROL PLANE</div>
          <h1 tabIndex={-1}>Overview</h1>
          <p>Conditional settlement and autonomous transactions on Solana.</p>
        </div>
        <StatusBadge status="neutral">Local Environment</StatusBadge>
      </div>

      {/* ── Section 02: System State ── */}
      <section className="overview-activity">
        <div className="section-title-row">
          <h2>Protected activity</h2>
          <span className="section-meta">Observed in this session</span>
        </div>
        <Card className="activity-summary">
          <div>
            <strong>
              {tasks} protected {tasks === 1 ? "task" : "tasks"}
            </strong>
            <p>
              {verified} with a verification report · {services} discoverable{" "}
              {services === 1 ? "service" : "services"}
            </p>
          </div>
          <div className="activity-bar" aria-hidden="true">
            <span className={tasks ? "has-activity" : ""} />
          </div>
        </Card>
      </section>

      <div className="metric-grid" aria-label="Quick metrics">
        <MetricCard
          label="Services"
          value={services}
          detail="Currently discoverable"
        />
        <MetricCard
          label="Protected tasks"
          value={tasks}
          detail="This browser session"
        />
        <MetricCard
          label="Verification reports"
          value={verified}
          detail="Received from task API"
        />
      </div>

      {/* ── Section 03: Protected Transaction Lifecycle ── */}
      <section className="lifecycle-section">
        <div className="section-title-row">
          <div>
            <div className="eyebrow">PROTOCOL STATE MACHINE</div>
            <h2>Protected Transaction Lifecycle</h2>
          </div>
          <span className="section-meta">Deterministic stage advancement</span>
        </div>
        <div className="lifecycle-flow">
          {lifecycleStages.map((stage, index) => (
            <div key={stage.name} style={{ display: "contents" }}>
              <div className="lifecycle-stage">
                <div
                  className={`lifecycle-stage-node ${
                    index === 0 || tasks > 0 ? "is-active" : ""
                  }`}
                >
                  {stage.label}
                </div>
                <span className="lifecycle-stage-name">{stage.name}</span>
                <span className="lifecycle-stage-desc">{stage.desc}</span>
              </div>
              {index < lifecycleStages.length - 1 && (
                <div className="lifecycle-connector" aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Section 04: Verification System Explanation ── */}
      <section className="verification-tiers">
        <div className="section-title-row">
          <div>
            <div className="eyebrow">ASSURANCE TIERS</div>
            <h2>Verification System</h2>
          </div>
          <span className="section-meta">Cryptographic & execution guarantees</span>
        </div>
        <div className="verification-tier-grid">
          <Card variant="subtle" className="verification-tier-card">
            <div className="verification-tier-header">
              <h3>Level 1 Verification</h3>
              <span className="verification-tier-badge tier-l1">LEVEL 1</span>
            </div>
            <p>
              Deterministic structural validation enforced before any settlement
              claim is processed.
            </p>
            <ul className="verification-tier-checks">
              <li>• JSON Schema conformity</li>
              <li>• Record count bounds</li>
              <li>• Required fields & freshness</li>
              <li>• On-chain Solana state checks</li>
            </ul>
          </Card>

          <Card variant="subtle" className="verification-tier-card">
            <div className="verification-tier-header">
              <h3>Level 2 Verification</h3>
              <span className="verification-tier-badge tier-l2">LEVEL 2</span>
            </div>
            <p>
              Independent verification requiring verifiable evidence or automated
              test execution.
            </p>
            <ul className="verification-tier-checks">
              <li>• Multi-source sampling</li>
              <li>• Domain-matched sampling</li>
              <li>• Test suite runner profiles</li>
              <li>• Cryptographic test bundle hash</li>
            </ul>
          </Card>

          <Card variant="subtle" className="verification-tier-card">
            <div className="verification-tier-header">
              <h3>Sandbox Isolation</h3>
              <span className="verification-tier-badge tier-sandbox">RUNTIME</span>
            </div>
            <p>
              Hermetic container execution isolating untrusted agent code from
              network and secrets.
            </p>
            <ul className="verification-tier-checks">
              <li>• Docker ephemeral containers</li>
              <li>• Ephemeral credentials injection</li>
              <li>• Memory & CPU constraints</li>
              <li>• Authoritative verifier report</li>
            </ul>
          </Card>
        </div>
      </section>

      {/* ── Section 05: Quick Actions ── */}
      <section className="tool-section">
        <div className="section-title-row">
          <div>
            <div className="eyebrow">CONTROL SURFACES</div>
            <h2>Quick Actions</h2>
          </div>
        </div>
        <div className="tool-grid">
          {tools.map(([screen, title, subtitle, detail, icon]) => (
            <button
              key={screen}
              className="tool-card"
              type="button"
              onClick={() => onNavigate(screen)}
            >
              <span className="tool-icon" aria-hidden="true">
                {icon}
              </span>
              <span className="tool-copy">
                <strong>{title}</strong>
                <span>{subtitle}</span>
                <small>{detail}</small>
              </span>
              <span className="tool-arrow" aria-hidden="true">
                ↗
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ── Section 06: Developer Links & Environment Health ── */}
      <section className="developer-links">
        <h2>Developer links</h2>
        <div>
          <Button
            className="link-chip"
            onClick={() => onNavigate("developers", "MCP")}
          >
            MCP
          </Button>
          <Button
            className="link-chip"
            onClick={() => onNavigate("developers", "REST / x402")}
          >
            REST / x402
          </Button>
          <Button
            className="link-chip"
            onClick={() => onNavigate("developers", "Configuration")}
          >
            API configuration
          </Button>
        </div>
      </section>

      <section className="overview-health">
        <h2>Environment health</h2>
        <div className="health-summary">
          <HealthIndicator
            state={health}
            label={health ?? "Health unavailable"}
          />
          <span>Live operator health supplied by the local control plane.</span>
        </div>
      </section>
    </section>
  );
}
