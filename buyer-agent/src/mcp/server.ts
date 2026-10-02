import { createMcpServer } from "./protocol.js";
import { SellerMcpAdapter } from "./seller-adapter.js";
const port = Number(process.env.MCP_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("invalid MCP_PORT");
createMcpServer(
  new SellerMcpAdapter(process.env.SELLER_URL ?? "http://127.0.0.1:3000")
).listen(port, "127.0.0.1", () =>
  process.stderr.write(
    `Setra seller MCP adapter listening on 127.0.0.1:${port}\n`
  )
);
