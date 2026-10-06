import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  prepareDevelopmentEnvironment,
  type PreparedDevelopmentEnvironment,
} from "./environment.js";
import {
  runDevelopmentPreflight,
  type DevelopmentCheck,
  type DevelopmentProbes,
} from "./preflight.js";
import { startDevelopmentEnvironment } from "./processes.js";

export { prepareDevelopmentEnvironment, runDevelopmentPreflight };
export type {
  DevelopmentCheck,
  DevelopmentProbes,
  PreparedDevelopmentEnvironment,
};

function loadEnvFile(envPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=").trim();
      if (key && !env[key]) {
        env[key] = value;
      }
    }
  } catch {
    // .env file not found or not readable, proceed with process.env
  }
  return env;
}

export function parseDevelopmentArgs(args: string[]): { checkOnly: boolean } {
  let checkOnly = false;
  for (const argument of args) {
    if (argument === "--check") checkOnly = true;
    else if (argument === "--reset-test-ledger")
      throw new Error(
        "Ledger reset is not implemented by dev:setra; reset disposable fixtures with the repository's explicit test workflow."
      );
    else throw new Error(`Unknown dev:setra option: ${argument}`);
  }
  return { checkOnly };
}

function printChecks(checks: DevelopmentCheck[]): void {
  process.stdout.write("Setra402 local environment\n\n");
  for (const check of checks) {
    const state = check.state === "START_REQUIRED" ? "READY" : check.state;
    process.stdout.write(
      `${check.name.padEnd(12)} ${state.padEnd(11)} ${check.detail}\n`
    );
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseDevelopmentArgs(args);
  const buyerDir = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(join(buyerDir, "..", "..", ".env"));
  const env = loadEnvFile(envPath);
  const prepared = prepareDevelopmentEnvironment(env);
  const preflight = await runDevelopmentPreflight(prepared);
  printChecks(preflight.checks);
  if (!preflight.ready)
    throw new Error(
      "Setra402 preflight failed. Blocked processes were not terminated; review the ownership details above."
    );
  if (options.checkOnly) return;
  await startDevelopmentEnvironment(prepared, preflight);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `dev:setra failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}
