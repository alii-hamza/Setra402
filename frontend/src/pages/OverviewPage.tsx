import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { HealthIndicator, MetricCard } from "../components/Primitives";
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
  const tools: Array<[Screen, string, string, string]> = [
    [
      "onboarding",
      "Services",
      "Manage providers",
      "Browse and register services",
    ],
    [
      "lifecycle",
      "Tasks",
      "Protected execution",
      "Quote, fund, execute and verify",
    ],
    [
      "audit",
      "Activity",
      "Audit lifecycle",
      "Inspect reports and chain actions",
    ],
    [
      "developers",
      "Developers",
      "MCP / REST / x402",
      "Build a control-plane integration",
    ],
  ];
  return (
    <section id="overview" className="screen" hidden={hidden}>
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
              ? "All required local services report healthy."
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
          <div className="eyebrow">CONTROL PLANE</div>
          <h1 tabIndex={-1}>Overview</h1>
        </div>
        <span className="section-meta">Environment: Local</span>
      </div>
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
              {verified} with a verification report · {services} available
              services
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
      <section className="tool-section">
        <h2>Tools</h2>
        <div className="tool-grid">
          {tools.map(([screen, title, subtitle, detail], index) => (
            <button
              key={screen}
              className="tool-card"
              type="button"
              onClick={() => onNavigate(screen)}
            >
              <span className="tool-icon" aria-hidden="true">
                {["◉", "◎", "◌", "<>"][index]}
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
