import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ServiceRegistry, PROVIDER_PROFILES } from "../registry/services.js";
import { jsonSafe } from "../mcp/protocol.js";
import {
  taskCallSchema,
  type ProtectedTaskController,
} from "../core/task-controller.js";
import { defaultRunners } from "../verification/level2/default-runners.js";
import type { ServiceDefinition } from "../registry/services.js";

export interface ControlPlaneOptions {
  registry: ServiceRegistry;
  controller: ProtectedTaskController;
  buyer: string;
  sellerUrl: string;
  discover?: () => Promise<unknown[]>;
  clientDirectory?: URL;
}
export function createControlPlane(options: ControlPlaneOptions): Server {
  const token = randomBytes(32).toString("hex");
  const directory =
    options.clientDirectory ?? new URL("../../../frontend/", import.meta.url);
  const discover =
    options.discover ??
    (async () => {
      const response = await fetch(`${options.sellerUrl}/services`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("seller discovery unavailable");
      return (await response.json()) as unknown[];
    });
  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    const host = req.headers.host ?? "",
      localHost = host.replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(localHost)) {
      res.writeHead(403).end();
      return;
    }
    const origin = `http://${host}`;
    if (req.headers.origin && req.headers.origin !== origin) {
      res.writeHead(403).end();
      return;
    }
    const reply = (status: number, value: unknown) => {
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(jsonSafe(value)));
    };
    try {
      const pathname = new URL(req.url ?? "/", origin).pathname;
      if (req.method === "GET") {
        if (pathname === "/favicon.ico") {
          res.writeHead(204).end();
          return;
        }
        if (pathname === "/api/config") {
          reply(200, {
            buyer: options.buyer,
            writeEnabled: options.registry.writeEnabled,
            csrfToken: token,
            providerProfiles: PROVIDER_PROFILES.map((profile) => ({
              version: profile.version,
              provider_id: profile.provider_id,
              display_name: profile.display_name,
              connector_type: profile.connector_type,
              capabilities: profile.capabilities,
              privacy_support: profile.privacy_support,
              active: profile.active,
              recovery_capabilities: profile.recovery_capabilities,
              requires_secret: profile.secret_refs.length > 0,
            })),
            runners: defaultRunners().list(),
          });
          return;
        }
        if (pathname === "/api/services" || pathname === "/services") {
          reply(200, { services: await discover() });
          return;
        }
        const file = (
          {
            "/": "index.html",
            "/app.js": "app.js",
            "/styles.css": "styles.css",
          } as Record<string, string>
        )[pathname];
        if (!file) {
          reply(404, { error: "not found" });
          return;
        }
        res
          .writeHead(200, {
            "content-type": file.endsWith(".html")
              ? "text/html; charset=utf-8"
              : file.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/javascript; charset=utf-8",
          })
          .end(readFileSync(new URL(file, directory)));
        return;
      }
      if (req.method !== "POST") {
        reply(405, { error: "method not allowed" });
        return;
      }
      const provided = req.headers["x-setra-csrf"];
      if (
        typeof provided !== "string" ||
        provided.length !== token.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
      ) {
        reply(403, { error: "same-origin session token required" });
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        reply(415, { error: "JSON required" });
        return;
      }
      let bytes = Buffer.alloc(0);
      for await (const chunk of req) {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 131072) {
          reply(413, { error: "request too large" });
          return;
        }
      }
      const body: unknown = JSON.parse(bytes.toString("utf8"));
      if (pathname === "/api/services") {
        const saved = await options.registry.register(body);
        const visible = ((await discover()) as ServiceDefinition[]).find(
          (s) => s.id === saved.id
        );
        if (!visible || visible.policy_hash !== saved.policy_hash) {
          reply(503, {
            error:
              "Saved locally; seller discovery read-back failed. Reconcile before retrying registration.",
            service: saved,
          });
          return;
        }
        reply(201, { status: "registered", service: visible });
        return;
      }
      const actions = {
        "/api/tasks/quote": "protectedCall",
        "/api/tasks/run": "protectedCall",
        "/api/tasks/fund": "fund",
        "/api/tasks/status": "status",
        "/api/tasks/refund": "refund",
      } as const;
      const action = actions[pathname as keyof typeof actions];
      if (!action) {
        reply(404, { error: "not found" });
        return;
      }
      const call = taskCallSchema.parse(body);
      if (call.buyer !== options.buyer)
        throw new Error("buyer does not match configured signer");
      const service = ((await discover()) as ServiceDefinition[]).find(
        (s) => s.id === call.service_id
      );
      if (
        !service ||
        (service.exposure !== "both" &&
          service.exposure !== call.transport.toLowerCase()) ||
        (call.is_private && !service.privacy_support)
      )
        throw new Error("service transport or privacy mode unavailable");
      reply(200, await options.controller[action](call));
    } catch (error) {
      reply(
        error instanceof Error && error.message.includes("disabled")
          ? 403
          : 400,
        { error: error instanceof Error ? error.message : "request rejected" }
      );
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
