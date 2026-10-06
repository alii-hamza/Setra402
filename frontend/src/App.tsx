import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  Fragment,
  type FormEvent,
} from "react";
import {
  executeTask,
  fundTask,
  getConfig,
  getHealth,
  getServices,
  getTaskQuote,
  getTaskStatus,
  registerService,
  requestRefund,
} from "./lib/api";
import { chainLabels, pretty, verificationLabels } from "./lib/format";
import { healthDisplayLabel } from "./lib/health-labels";
import type {
  AppConfig,
  OperatorHealth,
  Service,
  TaskAction,
  TaskCall,
  TaskOutcome,
  TaskStatus,
  Transport,
  VerificationCheck,
  VerificationPolicy,
  VerificationReport,
} from "./lib/types";
import { AppShell } from "./components/AppShell";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { CopyButton } from "./components/CopyButton";
import {
  DataTable,
  Disclosure,
  HealthIndicator,
  Modal,
  ServiceCard,
  Stepper,
  Timeline,
} from "./components/Primitives";
import { StatusBadge } from "./components/StatusBadge";
import { ActivityPage } from "./pages/ActivityPage";
import { DevelopersPage } from "./pages/DevelopersPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ServicesPage } from "./pages/ServicesPage";
import { TasksPage } from "./pages/TasksPage";
import type { Screen } from "./components/TopNav";

type ServiceDraft = {
  id: string;
  name: string;
  description: string;
  capability: string;
  exposure: Service["exposure"];
  provider: string;
  price: string;
  timeout: string;
  privateSupport: boolean;
  level: number;
  policyJson: string;
};

const checkLabels = verificationLabels;
const checkTypes = [
  "json_schema",
  "record_count",
  "required_fields",
  "unique",
  "freshness",
  "artifact_integrity",
  "solana_state",
  "source_sampling",
  "test_suite",
];

function createPolicy(level: number, config: AppConfig): VerificationPolicy {
  const template = createCheckTemplates(config);
  return {
    version: "1",
    level,
    checks: [template[level === 1 ? "json_schema" : "source_sampling"]],
  };
}

