import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { ServiceRegistry } from "../../src/registry/services.js";
import { createControlPlane } from "../../src/web/server.js";
import { ProtectedTaskController } from "../../src/core/task-controller.js";
import { verificationHarness } from "../fixtures/verification-harness.js";
import { launchBrowser } from "../fixtures/browser.js";
let browser: any,
  page: any,
  origin: string,
  server: ReturnType<typeof createControlPlane>;
const browserErrors: string[] = [];
function readTree(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? readTree(path) : [readFileSync(path, "utf8")];
  });
}
const registry = new ServiceRegistry(
  new URL("../../../seller-server/config/services.json", import.meta.url),
  join(
    mkdtempSync(join(tmpdir(), "setra-web-registry-")),
    "services.local.json"
  ),
  true
);
const h = verificationHarness(
  {
    version: "1",
    level: 1,
    checks: [{ type: "json_schema", schema_ref: "generic-object-v1" }],
  },
  {}
);
let state: any = null,
  now = 50;
const controller = new ProtectedTaskController(
  mkdtempSync(join(tmpdir(), "setra-web-tasks-")),
  {
    normalizeQuote() {
      return h.quote;
    },
    async quote() {
      return h.quote;
    },
    async fund() {
      state = h.current();
      return { state, record: h.record, initializeSignature: "simulated-init" };
    },
    async run() {
      return {
        status: "verification_failed",
        quote: h.quote,
        funded: { record: h.record, initializeSignature: "simulated-init" },
        result: h.result,
        report: {
          ...h.context,
          taskId: "99",
          serviceId: "legacy-rest",
          manifestHash: h.record.manifestHash,
          policyHash: h.quote.policyHash,
          resultHash: h.result.resultHash,
          checks: [
            {
              type: "json_schema",
              passed: false,
              message: "Simulated schema mismatch",
            },
          ],
          passed: false,
          verifierPubkey: h.quote.verifier,
        },
        settlement: null,
      };
    },
    async state() {
      return state;
    },
    async now() {
      return now;
    },
    async refund() {
      state = { ...state, status: "refunded" };
      return "simulated-refund";
    },
  }
);
beforeAll(async () => {
  server = createControlPlane({
    registry,
    controller,
    buyer: h.chain.buyer.toBase58(),
    sellerUrl: "unused",
    async discover() {
      return registry.list();
    },
    async health() {
      return {
        version: "1",
        status: "HEALTHY",
        resources: { providerCatalog: "HEALTHY" },
        diskFreeBytes: null,
      };
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await launchBrowser();
  page = await browser.newPage();
  page.on("pageerror", (error: Error) => browserErrors.push(error.message));
  page.on("console", (message: any) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto(origin);
  await page.waitForSelector("#provider-profile option", { state: "attached" });
}, 30000);
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
describe("control-plane browser UI (simulated chain)", () => {
  it("Services renders and service creation exposes accessible provider fields", async () => {
    expect(await page.title()).toContain("Setra402");
    await page.click('[data-screen="onboarding"]');
    await page.click('[data-testid="create-service"]');
    expect(await page.locator("#onboarding h1").textContent()).toBe("Services");
    expect(await page.locator("#provider-profile option").count()).toBe(4);
    expect(await page.locator("#check-type option").count()).toBe(7);
  });
  it("switching profiles keeps Screen A within declared capabilities", async () => {
    await page.selectOption("#provider-profile", "fixture-lead");
    expect(await page.inputValue("#service-capability")).toBe(
      "web.scrape.leads"
    );
    await page.selectOption("#provider-profile", "fixture-echo");
    expect(await page.inputValue("#service-capability")).toBe(
      "setra402.task.echo"
    );
    await page.getByRole("button", { name: "Close dialog" }).click();
  });
  it("registers through Screen A and updates Screen B from the merged registry", async () => {
    await page.click('[data-testid="create-service"]');
    await page.fill("#service-id", "browser-service");
    await page.fill("#service-name", "Browser service");
    await page.fill("#service-description", "Browser fixture");
    await page.click("#register");
    await page.waitForFunction(() =>
      document
        .getElementById("registration-result")!
        .textContent!.includes("Registered browser-service")
    );
    expect(registry.list().some((s) => s.id === "browser-service")).toBe(true);
    expect(
      await page.locator("#task-service option[value=browser-service]").count()
    ).toBe(1);
  });
  it("renders the server policy hash unchanged", async () => {
    const hash = registry
      .list()
      .find((s) => s.id === "browser-service")!.policy_hash;
    expect(await page.locator("#registration-result").textContent()).toContain(
      hash
    );
    expect(await page.locator("#services-table").textContent()).toContain(hash);
  });
  it("Level 2 builder offers exactly the two additional adapters", async () => {
    await page.click('[data-testid="create-service"]');
    await page.selectOption("#policy-level", "2");
    expect(await page.locator("#check-type option").count()).toBe(9);
    expect(await page.inputValue("#policy-json")).toContain("source_sampling");
    await page.selectOption("#check-type", "test_suite");
    await page.click("#add-check");
    expect(await page.inputValue("#policy-json")).toContain("test_bundle_hash");
    await page.getByRole("button", { name: "Close dialog" }).click();
  });
  it("failed verification shows Pending and awaiting refund, never settled", async () => {
    await page.click('[data-screen="lifecycle"]');
    await page.click("#run-protected-task");
    await page.click("#quote-task");
    await page.waitForFunction(
      () => document.getElementById("app-state")!.textContent === "QUOTED"
    );
    await page.click("#fund-task");
    await page.waitForFunction(
      () => document.getElementById("app-state")!.textContent === "FUNDED"
    );
    await page.click("#run-task");
    await page.waitForFunction(
      () => document.getElementById("app-state")!.textContent === "FAILED"
    );
    expect(await page.locator("#chain-action").textContent()).toContain(
      "Awaiting refund eligibility"
    );
    expect(await page.locator("#task-details").textContent()).toContain(
      "pending"
    );
    expect(await page.isDisabled("#refund-task")).toBe(true);
  }, 15000);
  it("Screen C shows only the actual report checks", async () => {
    await page.click("#show-audit");
    expect(await page.locator("#verdict").textContent()).toBe("FAIL");
    expect(await page.locator(".timeline").textContent()).toContain(
      "Task created"
    );
    expect(await page.locator(".timeline").textContent()).toContain(
      "Verification failed"
    );
    expect(await page.locator(".check-row").count()).toBe(1);
    expect(await page.locator("#audit-checks").textContent()).toContain(
      "Simulated schema mismatch"
    );
    expect(await page.locator("#raw-report").textContent()).not.toContain(
      "source_sampling"
    );
  });
  it("deadline changes refund availability without claiming an automatic refund", async () => {
    now = 101;
    await page.waitForFunction(
      () =>
        document.getElementById("audit-chain")!.textContent ===
        "Refund available",
      { timeout: 6000 }
    );
    expect(state.status).toBe("pending");
  });
  it("shows refunded only after confirmation and retains the failed report", async () => {
    await page.click('[data-screen="lifecycle"]');
    await page.click("#refund-task");
    await page.waitForFunction(
      () => document.getElementById("app-state")!.textContent === "REFUNDED"
    );
    expect(state.status).toBe("refunded");
    await page.click("#show-audit");
    expect(await page.locator("#audit-chain").textContent()).toBe("Refunded");
    expect(await page.locator("#verdict").textContent()).toBe("FAIL");
    expect(await page.locator(".check-row").count()).toBe(1);
  });
  it.each([320, 768, 1024, 1440])(
    "has no horizontal overflow at %s pixels",
    async (width) => {
      await page.setViewportSize({ width, height: 950 });
      if (width <= 640) {
        await page.getByRole("button", { name: "Open navigation" }).click();
      }
      await page.click('[data-screen="onboarding"]');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
    }
  );
  it("overview and developer tabs show real health and integration details", async () => {
    await page.click('[data-screen="overview"]');
    expect(await page.locator("#overview h1").textContent()).toBe("Overview");
    expect(await page.locator(".operational-banner").textContent()).toContain(
      "Setra402 operational"
    );
    expect(await page.locator(".metric-card").count()).toBe(3);
    await page
      .getByRole("button", { name: "REST / x402", exact: true })
      .click();
    expect(await page.locator(".endpoint-list").textContent()).toContain(
      "/api/tasks/refund"
    );
    expect(await page.locator('[role="tab"]').count()).toBe(4);
    await page.getByRole("tab", { name: "MCP" }).click();
    expect(await page.locator(".tool-name-list").textContent()).toContain(
      "discover_services"
    );
    await page.getByRole("tab", { name: "REST / x402" }).click();
    expect(await page.locator(".endpoint-list").textContent()).toContain(
      "/api/tasks/refund"
    );
    await page.getByRole("tab", { name: "Examples" }).click();
    expect(await page.locator(".code-block").textContent()).toContain(
      "x-setra-csrf"
    );
  });
  it("client assets contain no financial signing code or secret material", () => {
    const frontend = fileURLToPath(
      new URL("../../../frontend/", import.meta.url)
    );
    const source = [
      readFileSync(join(frontend, "index.html"), "utf8"),
      ...readTree(join(frontend, "src")),
      ...readTree(join(frontend, "dist")),
    ].join("\n");
    expect(source).not.toMatch(
      /secretKey|fromSecretKey|BUYER_KEYPAIR|VERIFIER_KEYPAIR|MINT_SECRET|VOUCHER_SECRET|PROVIDER_API_SECRET|ONBOARDING_ADMIN_TOKEN|process\.env|localStorage|\.settlePublic\(|\.settlePrivate\(/
    );
    expect(source).not.toMatch(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:\b\d{1,3},\s*){63}\d{1,3}/
    );
  });
  it("runs without browser errors and supports keyboard focus", async () => {
    expect(browserErrors).toEqual([]);
    await page.click('[data-screen="onboarding"]');
    await page.click('[data-testid="create-service"]');
    await page.focus("#service-id");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      "service-name"
    );
  });
});
