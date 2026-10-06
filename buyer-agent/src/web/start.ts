import { fileURLToPath } from "node:url";
import { createRuntime } from "../core/runtime.js";
import { ServiceRegistry } from "../registry/services.js";
import { createControlPlane } from "./server.js";
import { createMcpServer } from "../mcp/protocol.js";
import { SellerMcpAdapter } from "../mcp/seller-adapter.js";
import { loadControlPlaneSettings } from "../runtime-config.js";
const settings = loadControlPlaneSettings(
  process.env,
  fileURLToPath(
    new URL(
      "../../../seller-server/config/services.local.json",
      import.meta.url
    )
  )
);
const runtime = createRuntime({
  mcpUrl: `http://127.0.0.1:${settings.mcpPort}/mcp`,
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
}).listen(settings.webPort, "127.0.0.1", () =>
  process.stderr.write(
    `Setra control plane: http://127.0.0.1:${settings.webPort}\n`
  )
);