function createCheckTemplates(
  config: AppConfig
): Record<string, VerificationPolicy["checks"][number]> {
  return {
    json_schema: { type: "json_schema", schema_ref: "generic-object-v1" },
    record_count: { type: "record_count", pointer: "/records", min: 1 },
    required_fields: {
      type: "required_fields",
      pointer: "/records",
      fields: ["company"],
    },
    unique: { type: "unique", pointer: "/records", field: "email" },
    freshness: {
      type: "freshness",
      timestamp_pointer: "/generated_at_unix",
      max_age_seconds: 3600,
      max_future_skew_seconds: 5,
    },
    artifact_integrity: {
      type: "artifact_integrity",
      evidence_id: "code-module",
      max_size_bytes: 1048576,
    },
    solana_state: {
      type: "solana_state",
      target: "account",
      account: config.buyer,
      commitment: "confirmed",
    },
    source_sampling: {
      type: "source_sampling",
      pointer: "/records",
      sample_count: 3,
      source_url_field: "source_url",
      fields: ["company"],
      allowed_domains: ["example.com"],
      minimum_match_bps: 10000,
    },
    test_suite: {
      type: "test_suite",
      runner_profile: config.runners[0].id,
      test_bundle_hash: config.runners[0].test_bundle_hash,
      timeout_seconds: 10,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function makeSteps(
  entries: Array<[string, boolean]>,
  active: boolean
): Array<{
  label: string;
  state: "done" | "current" | "future";
}> {
  const currentIndex = active
    ? entries.findIndex(([, complete]) => !complete)
    : -1;
  return entries.map(([label, complete], index) => ({
    label,
    state: complete ? "done" : index === currentIndex ? "current" : "future",
  }));
}

function definitionList(id: string, values: Array<[string, unknown]>) {
  return (
    <dl id={id}>
      {values.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>
            {value === null || value === undefined
              ? "—"
              : typeof value === "object"
              ? pretty(value)
              : String(value)}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [operatorHealth, setOperatorHealth] = useState<OperatorHealth | null>(
    null
  );
  const [services, setServices] = useState<Service[]>([]);
  const [screen, setScreen] = useState<Screen>("overview");
  const [developerTab, setDeveloperTab] = useState("MCP");
  const [serviceDialogOpen, setServiceDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [createdAt, setCreatedAt] = useState<number | null>(null);
  const [activityEvents, setActivityEvents] = useState<
    Array<{ title: string; detail?: string; time: number }>
  >([]);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null
  );
  const [draft, setDraft] = useState<ServiceDraft>({
    id: "",
    name: "",
    description: "",
    capability: "setra402.task.echo",
    exposure: "both",
    provider: "",
    price: "1500000",
    timeout: "30",
    privateSupport: true,
    level: 1,
    policyJson: "",
  });
  const [checkType, setCheckType] = useState("json_schema");
  const [registering, setRegistering] = useState(false);
  const [registrationResult, setRegistrationResult] = useState(
    "Service becomes visible after registry read-back succeeds."
  );
  const [transport, setTransport] = useState<Transport>("REST");
  const [serviceId, setServiceId] = useState("");
  const [taskId, setTaskId] = useState(() => String(Date.now()));
  const [taskInput, setTaskInput] = useState('{"fixture":"valid"}');
  const [privateTask, setPrivateTask] = useState(false);
  const [activeCall, setActiveCall] = useState<TaskCall | null>(null);
  const [outcome, setOutcome] = useState<TaskOutcome | null>(null);
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null);
  const [taskStateLabel, setTaskStateLabel] = useState("DISCOVERED");
  const [busy, setBusy] = useState(false);

  const selectedProfile = config?.providerProfiles.find(
    (profile) => profile.provider_id === draft.provider
  );
  const availableServices = useMemo(
    () =>
      services.filter(
        (service) =>
          service.exposure === "both" ||
          service.exposure === transport.toLowerCase()
      ),
    [services, transport]
  );
  const selectedService = services.find((service) => service.id === serviceId);
  const taskProvider = config?.providerProfiles.find(
    (profile) => profile.provider_id === selectedService?.provider_connector_ref
  );
  const report: VerificationReport | undefined = outcome?.report;

  const showNotice = useCallback((text: string, error = false) => {
    setNotice(text ? { text, error } : null);
  }, []);

  const addActivityEvent = useCallback((title: string, detail?: string) => {
    setActivityEvents((events) =>
      events.some((event) => event.title === title && event.detail === detail)
        ? events
        : [
            ...events,
            { title, ...(detail ? { detail } : {}), time: Date.now() },
          ]
    );
  }, []);

  const refreshServices = useCallback(async () => {
    const response = await getServices();
    setServices(response.services);
    setServiceId((previous) =>
      response.services.some((service) => service.id === previous)
        ? previous
        : response.services[0]?.id ?? ""
    );
  }, []);

  useEffect(() => {
    let live = true;
    async function initialize() {
      try {
        const loadedConfig = await getConfig();
        if (!live) return;
        setConfig(loadedConfig);
        const provider = loadedConfig.providerProfiles[0];
        if (provider) {
          setDraft((current) => ({
            ...current,
            provider: provider.provider_id,
            capability: provider.capabilities[0] ?? "",
            policyJson: pretty(createPolicy(1, loadedConfig)),
          }));
        }
        await refreshServices();
      } catch (error) {
        if (live) showNotice(errorMessage(error), true);
      }
    }
    void initialize();
    return () => {
      live = false;
    };
  }, [refreshServices, showNotice]);

  useEffect(() => {
    let live = true;
    const loadHealth = () => {
      void getHealth()
        .then((health) => {
          if (live) setOperatorHealth(health);
        })
        .catch(() => {
          if (live) setOperatorHealth(null);
        });
    };
    loadHealth();
    const timer = window.setInterval(loadHealth, 15000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (
      selectedProfile &&
      !selectedProfile.capabilities.includes(draft.capability)
    )
      setDraft((current) => ({
        ...current,
        capability: selectedProfile.capabilities[0] ?? "",
      }));
  }, [selectedProfile, draft.capability]);

  useEffect(() => {
    if (screen === "overview" || screen === "developers") {
      document.getElementById(screen)?.querySelector("h1")?.focus({
        preventScroll: true,
      });
      return;
    }
    const screenId = screen === "onboarding" ? "onboarding" : screen;
    document.getElementById(screenId)?.querySelector("h1")?.focus({
      preventScroll: true,
    });
  }, [screen]);

  useEffect(() => {
    if (!activeCall || busy || taskStatus?.chainState?.status !== "pending")
      return;
    const timer = window.setInterval(() => {
      void getTaskStatus(activeCall)
        .then((status) => {
          setTaskStatus(status);
        })
        .catch((error: unknown) => showNotice(errorMessage(error), true));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeCall, busy, taskStatus?.chainState?.status, showNotice]);

  useEffect(() => {
    if (taskStatus?.chainAction === "refund_available")
      addActivityEvent("Refund eligible");
    if (taskStatus?.chainAction === "settled")
      addActivityEvent("Settlement confirmed");
    if (taskStatus?.chainAction === "refunded")
      addActivityEvent("Refund confirmed");
  }, [taskStatus?.chainAction, addActivityEvent]);

  useEffect(() => {
    if (
      services.length &&
      !availableServices.some((service) => service.id === serviceId)
    )
      setServiceId(availableServices[0]?.id ?? "");
  }, [availableServices, serviceId, services.length]);

  useEffect(() => {
    if (!activeCall && selectedService && !selectedService.privacy_support)
      setPrivateTask(false);
  }, [activeCall, selectedService]);

  function selectLevel(level: number) {
    setDraft((current) => ({
      ...current,
      level,
      policyJson: config
        ? pretty(createPolicy(level, config))
        : current.policyJson,
    }));
    setCheckType(level === 1 ? "json_schema" : "source_sampling");
  }

  function addVerificationCheck() {
    try {
      const policy = JSON.parse(draft.policyJson) as VerificationPolicy;
      if (!config) throw new Error("Control-plane configuration is not loaded");
      policy.checks.push(createCheckTemplates(config)[checkType]);
      setDraft((current) => ({ ...current, policyJson: pretty(policy) }));
    } catch (error) {
      showNotice(errorMessage(error), true);
    }
  }

  async function submitService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config) return;
    setRegistering(true);
    try {
      const result = await registerService({
        id: draft.id,
        name: draft.name,
        description: draft.description,
        capability: draft.capability,
        exposure: draft.exposure,
        price_base_units: draft.price,
        timeout_seconds: Number(draft.timeout),
        privacy_support: draft.privateSupport,
        provider_connector_ref: draft.provider,
        verification_policy: JSON.parse(draft.policyJson) as VerificationPolicy,
      });
      await refreshServices();
      setRegistrationResult(
        `Registered ${result.service.id} · policy hash ${result.service.policy_hash}`
      );
      setServiceDialogOpen(false);
      showNotice(
        "Registered. The saved service is available through its configured transports and task selection."
      );
    } catch (error) {
      showNotice(errorMessage(error), true);
    } finally {
      setRegistering(false);
    }
  }

  function taskCall(): TaskCall {
    if (!config) throw new Error("Control-plane configuration is not loaded");
    return {
      task_id: taskId,
      buyer: config.buyer,
      service_id: serviceId,
      is_private: privateTask,
      input: JSON.parse(taskInput),
      transport,
    };
  }

  function resetTask() {
    setActiveCall(null);
    setOutcome(null);
    setTaskStatus(null);
    setTaskId(String(Date.now()));
    setTaskStateLabel("DISCOVERED");
    setCreatedAt(null);
    setActivityEvents([]);
  }

  async function runTaskAction(action: TaskAction) {
    if (busy) return;
    setBusy(true);
    try {
      const call = activeCall ?? taskCall();
      if (!activeCall) setActiveCall(call);
      setTaskStateLabel(
        {
          quote: "QUOTING",
          fund: "FUNDING",
          run: "EXECUTING / VERIFYING",
          refund: "REFUNDING",
        }[action]
      );
      let result: TaskOutcome & { outcome?: TaskOutcome };
      if (action === "run") addActivityEvent("Provider execution started");
      if (action === "quote") result = await getTaskQuote(call);
      else if (action === "fund") result = await fundTask(call);
      else if (action === "run") result = await executeTask(call);
      else result = await requestRefund(call);
      if (action === "quote") {
        setCreatedAt((previous) => previous ?? Date.now());
        addActivityEvent(
          "Task created",
          `Task ${call.task_id} · ${call.service_id}`
        );
        addActivityEvent("Quote committed");
      }
      if (action === "fund") {
        addActivityEvent(
          "Escrow funded",
          result.funded?.initializeSignature
            ? `Transaction ${result.funded.initializeSignature}`
            : undefined
        );
      }
      if (action === "refund") {
        setOutcome((previous) => result.outcome ?? previous);
      } else {
        setOutcome(result);
      }
      const labels: Record<string, string> = {
        payment_required: "QUOTED",
        funded: "FUNDED",
        settled: "SETTLED",
        verification_failed: "FAILED",
        refunded: "REFUNDED",
      };
      setTaskStateLabel(labels[result.status] ?? result.status.toUpperCase());
      const status = await getTaskStatus(call);
      setTaskStatus(status);
      if (action === "run") {
        if (result.result?.resultHash)
          addActivityEvent(
            "Result committed",
            `Result hash ${result.result.resultHash}`
          );
        if (result.report)
          addActivityEvent(
            result.report.passed
              ? "Verification passed"
              : "Verification failed",
            `Verification level ${result.report.level}`
          );
      }
      if (action === "run") setTaskDialogOpen(false);
      if (action === "run" && result.status === "settled")
        addActivityEvent("Settlement submitted");
      if (status.chainAction === "settled")
        addActivityEvent("Settlement confirmed");
      if (status.chainAction === "refunded")
        addActivityEvent("Refund confirmed");
      showNotice(
        action === "quote"
          ? "Payment quote ready."
          : action === "fund"
          ? "Escrow funding confirmed."
          : result.status === "verification_failed"
          ? "Verification failed. The task remains Pending until refund eligibility."
          : "Task state updated."
      );
    } catch (error) {
      showNotice(errorMessage(error), true);
      setTaskStateLabel("ACTION REQUIRED");
    } finally {
      setBusy(false);
    }
  }

  const profileSummary = selectedProfile
    ? `${selectedProfile.display_name} · ${selectedProfile.connector_type} · ${
        selectedProfile.active ? "ACTIVE" : "INACTIVE"
      } · idempotency ${
        selectedProfile.recovery_capabilities.idempotency
      } · execution ID ${
        selectedProfile.recovery_capabilities.execution_id
          ? "supported"
          : "not supported"
      } · server-side credential ${
        selectedProfile.requires_secret ? "required" : "not required"
      }`
    : "";
  const quote = outcome?.quote ?? taskStatus?.quote;
  const chain = taskStatus?.chainState;
  const chainAction = taskStatus?.chainAction;
  const chainActionText =
    report && !report.passed && chain?.status === "pending"
      ? `Verification failed · ${
          chainLabels[chainAction ?? ""] ?? "Funding required"
        }`
      : chainLabels[chainAction ?? ""] ?? "Funding required";
  const taskDetails: Array<[string, unknown]> = [
    ["Service", activeCall?.service_id],
    ["Transport", activeCall?.transport],
    ["Privacy", activeCall?.is_private ? "Private" : "Public"],
    ["Amount · base units", quote?.amount],
    ["Timeout · seconds", quote?.timeoutSeconds ?? quote?.timeout_seconds],
    ["Verification level", quote?.verificationPolicy?.level],
    ["Manifest hash", outcome?.funded?.record?.manifestHash],
    ["Escrow transaction", outcome?.funded?.initializeSignature],
    ["Chain TaskState", chain?.status ?? "Not funded"],
    [
      "Execution",
      outcome?.result ? "Submitted" : outcome?.funded ? "Funded" : "Not run",
    ],
    ["Result hash", outcome?.result?.resultHash],
    [
      "Verification",
      report ? (report.passed ? "Passed" : "Failed") : "Not run",
    ],
    [
      "Refund deadline",
      chain?.deadlineUnix
        ? `${new Date(chain.deadlineUnix * 1000).toLocaleString()} (${
            chain.deadlineUnix
          })`
        : null,
    ],
    ["Chain action", chainLabels[chainAction ?? ""] ?? "Funding required"],
  ];
  const auditDetails: Array<[string, unknown]> = report
    ? [
        ["Task", report.taskId],
        ["Service", report.serviceId],
        ["Verification level", report.level],
        ["Manifest hash", report.manifestHash],
        ["Policy hash", report.policyHash],
        ["Result hash", report.resultHash],
        ["Verifier", report.verifierPubkey],
      ]
    : [];
  const registerDisabled = !config?.writeEnabled || registering;
  const quoteDisabled = busy || Boolean(activeCall);
  const fundDisabled =
    busy ||
    Boolean(outcome?.funded) ||
    Boolean(outcome?.report) ||
    outcome?.status !== "payment_required";
  const runDisabled = busy || outcome?.status !== "funded";
  const refundDisabled = busy || taskStatus?.chainAction !== "refund_available";

  const lifecycleSteps = makeSteps(
    [
      ["Created", Boolean(activeCall)],
      ["Quoted", outcome?.status !== undefined],
      ["Funded", Boolean(outcome?.funded)],
      ["Executing", Boolean(outcome?.result)],
      ["Verifying", Boolean(report)],
      ["Settled", chainAction === "settled"],
    ],
    Boolean(activeCall)
  );
  const failureSteps = makeSteps(
    [
      ["Verification failed", Boolean(report && !report.passed)],
      ["Pending", chain?.status === "pending"],
      ["Refund eligible", chainAction === "refund_available"],
      ["Refunded", chainAction === "refunded"],
    ],
    Boolean(report && !report.passed)
  );
  const sessionEvents = activityEvents
    .slice()
    .sort((left, right) => left.time - right.time)
    .map((event) => ({
      ...event,
      time: new Date(event.time).toLocaleTimeString(),
    }));

  return (
    <AppShell screen={screen} onScreenChange={setScreen} notice={notice}>
      <OverviewPage
        hidden={screen !== "overview"}
        health={operatorHealth?.status}
        services={services.length}
        tasks={activeCall ? 1 : 0}
        verified={report ? 1 : 0}
        onNavigate={(nextScreen, tab) => {
          if (tab) setDeveloperTab(tab);
          setScreen(nextScreen);
        }}
      />
      <ServicesPage hidden={screen !== "onboarding"}>
        <div className="page-heading">
          <div>
            <div className="eyebrow">SERVICE REGISTRY</div>
            <h1 tabIndex={-1}>Services</h1>
            <p>
              Review available provider services and their verification
              contracts.
            </p>
          </div>
          <Button
            className="primary-button"
            data-testid="create-service"
            onClick={() => setServiceDialogOpen(true)}
            disabled={registerDisabled}
          >
            <span aria-hidden="true">＋</span> Create service
          </Button>
        </div>
        <div className="service-summary-row">
          <span>
            {services.length} discoverable{" "}
            {services.length === 1 ? "service" : "services"}
          </span>
          <span>
            Registry health:{" "}
            <HealthIndicator
              state={operatorHealth?.resources.providerCatalog}
              label={healthDisplayLabel(
                operatorHealth?.resources.providerCatalog,
                "Unavailable",
              )}
            />
          </span>
          <Button
            type="button"
            id="refresh-services"
            className="secondary small"
            onClick={() =>
              void refreshServices().catch((error: unknown) =>
                showNotice(errorMessage(error), true)
              )
            }
          >
            Refresh
          </Button>
        </div>
        <div id="services-table" className="service-grid">
          {services.map((service) => {
            const provider = config?.providerProfiles.find(
              (profile) =>
                profile.provider_id === service.provider_connector_ref
            );
            return (
              <ServiceCard
                key={service.id}
                name={service.name}
                description={service.description}
                provider={
                  provider?.display_name ?? service.provider_connector_ref
                }
                transport={service.exposure.toUpperCase()}
                price={service.price_base_units}
                level={service.verification_policy.level}
                health={
                  operatorHealth?.resources.providerCatalog ?? "UNAVAILABLE"
                }
                activation={provider?.active ? "ACTIVE" : "INACTIVE"}
              >
                <Disclosure title="Protocol details">
                  <dl className="service-protocol-details">
                    <dt>Service ID</dt>
                    <dd>{service.id}</dd>
                    <dt>Capability</dt>
                    <dd>{service.capability}</dd>
                    <dt>Timeout</dt>
                    <dd>{service.timeout_seconds}s</dd>
                    <dt>Private settlement</dt>
                    <dd>
                      {service.privacy_support ? "Supported" : "Not supported"}
                    </dd>
                    <dt>Policy hash</dt>
                    <dd>
                      <code className="hash-value">{service.policy_hash}</code>
                    </dd>
                  </dl>
                </Disclosure>
              </ServiceCard>
            );
          })}
          {!services.length && (
            <Card className="empty-card">
              <p>No services are currently available.</p>
              <Button
                className="secondary"
                onClick={() => void refreshServices()}
              >
                Refresh services
              </Button>
            </Card>
          )}
        </div>
        <Modal
          open={serviceDialogOpen}
          title="Create service"
          onClose={() => setServiceDialogOpen(false)}
        >
          <form id="service-form" onSubmit={submitService}>
            <div
              className="service-form-segments"
              aria-label="Service sections"
            >
              {[
                "Basic",
                "Provider",
                "Pricing",
                "Verification",
                "Exposure",
                "Advanced",
              ].map((section) => (
                <button
                  key={section}
                  type="button"
                  onClick={() =>
                    document
                      .getElementById(
                        `service-section-${section.toLowerCase()}`
                      )
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  {section}
                </button>
              ))}
            </div>
            <div className="service-form-content">
              <Card id="service-section-basic">
                <h3>Basic</h3>
                <div className="form-grid">
                  <label>
                    Service ID
                    <input
                      id="service-id"
                      required
                      maxLength={64}
                      placeholder="acme-leads"
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      value={draft.id}
                      onChange={(event) =>
                        setDraft({ ...draft, id: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Display name
                    <input
                      id="service-name"
                      required
                      maxLength={120}
                      placeholder="Acme lead collection"
                      value={draft.name}
                      onChange={(event) =>
                        setDraft({ ...draft, name: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Description
                    <textarea
                      id="service-description"
                      required
                      maxLength={2000}
                      rows={2}
                      placeholder="What this provider delivers"
                      value={draft.description}
                      onChange={(event) =>
                        setDraft({ ...draft, description: event.target.value })
                      }
                    />
                  </label>
                </div>
              </Card>
              <Card id="service-section-provider">
                <h3>Provider</h3>
                <div className="form-grid">
                  <label>
                    Provider profile
                    <select
                      id="provider-profile"
                      value={draft.provider}
                      onChange={(event) =>
                        setDraft({ ...draft, provider: event.target.value })
                      }
                    >
                      {config?.providerProfiles.map((profile) => (
                        <option
                          key={profile.provider_id}
                          value={profile.provider_id}
                        >
                          {profile.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="wide">
                    Capability
                    <input
                      id="service-capability"
                      required
                      maxLength={120}
                      value={draft.capability}
                      onChange={(event) =>
                        setDraft({ ...draft, capability: event.target.value })
                      }
                    />
                  </label>
                </div>
                <p className="hint">
                  Provider credentials are configured on the server and are
                  never sent to this browser.
                </p>
                <p id="provider-summary" className="hint" aria-live="polite">
                  {profileSummary}
                </p>
              </Card>
              <Card id="service-section-pricing">
                <h3>Pricing</h3>
                <div className="form-grid">
                  <label>
                    Price · base units
                    <input
                      id="service-price"
                      required
                      inputMode="numeric"
                      value={draft.price}
                      pattern="[1-9][0-9]*"
                      onChange={(event) =>
                        setDraft({ ...draft, price: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Timeout · seconds
                    <input
                      id="service-timeout"
                      type="number"
                      min={5}
                      max={3600}
                      step={1}
                      required
                      value={draft.timeout}
                      onChange={(event) =>
                        setDraft({ ...draft, timeout: event.target.value })
                      }
                    />
                  </label>
                </div>
              </Card>
              <Card id="service-section-verification">
                <div className="section-heading">
                  <h3>Verification</h3>
                  <span className="badge">V1</span>
                </div>
                <div className="form-grid">
                  <label>
                    Verification level
                    <select
                      id="policy-level"
                      value={draft.level}
                      onChange={(event) =>
                        selectLevel(Number(event.target.value))
                      }
                    >
                      <option value="1">Level 1 · Deterministic checks</option>
                      <option value="2">
                        Level 2 · Independent verification
                      </option>
                    </select>
                  </label>
                  <label>
                    Add a check
                    <select
                      id="check-type"
                      value={checkType}
                      onChange={(event) => setCheckType(event.target.value)}
                    >
                      {checkTypes
                        .filter(
                          (type) =>
                            draft.level === 2 ||
                            !["source_sampling", "test_suite"].includes(type)
                        )
                        .map((type) => (
                          <option key={type} value={type}>
                            {checkLabels[type]}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <Button
                  id="add-check"
                  type="button"
                  className="secondary small"
                  onClick={addVerificationCheck}
                >
                  + Add check
                </Button>
                <label className="policy-label">
                  VerificationPolicyV1
                  <textarea
                    id="policy-json"
                    className="code"
                    rows={10}
                    spellCheck={false}
                    value={draft.policyJson}
                    onChange={(event) =>
                      setDraft({ ...draft, policyJson: event.target.value })
                    }
                  />
                </label>
                <p className="hint">
                  The server validates this contract and computes its policy
                  hash.
                </p>
              </Card>
              <Card id="service-section-exposure">
                <h3>Exposure</h3>
                <div className="form-grid">
                  <label>
                    Buyer transport
                    <select
                      id="exposure"
                      value={draft.exposure}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          exposure: event.target.value as Service["exposure"],
                        })
                      }
                    >
                      <option value="both">REST/x402 + MCP</option>
                      <option value="rest">REST/x402</option>
                      <option value="mcp">MCP</option>
                    </select>
                  </label>
                  <label className="check">
                    <input
                      id="service-private"
                      type="checkbox"
                      checked={draft.privateSupport}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          privateSupport: event.target.checked,
                        })
                      }
                    />
                    Support private settlement
                  </label>
                </div>
              </Card>
              <Disclosure title="Advanced protocol details">
                <Card id="service-section-advanced">
                  <h3>Advanced</h3>
                  <p className="hint">
                    The registry validates service identity, provider
                    capabilities, timeout, and policy on the server.
                  </p>
                  <p className="future">
                    TEE · ZK · multi-attestor · AI advisory — unavailable in
                    Phase 3
                  </p>
                </Card>
              </Disclosure>
              <div className="form-footer">
                <p id="registration-result">{registrationResult}</p>
                <Button
                  id="register"
                  type="submit"
                  className="primary-button"
                  disabled={registerDisabled}
                >
                  Create service <span>↗</span>
                </Button>
              </div>
            </div>
          </form>
        </Modal>
      </ServicesPage>
      <TasksPage hidden={screen !== "lifecycle"}>
        <div className="page-heading">
          <div>
            <div className="eyebrow">PROTECTED EXECUTION</div>
            <h1 tabIndex={-1}>Tasks</h1>
            <p>Track protected execution and inspect lifecycle state.</p>
          </div>
          <Button
            id="run-protected-task"
            className="primary-button"
            disabled={busy}
            onClick={() => {
              setTaskDialogOpen(true);
            }}
          >
            {activeCall ? "Continue protected task" : "Run protected task"}
          </Button>
        </div>
        <Card className="task-table-card">
          <div className="section-title-row">
            <h2>Task activity</h2>
            <span className="section-meta">Current browser session</span>
          </div>
          <DataTable
            label="Protected tasks"
            columns={[
              "Task",
              "Service",
              "Provider",
              "Transport",
              "Amount",
              "Lifecycle",
              "Verification",
              "Settlement",
              "Created",
            ]}
          >
            {activeCall && (
              <tr>
                <td>
                  <code>{activeCall.task_id}</code>
                </td>
                <td>{selectedService?.name ?? activeCall.service_id}</td>
                <td>
                  {taskProvider?.display_name ??
                    selectedService?.provider_connector_ref ??
                    "—"}
                </td>
                <td>{activeCall.transport}</td>
                <td>
                  {quote?.amount === undefined ? "—" : String(quote.amount)}
                </td>
                <td>
                  <StatusBadge>{taskStateLabel}</StatusBadge>
                </td>
                <td>{report ? (report.passed ? "Passed" : "Failed") : "—"}</td>
                <td>{chainLabels[chainAction ?? ""] ?? "Funding required"}</td>
                <td>
                  {createdAt ? new Date(createdAt).toLocaleString() : "—"}
                </td>
              </tr>
            )}
          </DataTable>
          {!activeCall && (
            <div className="table-empty">
              <p>No protected task has been run in this browser session.</p>
              <Button
                className="secondary"
                onClick={() => setTaskDialogOpen(true)}
              >
                Run protected task
              </Button>
            </div>
          )}
        </Card>
        <div className="task-detail-layout">
          <Card variant="emphasized">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">APPLICATION LIFECYCLE</div>
                <h2>Task progress</h2>
              </div>
              <StatusBadge id="app-state">{taskStateLabel}</StatusBadge>
            </div>
            <p className="hint">
              Application progress is separate from the on-chain TaskState.
            </p>
            <Stepper
              steps={report && !report.passed ? failureSteps : lifecycleSteps}
            />
            <div className="state-separation">
              <div>
                <span>Application state</span>
                <strong>{taskStateLabel}</strong>
              </div>
              <div>
                <span>Chain state / action</span>
                <strong id="chain-action">
                  {activeCall ? chainActionText : "Funding required"}
                </strong>
              </div>
            </div>
            {definitionList(
              "task-details",
              activeCall
                ? taskDetails
                : [
                    ["Chain TaskState", "Not funded"],
                    ["Verification", "Not run"],
                  ]
            )}
            <div className="task-detail-actions">
              <Button
                id="show-audit"
                className="secondary"
                onClick={() => setScreen("audit")}
              >
                View activity →
              </Button>
              {activeCall && (
                <Button
                  id="refund-task"
                  className="primary-button"
                  disabled={refundDisabled}
                  onClick={() => void runTaskAction("refund")}
                >
                  Request timeout refund
                </Button>
              )}
              {activeCall && (
                <Button
                  id="new-task"
                  className="secondary"
                  disabled={busy}
                  onClick={resetTask}
                >
                  New task
                </Button>
              )}
            </div>
            <Disclosure title="Committed policy and payment challenge">
              <pre id="task-contract">
                {quote ? pretty(quote) : "No quote yet."}
              </pre>
            </Disclosure>
          </Card>
          <Card>
            <div className="section-title-row">
              <div>
                <div className="eyebrow">CHAIN AUTHORITY</div>
                <h2>Settlement state</h2>
              </div>
              <HealthIndicator
                state={
                  chainAction === "settled"
                    ? "HEALTHY"
                    : chainAction === "refunded"
                    ? "HEALTHY"
                    : "DEGRADED"
                }
                label={chainLabels[chainAction ?? ""] ?? "Not funded"}
              />
            </div>
            <p className="hint">
              Chain status is reported by the existing task-status API. This
              interface does not sign transactions.
            </p>
            {definitionList("task-chain-details", [
              ["TaskState", chain?.status ?? "Not funded"],
              [
                "Refund deadline",
                chain?.deadlineUnix
                  ? new Date(chain.deadlineUnix * 1000).toLocaleString()
                  : null,
              ],
              ["Escrow transaction", outcome?.funded?.initializeSignature],
            ])}
            {outcome?.funded?.initializeSignature && (
              <CopyButton
                value={outcome.funded.initializeSignature}
                onError={(error) => showNotice(errorMessage(error), true)}
              />
            )}
          </Card>
        </div>
        <Modal
          open={taskDialogOpen}
          title="Run protected task"
          onClose={() => setTaskDialogOpen(false)}
        >
          <Card className="task-configuration">
            <p className="hint">
              Configure the request that will be sent to the existing
              control-plane.
            </p>
            <div className="form-grid">
              <label>
                Transport
                <select
                  id="task-transport"
                  value={transport}
                  disabled={Boolean(activeCall)}
                  onChange={(event) =>
                    setTransport(event.target.value as Transport)
                  }
                >
                  <option>REST</option>
                  <option>MCP</option>
                </select>
              </label>
              <label>
                Service
                <select
                  id="task-service"
                  value={serviceId}
                  disabled={Boolean(activeCall)}
                  onChange={(event) => setServiceId(event.target.value)}
                >
                  {availableServices.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wide">
                Task ID · u64 string
                <input
                  id="task-id"
                  inputMode="numeric"
                  required
                  pattern="[0-9]+"
                  value={taskId}
                  disabled={Boolean(activeCall)}
                  onChange={(event) => setTaskId(event.target.value)}
                />
              </label>
              <label className="check wide">
                <input
                  id="task-private"
                  type="checkbox"
                  checked={privateTask}
                  disabled={
                    Boolean(activeCall) || !selectedService?.privacy_support
                  }
                  onChange={(event) => setPrivateTask(event.target.checked)}
                />
                Private settlement
              </label>
              <label className="wide">
                Task input
                <textarea
                  id="task-input"
                  rows={6}
                  className="code"
                  spellCheck={false}
                  value={taskInput}
                  disabled={Boolean(activeCall)}
                  onChange={(event) => setTaskInput(event.target.value)}
                />
              </label>
            </div>
            <div id="selected-service" className="metadata">
              {selectedService
                ? `${selectedService.price_base_units} base units · ${selectedService.timeout_seconds}s · Level ${selectedService.verification_policy.level} · ${selectedService.provider_connector_ref}`
                : "No services available for this transport."}
            </div>
            <div className="actions">
              <Button
                id="quote-task"
                className="primary-button"
                disabled={quoteDisabled || !serviceId}
                onClick={() => void runTaskAction("quote")}
              >
                Get quote
              </Button>
              <Button
                id="fund-task"
                disabled={fundDisabled}
                onClick={() => void runTaskAction("fund")}
              >
                Fund escrow
              </Button>
              <Button
                id="run-task"
                disabled={runDisabled}
                onClick={() => void runTaskAction("run")}
              >
                Execute &amp; verify
              </Button>
            </div>
            <Button
              id="refund-task-dialog"
              className="secondary"
              disabled={refundDisabled}
              onClick={() => void runTaskAction("refund")}
            >
              Request timeout refund
            </Button>
          </Card>
        </Modal>
      </TasksPage>
      <ActivityPage hidden={screen !== "audit"}>
        <div className="page-heading">
          <div>
            <div className="eyebrow">AUDIT TRAIL</div>
            <h1 tabIndex={-1}>Activity</h1>
            <p>
              Chronological events and verification results observed in this
              session.
            </p>
          </div>
          <StatusBadge
            id="verdict"
            className={report ? (report.passed ? "pass" : "fail") : undefined}
          >
            {report ? (report.passed ? "PASS" : "FAIL") : "NOT RUN"}
          </StatusBadge>
        </div>
        <Card>
          <div className="section-title-row">
            <div>
              <div className="eyebrow">PROTECTED EXECUTION</div>
              <h2>Event timeline</h2>
            </div>
            <span className="section-meta">Observed locally</span>
          </div>
          {sessionEvents.length ? (
            <Timeline
              events={sessionEvents.map((event) => ({
                title: event.title,
                detail: event.detail,
                time: event.time,
              }))}
            />
          ) : (
            <div className="table-empty">
              <p>No task events have been observed in this browser session.</p>
              <Button
                className="secondary"
                onClick={() => setScreen("lifecycle")}
              >
                Open tasks
              </Button>
            </div>
          )}
        </Card>
        <Card variant={report?.passed ? "emphasized" : "default"}>
          <div className="section-title-row">
            <div>
              <div className="eyebrow">AUTHORITATIVE REPORT</div>
              <h2>Verification report</h2>
            </div>
            <StatusBadge
              className={report ? (report.passed ? "pass" : "fail") : undefined}
            >
              {report ? (report.passed ? "PASSED" : "FAILED") : "NOT RUN"}
            </StatusBadge>
          </div>
          {definitionList("audit-details", auditDetails)}
          {!report && (
            <div id="audit-empty" className="empty">
              Complete a protected task to inspect its verification report.
            </div>
          )}
          <div id="audit-checks">
            {report &&
              (() => {
                let previousGroup = "";
                return report.checks.map((check: VerificationCheck, index) => {
                  const nextGroup = ["source_sampling", "test_suite"].includes(
                    check.type
                  )
                    ? "Level 2 · Independent verification"
                    : [
                        "json_schema",
                        "record_count",
                        "required_fields",
                        "unique",
                        "freshness",
                        "artifact_integrity",
                        "solana_state",
                      ].includes(check.type)
                    ? "Level 1 · Deterministic checks"
                    : "Contract integrity";
                  const groupHeading =
                    nextGroup !== previousGroup ? nextGroup : null;
                  previousGroup = nextGroup;
                  return (
                    <Fragment key={`${check.type}-${index}`}>
                      {groupHeading && <h3>{groupHeading}</h3>}
                      <div className="check-row">
                        <strong>{checkLabels[check.type] ?? check.type}</strong>
                        <span className={check.passed ? "pass" : "fail"}>
                          {check.passed ? "✓ PASS" : "✕ FAIL"}
                        </span>
                        <p>{check.message}</p>
                        {check.details && (
                          <details>
                            <summary>Evidence and audit details</summary>
                            {check.type === "source_sampling" && (
                              <p>
                                Sampled {String(check.details.sampled)} ·
                                matched {String(check.details.matched)} ·
                                threshold{" "}
                                {String(check.details.minimum_match_bps)} BPS
                              </p>
                            )}
                            {check.type === "test_suite" &&
                              typeof check.details.runner_profile ===
                                "string" && (
                                <p>
                                  Runner {String(check.details.runner_profile)}{" "}
                                  · exit code {String(check.details.exit_code)}
                                </p>
                              )}
                            <pre>{pretty(check.details)}</pre>
                          </details>
                        )}
                      </div>
                    </Fragment>
                  );
                });
              })()}
          </div>
        </Card>
        <Card className="audit-footer">
          <div>
            <div className="eyebrow">CHAIN ACTION</div>
            <strong id="audit-chain">
              {chainLabels[chainAction ?? ""] ?? "No chain action"}
            </strong>
          </div>
          <p>
            Settlement is authorized server-side by SettlementCoordinator after
            all mandatory checks pass.
          </p>
        </Card>
        <Disclosure title="Hashes, signatures, and full VerificationReport">
          {report && (
            <div className="audit-copy-values">
              {[
                ["Manifest hash", report.manifestHash],
                ["Policy hash", report.policyHash],
                ["Result hash", report.resultHash],
                ["Verifier", report.verifierPubkey],
              ].map(([label, value]) => (
                <div className="copy-value" key={label}>
                  <span>{label}</span>
                  <code className="hash-value">{value}</code>
                  <CopyButton
                    value={value}
                    onError={(error) => showNotice(errorMessage(error), true)}
                  />
                </div>
              ))}
            </div>
          )}
          <pre id="raw-report">
            {report ? pretty(report) : "No report available."}
          </pre>
        </Disclosure>
        <p className="hint">
          Replay/nullifier protection is separate from quality verification.
          On-chain NullifierRecord is authoritative; Redis is a cache.
        </p>
      </ActivityPage>
      <DevelopersPage
        hidden={screen !== "developers"}
        buyer={config?.buyer ?? ""}
        activeTab={developerTab}
        onTabChange={setDeveloperTab}
        onCopyError={(error) => showNotice(errorMessage(error), true)}
      />
    </AppShell>
  );
}
