import { createMcpServer } from "./protocol.js";
import { SellerMcpAdapter } from "./seller-adapter.js";
import { loadMcpBridgeSettings } from "../runtime-config.js";
const settings = loadMcpBridgeSettings();
createMcpServer(new SellerMcpAdapter(settings.sellerUrl)).listen(
  settings.mcpPort,
  "127.0.0.1",
  () =>
    process.stderr.write(
      `Setra seller MCP adapter listening on 127.0.0.1:${settings.mcpPort}\n`
    )
);
