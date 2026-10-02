import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { BuyerOrchestrator } from "../../src/orchestrator.js";
import { RestX402Transport } from "../../src/transport/rest-x402.js";
import { McpTransport } from "../../src/transport/mcp.js";
import { createMcpServer } from "../../src/mcp/protocol.js";
import { SellerMcpAdapter } from "../../src/mcp/seller-adapter.js";
import { verificationHarness } from "../fixtures/verification-harness.js";
import { RunnerProfileRegistry } from "../../src/verification/level2/runner-registry.js";
import type { VerificationPolicyV1 } from "../../src/types.js";
const listen = (s: ReturnType<typeof createServer>) =>
  new Promise<string>((r) =>
    s.listen(0, "127.0.0.1", () =>
      r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)
    )
  );
describe("REST/MCP authoritative report and shared settlement parity (simulated chain/sandbox)", () => {
  it.each([
    "l1-pass",
    "l1-fail",
    "source-pass",
    "source-fail",
    "tests-pass",
    "tests-fail",
  ])("%s", async (mode) => {
    const bytes = Buffer.from("artifact"),
      hash = createHash("sha256").update(bytes).digest("hex");
    const runners = new RunnerProfileRegistry([
      {
        id: "fixture-runner",
        image: "node@sha256:" + "a".repeat(64),
        command: ["node"],
        artifactEvidenceId: "code-module",
        testBundle: Buffer.from("trusted tests"),
        maxArtifactBytes: 100,
      },
    ]);
    const policy: VerificationPolicyV1 = mode.startsWith("l1")
      ? {
          version: "1",
          level: 1,
          checks: [
            {
              type: "record_count",
              pointer: "/records",
              exact: mode.endsWith("pass") ? 1 : 2,
            },
          ],
        }
      : mode.startsWith("source")
      ? {
          version: "1",
          level: 2,
          checks: [
            {
              type: "source_sampling",
              pointer: "/records",
              sample_count: 1,
              source_url_field: "source_url",
              fields: ["company"],
              allowed_domains: ["example.com"],
              minimum_match_bps: 10000,
            },
          ],
        }
      : {
          version: "1",
          level: 2,
          checks: [
            {
              type: "test_suite",
              runner_profile: "fixture-runner",
              test_bundle_hash: runners.list()[0]!.test_bundle_hash,
              timeout_seconds: 5,
            },
          ],
        };
    const value = mode.startsWith("tests")
      ? {
          artifact: {
            id: "code-module",
            content_hash: hash,
            size_bytes: bytes.length,
          },
        }
      : {
          records: [
            { company: "Acme", source_url: "https://example.com/source" },
          ],
        };
    const h = verificationHarness(policy, value);
    if (mode.startsWith("tests"))
      h.result.evidence = [
        {
          type: "artifact",
          id: "code-module",
          content_hash: hash,
          size_bytes: bytes.length,
        },
      ];
    h.context.source = {
      challenges: {
        async getOrCreate() {
          return "a".repeat(64);
        },
      },
      sourceClient: {
        async retrieve() {
          return { company: mode.endsWith("pass") ? "Acme" : "Wrong" };
        },
      },
    };
    h.context.tests = {
      runners,
      async loadArtifact() {
        return { bytes };
      },
      sandbox: {
        async execute() {
          return {
            exitCode: mode.endsWith("pass") ? 0 : 1,
            output: "simulated runner",
            durationMs: 1,
          };
        },
      },
    };
    let funded = false;
    const seller = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      if (!funded) {
        res.writeHead(402).end(JSON.stringify(h.quote.raw));
        return;
      }
      res.end(
        JSON.stringify({
          version: "1",
          task_id: h.result.taskId,
          service_id: h.result.serviceId,
          result: h.result.result,
          result_hash: h.result.resultHash,
          evidence: h.result.evidence,
          completed_at_unix: 50,
          input: value,
          output_hash: h.result.output_hash,
        })
      );
    });
    const origin = await listen(seller),
      bridge = createMcpServer(new SellerMcpAdapter(origin)),
      endpoint = (await listen(bridge)) + "/mcp";
    const input = {
      taskId: 99n,
      buyer: h.chain.buyer.toBase58(),
      serviceId: h.quote.serviceId,
      isPrivate: false,
      input: value,
    };
    const funding = {
      async ensureFunded() {
        funded = true;
        return {
          state: h.current(),
          record: h.record,
          initializeSignature: "init",
        };
      },
    };
    const verify = {
      async verify(
        manifest: typeof h.manifest,
        committedPolicy: VerificationPolicyV1,
        result: typeof h.result
      ) {
        return h.engine.verify(manifest, committedPolicy, result, h.context);
      },
    };
    try {
      const rest = await new BuyerOrchestrator(
        new RestX402Transport(origin, () => h.quote),
        funding,
        h.settlement,
        verify
      ).run(input);
      h.reset();
      funded = false;
      const mcp = await new BuyerOrchestrator(
        new McpTransport(endpoint, () => h.quote),
        funding,
        h.settlement,
        verify
      ).run(input);
      expect(mcp).toEqual(rest);
      expect(h.calls.filter((v) => v === "settle")).toHaveLength(
        mode.endsWith("pass") ? 2 : 0
      );
      expect(h.calls).not.toContain("cancel");
    } finally {
      seller.closeAllConnections();
      bridge.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => seller.close(() => r())),
        new Promise<void>((r) => bridge.close(() => r())),
      ]);
    }
  });
});
