import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OperatorRecovery, type OperatorFilter } from "./operator-recovery.js";
import {
  defaultHealthProbes,
  inspectOperatorHealth,
} from "./operator-health.js";
import { metricsText } from "./operator-telemetry.js";
import { loadOperatorSettings } from "../runtime-config.js";

export async function runOperatorCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const command = args[0];
  const settings = loadOperatorSettings(env);
  const root = settings.stateDirectory;
  const operator = new OperatorRecovery({
    stateDirectory: root,
    ...(settings.sellerExecutionDirectory
      ? { sellerExecutionDirectory: settings.sellerExecutionDirectory }
      : {}),
    ...(settings.sellerMintDirectory
      ? { sellerMintDirectory: settings.sellerMintDirectory }
      : {}),
    ...(settings.sellerUrl ? { sellerUrl: settings.sellerUrl } : {}),
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
          ...(settings.rpcUrl ? { rpcUrl: settings.rpcUrl } : {}),
          ...(settings.sellerUrl ? { sellerUrl: settings.sellerUrl } : {}),
          ...(settings.redisHost ? { redisHost: settings.redisHost } : {}),
          ...(settings.redisPort ? { redisPort: settings.redisPort } : {}),
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
