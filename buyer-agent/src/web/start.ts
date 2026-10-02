import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../core/runtime.js";
import { ServiceRegistry } from "../registry/services.js";
import { createControlPlane } from "./server.js";
import { createMcpServer } from "../mcp/protocol.js";
import { SellerMcpAdapter } from "../mcp/seller-adapter.js";
const overlay = resolve(
  process.env.SETRA_SERVICE_OVERLAY ??
    fileURLToPath(
      new URL(
        "../../../seller-server/config/services.local.json",
        import.meta.url
      )
    )
);
const mcpPort = Number(process.env.MCP_PORT ?? 3002),
  webPort = Number(process.env.WEB_PORT ?? 3003);
for (const port of [mcpPort, webPort])
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("invalid port");
const runtime = createRuntime({ mcpUrl: `http://127.0.0.1:${mcpPort}/mcp` });
const registry = new ServiceRegistry(
  new URL("../../../seller-server/config/services.json", import.meta.url),
  overlay,
  process.env.SETRA_ONBOARDING_WRITE_ENABLED === "true"
);
createMcpServer(new SellerMcpAdapter(runtime.config.sellerUrl)).listen(
  mcpPort,
  "127.0.0.1"
);
createControlPlane({
  registry,
  controller: runtime.controller,
  buyer: runtime.config.buyer.publicKey.toBase58(),
  sellerUrl: runtime.config.sellerUrl,
}).listen(webPort, "127.0.0.1", () =>
  process.stderr.write(`Setra control plane: http://127.0.0.1:${webPort}\n`)
);
