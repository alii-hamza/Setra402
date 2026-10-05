import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { request } from "node:http";
import { createControlPlane } from "../../src/web/server.js";
import { ServiceRegistry } from "../../src/registry/services.js";
import type { ProtectedTaskController } from "../../src/core/task-controller.js";
const value = {
  id: "api-service",
  name: "API service",
  description: "Fixture",
  capability: "setra402.task.echo",
  exposure: "both",
  price_base_units: "100",
  timeout_seconds: 30,
  privacy_support: true,
  provider_connector_ref: "fixture-echo",
  verification_policy: {
    version: "1",
    level: 1,
    checks: [{ type: "json_schema", schema_ref: "generic-object-v1" }],
  },
};
async function setup(enabled = true) {
  const registry = new ServiceRegistry(
    new URL("../../../seller-server/config/services.json", import.meta.url),
    join(
      mkdtempSync(join(tmpdir(), "setra-api-registry-")),
      "services.local.json"
    ),
    enabled
  );
  const server = createControlPlane({
    registry,
    controller: {} as ProtectedTaskController,
    buyer: "unused",
    sellerUrl: "unused",
    async discover() {
      return registry.list();
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${
      (server.address() as { port: number }).port
    }`,
    config = (await (await fetch(origin + "/api/config")).json()) as {
      csrfToken: string;
    };
  return {
    origin,
    server,
    registry,
    headers: {
      "content-type": "application/json",
      "x-setra-csrf": config.csrfToken,
    },
  };
}
describe("local onboarding API write boundary", () => {
  it("exposes capability summaries without secret refs or values", async () => {
    const s = await setup();
    try {
      const response = await fetch(s.origin + "/api/config");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.providerProfiles[0]).toMatchObject({
        provider_id: "fixture-echo",
        connector_type: "LOCAL_FIXTURE",
        requires_secret: false,
      });
      expect(JSON.stringify(body.providerProfiles)).not.toMatch(
        /secret_refs|secret_value|api_key|authorization/
      );
    } finally {
      await new Promise<void>((resolve) => s.server.close(() => resolve()));
    }
  });
  it("valid registration reads back the canonical service", async () => {
    const s = await setup();
    try {
      const response = await fetch(s.origin + "/api/services", {
        method: "POST",
        headers: s.headers,
        body: JSON.stringify(value),
      });
      expect(response.status).toBe(201);
      const saved = await response.json();
      expect(saved).toMatchObject({
        status: "registered",
        service: { id: value.id, policy_hash: expect.any(String) },
      });
      expect(await (await fetch(s.origin + "/services")).json()).toMatchObject({
        services: expect.arrayContaining([saved.service]),
      });
    } finally {
      s.server.closeAllConnections();
      s.server.close();
    }
  });
  it("writes disabled by default preserves discovery", async () => {
    const s = await setup(false);
    try {
      expect(
        (
          await fetch(s.origin + "/api/services", {
            method: "POST",
            headers: s.headers,
            body: JSON.stringify(value),
          })
        ).status
      ).toBe(403);
      expect((await fetch(s.origin + "/services")).status).toBe(200);
    } finally {
      s.server.closeAllConnections();
      s.server.close();
    }
  });
  it("rejects cross-origin writes", async () => {
    const s = await setup();
    try {
      expect(
        (
          await fetch(s.origin + "/api/services", {
            method: "POST",
            headers: { ...s.headers, origin: "https://hostile.example" },
            body: JSON.stringify(value),
          })
        ).status
      ).toBe(403);
    } finally {
      s.server.closeAllConnections();
      s.server.close();
    }
  });
  it("rejects writes without the same-origin token", async () => {
    const s = await setup();
    try {
      expect(
        (
          await fetch(s.origin + "/api/services", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(value),
          })
        ).status
      ).toBe(403);
    } finally {
      s.server.closeAllConnections();
      s.server.close();
    }
  });
  it("rejects DNS-rebinding Host", async () => {
    const s = await setup();
    try {
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = request(
            s.origin + "/services",
            { headers: { host: "hostile.example" } },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            }
          );
          req.on("error", reject);
          req.end();
        }
      );
      expect(status).toBe(403);
    } finally {
      s.server.closeAllConnections();
      s.server.close();
    }
  });
  it("rejects oversized mutation bodies", async () => {
    const s = await setup();
    try {
      expect(
        (
          await fetch(s.origin + "/api/services", {
            method: "POST",
            headers: s.headers,
            body: "x".repeat(132000),
          })
        ).status
      ).toBe(413);
    } finally {
      s.server.closeAllConnections();
      s.server.close();
    }
  });
  it("has strict CSP and no signing configuration in browser config", async () => {
    const s = await setup();
    try {
      const response = await fetch(s.origin);
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'"
      );
      const text = await (await fetch(s.origin + "/api/config")).text();
      expect(text).not.toMatch(
        /secretKey|KEYPAIR_PATH|process.env|provider_api_secret|admin_token/
      );
    } finally {
      s.server.closeAllConnections();
      s.server.close();
    }
  });
});
