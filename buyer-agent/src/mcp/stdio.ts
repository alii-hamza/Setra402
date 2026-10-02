import { createRuntime } from "../core/runtime.js";
import { CoreMcpTools } from "./core-tools.js";
import { McpDispatcher } from "./protocol.js";
// stdout is exclusively newline-delimited JSON-RPC. All diagnostics use stderr.
try {
  const runtime = createRuntime();
  const dispatcher = new McpDispatcher(
    new CoreMcpTools(
      runtime.controller,
      runtime.config.sellerUrl,
      runtime.config.buyer.publicKey.toBase58()
    )
  );
  let buffer = "",
    queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 131_072 && !buffer.includes("\n")) {
      process.stderr.write("MCP input exceeds limit\n");
      process.exitCode = 1;
      process.stdin.destroy();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      queue = queue.then(async () => {
        try {
          if (Buffer.byteLength(line) > 131_072)
            throw new Error("input too large");
          const result = await dispatcher.dispatch(JSON.parse(line));
          if (result !== null)
            process.stdout.write(JSON.stringify(result) + "\n");
        } catch {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            }) + "\n"
          );
        }
      });
    }
  });
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "runtime failed") + "\n"
  );
  process.exitCode = 1;
}
