import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OperatorRecovery, type OperatorFilter } from "./operator-recovery.js";
import {
  defaultHealthProbes,
  inspectOperatorHealth,
} from "./operator-health.js";
import { metricsText } from "./operator-telemetry.js";

export async function runOperatorCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const command = args[0];
  const root = resolve(env.SETRA_STATE_DIR ?? ".setra-state");
  const operator = new OperatorRecovery({
    stateDirectory: root,
    ...(env.SETRA_SELLER_EXECUTION_DIR
      ? { sellerExecutionDirectory: resolve(env.SETRA_SELLER_EXECUTION_DIR) }
      : {}),
    ...(env.SETRA_SELLER_MINT_DIR
      ? { sellerMintDirectory: resolve(env.SETRA_SELLER_MINT_DIR) }
      : {}),
    ...(env.SETRA_SELLER_URL ? { sellerUrl: env.SETRA_SELLER_URL } : {}),
  });
  if (command === "task") {
    if (args.length !== 2) throw new Error("usage: operator task <task-key>");
    return JSON.stringify(
      operator.task(args[1]!) ?? { error: "task not found" }
    );
  }
  if (command === "list") {
    if (args.length > 4)
      throw new Error("usage: operator list [filter] [offset] [limit]");
    const offset = args[2] === undefined ? 0 : Number(args[2]),
      limit = args[3] === undefined ? 50 : Number(args[3]);
    return JSON.stringify(
      operator.list((args[1] ?? "ALL") as OperatorFilter, offset, limit)
    );
  }
  if (command === "validate" && args.length === 1)
    return JSON.stringify(operator.validateBackup());
  if (command === "metrics" && args.length === 1)
    return metricsText(operator.metrics());
  if (command === "health" && args.length === 1)
    return JSON.stringify(
      await inspectOperatorHealth(
        root,
        defaultHealthProbes({
          ...(env.ROLE_C_RPC_URL ? { rpcUrl: env.ROLE_C_RPC_URL } : {}),
          ...(env.SETRA_SELLER_URL ? { sellerUrl: env.SETRA_SELLER_URL } : {}),
          ...(env.SETRA_REDIS_HOST ? { redisHost: env.SETRA_REDIS_HOST } : {}),
          ...(env.SETRA_REDIS_PORT
            ? { redisPort: Number(env.SETRA_REDIS_PORT) }
            : {}),
        })
      )
    );
  throw new Error("usage: operator <task|list|validate|metrics|health>");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runOperatorCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${result}\n`))
    .catch((error) => {
      process.stderr.write(
        `${
          error instanceof Error ? error.name : "Error"
        }: operator inspection failed\n`
      );
      process.exitCode = 1;
    });
}
