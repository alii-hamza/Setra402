const $ = (id) => document.getElementById(id);
const pretty = (value) => JSON.stringify(value, null, 2);
let config,
  services = [],
  activeCall = null,
  outcome = null,
  taskStatus = null,
  busy = false;
const labels = {
  manifest_schema: "Manifest schema",
  policy_schema: "Policy schema",
  verifier_identity: "Verifier identity",
  policy_hash: "Policy commitment",
  result_envelope: "Result envelope",
  result_hash: "Result integrity",
  manifest_commitment: "Task commitment",
  policy_commitment: "Policy commitment",
  result_integrity: "Result integrity",
  json_schema: "JSON schema",
  record_count: "Record count",
  required_fields: "Required fields",
  unique: "Uniqueness",
  freshness: "Freshness",
  artifact_integrity: "Artifact integrity",
  solana_state: "Solana state",
  source_sampling: "Independent source samples",
  test_suite: "Trusted test suite",
};
function notice(text, error = false) {
  $("notice").hidden = false;
  $("notice").className = error ? "error" : "";
  $("notice").textContent = text;
}
function screen(id) {
  for (const section of document.querySelectorAll(".screen"))
    section.hidden = section.id !== id;
  for (const button of document.querySelectorAll("nav button")) {
    if (button.dataset.screen === id)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  document.querySelector(`#${id} h1`).focus({ preventScroll: true });
}
async function api(path, body) {
  const fullPath = path.startsWith('/api') ? `http://localhost:3333${path}` : path;
  const response = await fetch(fullPath, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(body === undefined ? {} : { "x-setra-csrf": config.csrfToken }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Request failed");
  return value;
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function option(value, text) {
  const element = node("option", text);
  element.value = value;
  return element;
}
function descriptionList(element, values) {
  element.replaceChildren();
  for (const [key, value] of Object.entries(values)) {
    element.append(
      node("dt", key),
      node("dd", value == null ? "—" : String(value))
    );
  }
}
async function refresh() {
  services = (await api("/api/services")).services;
  $("services-table").replaceChildren();
  for (const service of services) {
    const row = node("tr");
    const name = node("td", service.name);
    name.append(node("small", service.id));
    row.append(
      name,
      node("td", service.exposure),
      node("td", service.price_base_units),
      node("td", `Level ${service.verification_policy.level}`),
      node("td", service.policy_hash, "hash")
    );
    $("services-table").append(row);
  }
  selectServices();
}
function selectServices() {
  const previous = $("task-service").value;
  $("task-service").replaceChildren();
  const transport = $("task-transport").value.toLowerCase();
  for (const service of services.filter(
    (s) => s.exposure === "both" || s.exposure === transport
  ))
    $("task-service").append(option(service.id, service.name));
  if ([...$("task-service").options].some((o) => o.value === previous))
    $("task-service").value = previous;
  selectedService();
}
function selectedService() {
  const service = services.find((s) => s.id === $("task-service").value);
  if (!service) {
    $("selected-service").textContent =
      "No services available for this transport.";
    return;
  }
  $("task-private").disabled = !service.privacy_support || Boolean(activeCall);
  if (!service.privacy_support) $("task-private").checked = false;
  $(
    "selected-service"
  ).textContent = `${service.price_base_units} base units · ${service.timeout_seconds}s · Level ${service.verification_policy.level} · ${service.provider_connector_ref}`;
  $("task-contract").textContent = pretty(service.verification_policy);
}
function templates() {
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
function levelChanged() {
  const level = Number($("policy-level").value),
    all = templates();
  $("check-type").replaceChildren();
  for (const key of Object.keys(all).filter(
    (k) => level === 2 || !["source_sampling", "test_suite"].includes(k)
  ))
    $("check-type").append(option(key, labels[key]));
  $("policy-json").value = pretty({
    version: "1",
    level,
    checks: [all[level === 1 ? "json_schema" : "source_sampling"]],
  });
}
function setBusy(value) {
  busy = value;
  $("new-task").disabled = value;
  for (const button of document.querySelectorAll(".actions button"))
    button.disabled =
      value || (!activeCall && button.id !== "quote-task") || Boolean(outcome);
  $("refund-task").disabled =
    value || taskStatus?.chainAction !== "refund_available";
}
function resetTask() {
  activeCall = null;
  outcome = null;
  taskStatus = null;
  $("task-id").value = String(Date.now());
  $("app-state").textContent = "DISCOVERED";
  for (const id of [
    "task-service",
    "task-transport",
    "task-id",
    "task-input",
    "task-private",
  ])
    $(id).disabled = false;
  $("fund-task").disabled = true;
  $("run-task").disabled = true;
  $("quote-task").disabled = false;
  $("refund-task").disabled = true;
  $("chain-action").textContent = "Funding required";
  descriptionList($("task-details"), {
    "Chain TaskState": "Not funded",
    Verification: "Not run",
  });
  renderAudit();
  selectedService();
}
function callInput() {
  return (
    activeCall ?? {
      task_id: $("task-id").value,
      buyer: config.buyer,
      service_id: $("task-service").value,
      is_private: $("task-private").checked,
      input: JSON.parse($("task-input").value),
      transport: $("task-transport").value,
    }
  );
}
const chainLabels = {
  settled: "Settled",
  awaiting_refund_deadline: "Awaiting refund eligibility",
  refund_available: "Refund available",
  refunded: "Refunded",
  funding_required: "Funding required",
};
function renderTask() {
  const report = outcome?.report,
    quote = outcome?.quote ?? taskStatus?.quote;
  const chain = taskStatus?.chainState;
  descriptionList($("task-details"), {
    Service: activeCall?.service_id,
    Transport: activeCall?.transport,
    Privacy: activeCall?.is_private ? "Private" : "Public",
    "Amount · base units": quote?.amount,
    "Timeout · seconds": quote?.timeoutSeconds,
    "Verification level": quote?.verificationPolicy?.level,
    "Manifest hash": outcome?.funded?.record?.manifestHash,
    "Escrow transaction": outcome?.funded?.initializeSignature,
    "Chain TaskState": chain?.status ?? "Not funded",
    Execution: outcome?.result
      ? "Submitted"
      : outcome?.funded
        ? "Funded"
        : "Not run",
    "Result hash": outcome?.result?.resultHash,
    Verification: report ? (report.passed ? "Passed" : "Failed") : "Not run",
    "Refund deadline": chain?.deadlineUnix
      ? `${new Date(chain.deadlineUnix * 1000).toLocaleString()} (${chain.deadlineUnix
      })`
      : null,
    "Chain action": chainLabels[taskStatus?.chainAction] ?? "Funding required",
  });
  $("chain-action").textContent =
    report && !report.passed && chain?.status === "pending"
      ? `Verification failed · ${chainLabels[taskStatus.chainAction]}`
      : chainLabels[taskStatus?.chainAction] ?? "Funding required";
  $("task-contract").textContent = pretty(quote ?? {});
  renderAudit();
}
function renderAudit() {
  const report = outcome?.report;
  $("audit-empty").hidden = Boolean(report);
  $("verdict").textContent = report
    ? report.passed
      ? "PASS"
      : "FAIL"
    : "NOT RUN";
  $("verdict").className = `badge ${report ? (report.passed ? "pass" : "fail") : ""
    }`;
  $("audit-checks").replaceChildren();
  descriptionList(
    $("audit-details"),
    report
      ? {
        Task: report.taskId,
        Service: report.serviceId,
        "Verification level": report.level,
        "Manifest hash": report.manifestHash,
        "Policy hash": report.policyHash,
        "Result hash": report.resultHash,
        Verifier: report.verifierPubkey,
      }
      : {}
  );
  let group;
  for (const check of report?.checks ?? []) {
    const nextGroup = ["source_sampling", "test_suite"].includes(check.type)
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
    if (nextGroup !== group) {
      $("audit-checks").append(node("h3", nextGroup));
      group = nextGroup;
    }
    const row = node("div", undefined, "check-row");
    row.append(
      node("strong", labels[check.type] ?? check.type),
      node(
        "span",
        check.passed ? "✓ PASS" : "✕ FAIL",
        check.passed ? "pass" : "fail"
      ),
      node("p", check.message)
    );
    if (check.details) {
      if (check.type === "source_sampling")
        row.append(
          node(
            "p",
            `Sampled ${check.details.sampled} · matched ${check.details.matched} · threshold ${check.details.minimum_match_bps} BPS`
          )
        );
      if (check.type === "test_suite" && check.details.runner_profile)
        row.append(
          node(
            "p",
            `Runner ${check.details.runner_profile} · exit code ${check.details.exit_code}`
          )
        );
      const details = node("details");
      details.append(
        node("summary", "Evidence and audit details"),
        node("pre", pretty(check.details))
      );
      row.append(details);
    }
    $("audit-checks").append(row);
  }
  $("raw-report").textContent = report
    ? pretty(report)
    : "No report available.";
  $("audit-chain").textContent =
    chainLabels[taskStatus?.chainAction] ?? "No chain action";
}
async function taskAction(action) {
  if (busy) return;
  setBusy(true);
  try {
    const call = callInput();
    if (!activeCall) {
      activeCall = call;
      for (const id of [
        "task-service",
        "task-transport",
        "task-id",
        "task-input",
        "task-private",
      ])
        $(id).disabled = true;
    }
    $("app-state").textContent = {
      quote: "QUOTING",
      fund: "FUNDING",
      run: "EXECUTING / VERIFYING",
      refund: "REFUNDING",
    }[action];
    const result = await api(`/api/tasks/${action}`, call);
    outcome = action === "refund" ? result.outcome ?? outcome : result;
    $("app-state").textContent =
      {
        payment_required: "QUOTED",
        funded: "FUNDED",
        settled: "SETTLED",
        verification_failed: "FAILED",
        refunded: "REFUNDED",
      }[result.status] ?? result.status.toUpperCase();
    taskStatus = await api("/api/tasks/status", call);
    renderTask();
    notice(
      action === "quote"
        ? "Payment quote ready."
        : action === "fund"
          ? "Escrow funding confirmed."
          : result.status === "verification_failed"
            ? "Verification failed. The task remains Pending until refund eligibility."
            : "Task state updated."
    );
  } catch (error) {
    notice(error.message, true);
    $("app-state").textContent = "ACTION REQUIRED";
  } finally {
    busy = false;
    $("new-task").disabled = false;
    $("quote-task").disabled = Boolean(activeCall);
    $("fund-task").disabled =
      Boolean(outcome?.funded) ||
      Boolean(outcome?.report) ||
      outcome?.status !== "payment_required";
    $("run-task").disabled = outcome?.status !== "funded";
    $("refund-task").disabled = taskStatus?.chainAction !== "refund_available";
  }
}
async function init() {
  try {
    config = await api("/api/config");
    $("write-mode").textContent = config.writeEnabled
      ? "Onboarding writes enabled · local mode"
      : "Onboarding read-only · writes disabled";
    $("register").disabled = !config.writeEnabled;
    for (const profile of config.providerProfiles)
      $("provider-profile").append(
        option(profile.provider_id, profile.display_name)
      );
    providerSummary();
    levelChanged();
    await refresh();
    resetTask();
  } catch (error) {
    notice(error.message, true);
  }
}
function providerSummary() {
  const profile = config?.providerProfiles.find(
    (candidate) => candidate.provider_id === $("provider-profile").value
  );
  if (!profile) return;
  // A profile switch must never leave Screen A with a capability the selected
  // server-owned provider has not declared. Preserve an already compatible
  // user choice; otherwise use that profile's first allowlisted capability.
  const capability = $("service-capability");
  if (!profile.capabilities.includes(capability.value))
    capability.value = profile.capabilities[0] ?? "";
  const idempotency = profile.recovery_capabilities.idempotency;
  $("provider-summary").textContent = `${profile.display_name} · ${profile.connector_type
    } · ${profile.active ? "ACTIVE" : "INACTIVE"
    } · idempotency ${idempotency} · execution ID ${profile.recovery_capabilities.execution_id ? "supported" : "not supported"
    } · server-side credential ${profile.requires_secret ? "required" : "not required"
    }`;
}
for (const button of document.querySelectorAll("nav button"))
  button.addEventListener("click", () => screen(button.dataset.screen));
for (const heading of document.querySelectorAll("h1")) heading.tabIndex = -1;
$("refresh-services").addEventListener("click", () =>
  refresh().catch((e) => notice(e.message, true))
);
$("policy-level").addEventListener("change", levelChanged);
$("provider-profile").addEventListener("change", providerSummary);
$("add-check").addEventListener("click", () => {
  try {
    const policy = JSON.parse($("policy-json").value);
    policy.checks.push(templates()[$("check-type").value]);
    $("policy-json").value = pretty(policy);
  } catch (e) {
    notice(e.message, true);
  }
});
$("service-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("register").disabled = true;
  try {
    const result = await api("/api/services", {
      id: $("service-id").value,
      name: $("service-name").value,
      description: $("service-description").value,
      capability: $("service-capability").value,
      exposure: $("exposure").value,
      price_base_units: $("service-price").value,
      timeout_seconds: Number($("service-timeout").value),
      privacy_support: $("service-private").checked,
      provider_connector_ref: $("provider-profile").value,
      verification_policy: JSON.parse($("policy-json").value),
    });
    await refresh();
    $(
      "registration-result"
    ).textContent = `Registered ${result.service.id} · policy hash ${result.service.policy_hash}`;
    notice(
      "Registered. The saved service is available through its configured transports and task selection."
    );
  } catch (e) {
    notice(e.message, true);
  } finally {
    $("register").disabled = !config.writeEnabled;
  }
});
$("task-service").addEventListener("change", selectedService);
$("task-transport").addEventListener("change", selectServices);
$("new-task").addEventListener("click", resetTask);
$("show-audit").addEventListener("click", () => screen("audit"));
for (const action of ["quote", "fund", "run", "refund"])
  $(`${action}-task`).addEventListener("click", () => taskAction(action));
setInterval(async () => {
  if (activeCall && !busy && taskStatus?.chainState?.status === "pending") {
    try {
      taskStatus = await api("/api/tasks/status", activeCall);
      renderTask();
      $("refund-task").disabled = taskStatus.chainAction !== "refund_available";
    } catch (e) {
      notice(e.message, true);
    }
  }
}, 3000);
init();
