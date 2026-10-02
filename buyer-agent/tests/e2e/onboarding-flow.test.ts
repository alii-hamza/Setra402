import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createRuntime } from "../../src/core/runtime.js";
import { loadKeypair } from "../../src/config.js";
import { createControlPlane } from "../../src/web/server.js";
import { ServiceRegistry } from "../../src/registry/services.js";
import { createMcpServer } from "../../src/mcp/protocol.js";
import { SellerMcpAdapter } from "../../src/mcp/seller-adapter.js";
import { SourceClient } from "../../src/verification/level2/source-client.js";
import { DockerSandbox } from "../../src/verification/level2/docker-sandbox.js";
import { launchBrowser } from "../fixtures/browser.js";
const required = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} required`);
  return v;
};
let runtime: ReturnType<typeof createRuntime>,
  web: ReturnType<typeof createControlPlane>,
  bridge: ReturnType<typeof createMcpServer>,
  seller: ReturnType<typeof spawn>,
  page: any,
  browser: any,
  origin: string,
  sellerUrl: string,
  csrf: string;
const dir = mkdtempSync(join(tmpdir(), "setra-onboard-live-")),
  overlay = join(dir, "services.local.json");
const baseline = new URL(
    "../../../seller-server/config/services.json",
    import.meta.url
  ),
  baselineBytes = readFileSync(baseline);
const registry = new ServiceRegistry(baseline, overlay, true),
  ids = {
    leads: "onboarded-leads",
    source: "onboarded-source",
    code: "onboarded-code",
  };
let taskId = BigInt(Date.now()) + 500000n;
const listen = (s: ReturnType<typeof createMcpServer>) =>
  new Promise<string>((r) =>
    s.listen(0, "127.0.0.1", () =>
      r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)
    )
  );
async function post(path: string, body: unknown) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-setra-csrf": csrf },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value as Record<string, any>;
}
beforeAll(async () => {
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  sellerUrl = `http://127.0.0.1:${port}`;
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../target/e2e-fixture.json", import.meta.url),
      "utf8"
    )
  );
  const binary = new URL(
    process.platform === "win32"
      ? "../../../target/debug/seller-server.exe"
      : "../../../target/debug/seller-server",
    import.meta.url
  );
  const { fileURLToPath } = await import("node:url");
  seller = spawn(fileURLToPath(binary), [], {
    windowsHide: true,
    stdio: "pipe",
    env: {
      ...process.env,
      RPC_HOST: "127.0.0.1",
      RPC_PORT: "8899",
      PROGRAM_ID: required("ROLE_C_PROGRAM_ID"),
      MINT: fixture.mint,
      SELLER_TOKEN_ACCOUNT: fixture.sellerTokenAccount,
      VERIFIER: fixture.verifier,
      PROTOCOL_TREASURY: fixture.treasuryTokenAccount,
      BIND_ADDR: `127.0.0.1:${port}`,
      TASK_TIMEOUT_SECONDS: "30",
      SETRA_SERVICE_OVERLAY: overlay,
      SETRA_EXECUTION_STORE: join(dir, "executions"),
      SETRA_FIXTURE_SOURCE_URL: sellerUrl + "/fixtures/company",
    },
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(sellerUrl + "/services")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  bridge = createMcpServer(new SellerMcpAdapter(sellerUrl));
  const mcpUrl = (await listen(bridge)) + "/mcp";
  runtime = createRuntime({
    directory: join(dir, "buyer"),
    mcpUrl,
    expectedMint: new PublicKey(required("ROLE_C_EXPECTED_MINT")),
    sourceClient: new SourceClient({}, undefined, [sellerUrl]),
    sandbox: new DockerSandbox(
      process.env.ROLE_C_DOCKER_WSL === "1"
        ? {
            executable: "wsl.exe",
            prefix: ["-u", "root", "--", "docker"],
            mapInputPath: (path) =>
              `/mnt/${path[0]!.toLowerCase()}${path
                .slice(2)
                .replaceAll("\\", "/")}`,
          }
        : { executable: "docker" }
    ),
    config: {
      programId: new PublicKey(required("ROLE_C_PROGRAM_ID")),
      rpcUrl: required("ROLE_C_RPC_URL"),
      sellerUrl,
      buyer: loadKeypair(required("ROLE_C_BUYER_KEYPAIR_PATH")),
      verifier: loadKeypair(required("ROLE_C_VERIFIER_KEYPAIR_PATH")),
      protocolTreasuryAddress: new PublicKey(
        required("ROLE_C_PROTOCOL_TREASURY")
      ),
      settlementSafetyMarginSec: 1,
    },
  });
  web = createControlPlane({
    registry,
    controller: runtime.controller,
    buyer: runtime.config.buyer.publicKey.toBase58(),
    sellerUrl,
  });
  origin = await listen(web);
  csrf = (
    (await (await fetch(origin + "/api/config")).json()) as {
      csrfToken: string;
    }
  ).csrfToken;
  for (const profile of ["source", "code"] as const) {
    await post("/api/services", {
      id: ids[profile],
      name: `Onboarded ${profile}`,
      description: "Live deterministic fixture",
      capability: `setra402.task.${profile}`,
      exposure: "both",
      price_base_units: "1500000",
      timeout_seconds: 30,
      privacy_support: true,
      provider_connector_ref: `fixture-${profile}`,
      verification_policy: {
        version: "1",
        level: 2,
        checks:
          profile === "source"
            ? [
                {
                  type: "source_sampling",
                  pointer: "/records",
                  sample_count: 3,
                  source_url_field: "source_url",
                  fields: ["company"],
                  allowed_domains: ["127.0.0.1"],
                  minimum_match_bps: 10000,
                },
              ]
            : [
                {
                  type: "test_suite",
                  runner_profile: "node22-test-v1",
                  test_bundle_hash: runtime.runners.list()[0]!.test_bundle_hash,
                  timeout_seconds: 10,
                },
              ],
      },
    });
  }
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.goto(origin);
  await page.waitForSelector("#provider-profile option", { state: "attached" });
}, 30000);
afterAll(async () => {
  await browser?.close();
  for (const server of [web, bridge]) {
    server?.closeAllConnections();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
  seller?.kill();
});
describe("onboarding -> shared REST/MCP registry -> real core -> chain -> web audit", () => {
  it("Screen A registration becomes selectable in Screen B and settles with a real report in Screen C", async () => {
    await page.fill("#service-id", ids.leads);
    await page.fill("#service-name", "Onboarded leads");
    await page.fill("#service-description", "Live onboarding browser fixture");
    await page.selectOption("#provider-profile", "fixture-lead");
    await page.fill(
      "#policy-json",
      JSON.stringify({
        version: "1",
        level: 1,
        checks: [{ type: "record_count", pointer: "/records", exact: 20 }],
      })
    );
    await page.click("#register");
    await page.waitForFunction(() =>
      document
        .getElementById("registration-result")!
        .textContent!.includes("Registered onboarded-leads")
    );
    const saved = registry.list().find((s) => s.id === ids.leads)!;
    const rest = (await (await fetch(sellerUrl + "/services")).json()) as {
      id: string;
      policy_hash: string;
    }[];
    const mcp = (await runtime.transports.MCP.discoverServices()) as {
      services: { id: string; policy_hash: string }[];
    };
    expect(rest.find((s) => s.id === ids.leads)?.policy_hash).toBe(
      saved.policy_hash
    );
    expect(mcp.services.find((s) => s.id === ids.leads)?.policy_hash).toBe(
      saved.policy_hash
    );
    expect(await page.locator("#registration-result").textContent()).toContain(
      saved.policy_hash
    );
    await page.click('[data-screen="lifecycle"]');
    await page.selectOption("#task-service", ids.leads);
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
      () => document.getElementById("app-state")!.textContent === "SETTLED"
    );
    await page.click("#show-audit");
    expect(await page.locator("#verdict").textContent()).toBe("PASS");
    expect(await page.locator("#audit-chain").textContent()).toBe("Settled");
    expect(await page.locator("#raw-report").textContent()).toContain(
      saved.policy_hash
    );
    expect(readFileSync(baseline)).toEqual(baselineBytes);
    await page.screenshot({
      path: join(dir, "verification-audit.png"),
      fullPage: true,
    });
  }, 30000);
  it.each(
    ["leads", "source", "code"].flatMap((profile) =>
      ["REST", "MCP"].flatMap((transport) =>
        ["valid", "invalid"].map((fixture) => ({ profile, transport, fixture }))
      )
    )
  )(
    "onboarded $profile / $transport / $fixture uses the shared coordinator",
    async ({ profile, transport, fixture }) => {
      const args = {
        task_id: (taskId++).toString(),
        buyer: runtime.config.buyer.publicKey.toBase58(),
        service_id: ids[profile as keyof typeof ids],
        is_private: false,
        input: { fixture },
        transport,
      };
      await post("/api/tasks/quote", args);
      await post("/api/tasks/fund", args);
      const result = await post("/api/tasks/run", args);
      expect(result.status).toBe(
        fixture === "valid" ? "settled" : "verification_failed"
      );
      expect(result.report.passed).toBe(fixture === "valid");
      const status = await post("/api/tasks/status", args);
      expect(status.chainState.status).toBe(
        fixture === "valid" ? "settled" : "pending"
      );
      if (fixture === "invalid") expect(result.settlement).toBeNull();
    },
    30000
  );
});
