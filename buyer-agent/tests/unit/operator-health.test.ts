import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultHealthProbes,
  inspectOperatorHealth,
} from "../../src/core/operator-health.js";

afterEach(() => vi.unstubAllGlobals());

describe("operator readiness", () => {
  it("separates operational dependencies from provider and scheduler state", async () => {
    const root = mkdtempSync(join(tmpdir(), "setra-health-"));
    mkdirSync(join(root, "reconciliation", "claims"), { recursive: true });
    mkdirSync(join(root, "reconciliation", "gates"), { recursive: true });
    mkdirSync(join(root, "reconciliation", "records"), { recursive: true });

    const health = await inspectOperatorHealth(
      root,
      {
        rpc: async () => true,
        seller: async () => true,
        redis: async () => true,
        docker: async () => true,
        mcp: async () => false,
        providers: async () => ({
          catalog: "HEALTHY",
          secrets: "DEGRADED",
        }),
        disk: () => 10_000,
      },
      100,
      { refundSchedulerEnabled: false }
    );

    expect(health.status).toBe("UNAVAILABLE");
    expect(health.resources).toMatchObject({
      providerCatalog: "HEALTHY",
      providerSecrets: "DEGRADED",
      mcp: "UNAVAILABLE",
      reconciliation: "HEALTHY",
      refundScheduler: "NOT_CONFIGURED",
    });
  });

  it("reports a configured but impaired optional subsystem as degraded", async () => {
    const root = mkdtempSync(join(tmpdir(), "setra-health-"));
    const health = await inspectOperatorHealth(
      root,
      {
        rpc: async () => true,
        seller: async () => true,
        redis: async () => true,
        docker: async () => true,
        mcp: async () => true,
        providers: async () => ({
          catalog: "HEALTHY",
          secrets: "HEALTHY",
        }),
        disk: () => 10_000,
      },
      100,
      { refundSchedulerEnabled: true }
    );

    expect(health.status).toBe("DEGRADED");
    expect(health.resources.refundScheduler).toBe("HEALTHY");
    expect(health.resources.reconciliation).toBe("UNAVAILABLE");
  });

  it("validates bounded provider and MCP readiness responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              provider_id: "fixture",
              activation_state: "ACTIVE",
              health_state: "CONFIGURED",
              required_secret_status: "AVAILABLE",
              can_accept_new_execution: true,
            },
          ]),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "health", result: {} }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const probes = defaultHealthProbes({
      sellerUrl: "http://127.0.0.1:3001",
      mcpUrl: "http://127.0.0.1:3002/mcp",
    });

    await expect(probes.providers!()).resolves.toEqual({
      catalog: "HEALTHY",
      secrets: "HEALTHY",
    });
    await expect(probes.mcp!()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
