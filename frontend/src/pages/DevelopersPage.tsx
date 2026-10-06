import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { CopyButton } from "../components/CopyButton";
import { Tabs } from "../components/Primitives";

const sections = ["MCP", "REST / x402", "Examples", "Configuration"];
const tools = [
  "discover_services",
  "protected_call",
  "fund_task",
  "task_status",
  "refund_task",
];

export function DevelopersPage({
  hidden,
  buyer,
  onCopyError,
  activeTab,
  onTabChange,
}: {
  hidden: boolean;
  buyer: string;
  onCopyError: (error: unknown) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const mcpEndpoint = "http://127.0.0.1:3002/mcp (default MCP_PORT)";
  const restExample = `const response = await fetch("${origin}/api/tasks/quote", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-setra-csrf": "<session token from /api/config>"
  },
  body: JSON.stringify({
    task_id: "123",
    buyer: "${buyer}",
    service_id: "<service id>",
    is_private: false,
    input: {},
    transport: "REST"
  })
});`;
  const configExample = `GET ${origin}/api/config
GET ${origin}/api/services
POST ${origin}/api/tasks/quote
POST ${origin}/api/tasks/fund
POST ${origin}/api/tasks/run
POST ${origin}/api/tasks/status
POST ${origin}/api/tasks/refund`;

  return (
    <section id="developers" className="screen" hidden={hidden}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">INTEGRATION</div>
          <h1 tabIndex={-1}>Developers</h1>
          <p>Connect an agent to the local Setra402 control plane.</p>
        </div>
      </div>
      <Tabs tabs={sections} active={activeTab} onChange={onTabChange} />
      {activeTab === "MCP" && (
        <Card>
          <div className="section-title-row">
            <div>
              <div className="eyebrow">MODEL CONTEXT PROTOCOL</div>
              <h2>MCP endpoint</h2>
            </div>
            <CopyButton
              value={mcpEndpoint.split(" (")[0]}
              onError={onCopyError}
            />
          </div>
          <code className="endpoint-value">{mcpEndpoint}</code>
          <p className="hint">
            The MCP port is configurable with <code>MCP_PORT</code>; the
            endpoint shown is the existing default.
          </p>
          <h3>Available tools</h3>
          <ul className="tool-name-list">
            {tools.map((tool) => (
              <li key={tool}>
                <code>{tool}</code>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {activeTab === "REST / x402" && (
        <Card>
          <div className="section-title-row">
            <div>
              <div className="eyebrow">SAME-ORIGIN API</div>
              <h2>REST endpoints</h2>
            </div>
            <CopyButton value={configExample} onError={onCopyError} />
          </div>
          <ul className="endpoint-list">
            {configExample.split("\n").map((entry) => (
              <li key={entry}>
                <code>{entry}</code>
              </li>
            ))}
          </ul>
          <p className="hint">
            Write requests require the <code>x-setra-csrf</code> session token
            returned by the existing config endpoint.
          </p>
        </Card>
      )}
      {activeTab === "Examples" && (
        <Card variant="data">
          <div className="section-title-row">
            <div>
              <div className="eyebrow">REQUEST EXAMPLE</div>
              <h2>Request a task quote</h2>
            </div>
            <CopyButton value={restExample} onError={onCopyError} />
          </div>
          <pre className="code-block">
            <code>{restExample}</code>
          </pre>
        </Card>
      )}
      {activeTab === "Configuration" && (
        <Card>
          <div className="section-title-row">
            <div>
              <div className="eyebrow">LOCAL CONFIGURATION</div>
              <h2>Browser security and authority</h2>
            </div>
          </div>
          <p>
            Browser requests remain same-origin. The browser has no signing
            keys, provider credentials, secret references, or wallet authority.
          </p>
          <p className="hint">Buyer public key for the configured runtime:</p>
          <div className="copy-value">
            <code className="hash-value">{buyer}</code>
            <CopyButton value={buyer} onError={onCopyError} />
          </div>
        </Card>
      )}
      <div className="developers-footer">
        <span>
          Use the MCP or REST interface already enabled by the local launcher.
        </span>
        <Button className="secondary" onClick={() => onTabChange("Examples")}>
          View examples
        </Button>
      </div>
    </section>
  );
}
