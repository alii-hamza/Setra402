import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createRuntime } from "../core/runtime.js";
import { ServiceRegistry } from "../registry/services.js";
import { createControlPlane } from "./server.js";
import { createMcpServer } from "../mcp/protocol.js";
import { SellerMcpAdapter } from "../mcp/seller-adapter.js";
import {
  loadControlPlaneSettings,
  loadOperatorSettings,
  loadRuntimeSettings,
} from "../runtime-config.js";
import {
  defaultHealthProbes,
  inspectOperatorHealth,
} from "../core/operator-health.js";

// Load environment variables from .env file
config();

const settings = loadControlPlaneSettings(
  process.env,
  fileURLToPath(
    new URL(
      "../../../seller-server/config/services.local.json",
      import.meta.url
    )
  )
);
const mcpUrl = `http://127.0.0.1:${settings.mcpPort}/mcp`;
const runtimeSettings = loadRuntimeSettings({
  ...process.env,
  MCP_URL: mcpUrl,
  SELLER_URL: process.env.SELLER_URL || "http://127.0.0.1:3000",
});
const runtime = createRuntime({
  settings: runtimeSettings,
});
const operatorSettings = loadOperatorSettings({
  ...process.env,
  RPC_URL: runtime.config.rpcUrl,
  SELLER_URL: runtime.config.sellerUrl,
  MCP_URL: mcpUrl,
});
const registry = new ServiceRegistry(
  new URL("../../../seller-server/config/services.json", import.meta.url),
  settings.serviceOverlay,
  settings.onboardingWriteEnabled
);
createMcpServer(new SellerMcpAdapter(runtime.config.sellerUrl)).listen(
  settings.mcpPort,
  "127.0.0.1"
);
createControlPlane({
  registry,
  controller: runtime.controller,
  buyer: runtime.config.buyer.publicKey.toBase58(),
  sellerUrl: runtime.config.sellerUrl,
  health: () =>
    inspectOperatorHealth(
      runtimeSettings.stateDirectory,
      defaultHealthProbes({
        rpcUrl: runtime.config.rpcUrl,
        sellerUrl: runtime.config.sellerUrl,
        ...(operatorSettings.redisHost
          ? { redisHost: operatorSettings.redisHost }
          : {}),
        ...(operatorSettings.redisPort
          ? { redisPort: operatorSettings.redisPort }
          : {}),
        ...(operatorSettings.redisTls !== undefined
          ? { redisTls: operatorSettings.redisTls }
          : {}),
        mcpUrl,
      }),
      1_073_741_824,
      { refundSchedulerEnabled: operatorSettings.refundSchedulerEnabled }
    ),
}).listen(settings.webPort, "127.0.0.1", () =>
  process.stderr.write(
    `Setra control plane: http://127.0.0.1:${settings.webPort}\n`
  )
);
