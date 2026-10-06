import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  const prepared = prepareDevelopmentEnvironment();
  const preflight = await runDevelopmentPreflight(prepared);
  printChecks(preflight.checks);
  if (!preflight.ready) throw new Error("Setra402 preflight failed");
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
