import { createServer, type Server } from "node:http";
import type { McpTool } from "./contracts.js";

export interface ToolHandler {
  tools: readonly McpTool[];
  call(name: string, args: unknown): Promise<unknown>;
}
export function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? v.toString() : v
    )
  );
}

export class McpDispatcher {
  constructor(private readonly handler: ToolHandler) {}
  async dispatch(value: unknown): Promise<unknown | null> {
    const req = value as {
      jsonrpc?: unknown;
      id?: unknown;
      method?: unknown;
      params?: Record<string, unknown>;
    };
    if (
      !req ||
      typeof req !== "object" ||
      Array.isArray(req) ||
      req.jsonrpc !== "2.0" ||
      typeof req.method !== "string" ||
      (req.id !== undefined &&
        typeof req.id !== "string" &&
        typeof req.id !== "number")
    )
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      };
    if (req.id === undefined) return null;
    const reply = (result: unknown) => ({
      jsonrpc: "2.0",
      id: req.id,
      result: jsonSafe(result),
    });
    try {
      if (req.method === "initialize")
        return reply({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: {
            name: "Setra402",
            version: "0.3.0",
            description:
              "Trust and conditional-settlement layer for autonomous agent payments. Setra402 provides escrow, verification, and protected execution for external service calls.",
          },
        });
      if (req.method === "ping") return reply({});
      if (req.method === "tools/list")
        return reply({ tools: this.handler.tools });
      if (req.method === "tools/call") {
        const p = req.params;
        if (!p || typeof p.name !== "string")
          throw new Error("tool name required");
        if (!this.handler.tools.some((t) => t.name === p.name))
          throw new Error("unknown tool");
        const result = await this.handler.call(p.name, p.arguments ?? {});
        return reply({
          content: [{ type: "text", text: JSON.stringify(jsonSafe(result)) }],
        });
      }
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "Method not found" },
      };
    } catch (error) {
      return reply({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: error instanceof Error ? error.message : "tool failed",
            }),
          },
        ],
      });
    }
  }
}

// Stateless Streamable HTTP: POST JSON responses; GET/SSE is not offered.
// This local adapter rejects browser origins and binds loopback by default.
export function createMcpServer(handler: ToolHandler): Server {
  const dispatcher = new McpDispatcher(handler);
  const server = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (
      req.headers.origin ||
      !["127.0.0.1", "localhost", "[::1]"].includes(
        (req.headers.host ?? "").replace(/:\d+$/, "")
      )
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      res.writeHead(415).end();
      return;
    }
    try {
      let body = Buffer.alloc(0);
      for await (const chunk of req) {
        body = Buffer.concat([body, Buffer.from(chunk)]);
        if (body.length > 131_072) {
          res.writeHead(413).end();
          return;
        }
      }
      const result = await dispatcher.dispatch(
        JSON.parse(body.toString("utf8"))
      );
      if (result === null) {
        res.writeHead(202).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(result));
    } catch {
      res.writeHead(400).end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
