import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultHealthProbes } from "../core/operator-health.js";
import type { PreparedDevelopmentEnvironment } from "./environment.js";
import { safeProbe, type DevelopmentCheck } from "./preflight.js";

function commandPath(name: "cargo"): string {
  if (name === "cargo" && process.env.SETRA_CARGO_PATH)
    return process.env.SETRA_CARGO_PATH;
  return process.platform === "win32" && process.env.USERPROFILE
    ? join(process.env.USERPROFILE, ".cargo", "bin", `${name}.exe`)
    : name;
}

function forward(prefix: string, stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) process.stderr.write(`[${prefix}] ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) process.stderr.write(`[${prefix}] ${pending}\n`);
  });
}

function runBuild(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((complete, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    forward("build", child.stdout);
    forward("build", child.stderr);
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? complete()
        : reject(new Error(`seller build exited with status ${code}`))
    );
  });
}

async function waitFor(
  probeValue: () => Promise<boolean>,
  label: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await safeProbe(probeValue)) return;
    await new Promise((complete) => setTimeout(complete, 250));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

function terminate(child: ChildProcess): void {
  if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
}

export async function startDevelopmentEnvironment(
  prepared: PreparedDevelopmentEnvironment,
  preflight: { checks: DevelopmentCheck[] }
): Promise<void> {
  mkdirSync(prepared.runtime.stateDirectory, { recursive: true });
  mkdirSync(prepared.sellerEnvironment.SETRA_EXECUTION_STORE!, {
    recursive: true,
  });
  const owned: ChildProcess[] = [];
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of owned) terminate(child);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (
      preflight.checks.some(
        (check) => check.name === "Seller" && check.state === "START_REQUIRED"
      )
    ) {
      await runBuild(
        commandPath("cargo"),
        [
          "build",
          "--manifest-path",
          join(prepared.repositoryRoot, "seller-server", "Cargo.toml"),
        ],
        prepared.repositoryRoot
      );
      const sellerExecutable = join(
        prepared.repositoryRoot,
        "target",
        "debug",
        process.platform === "win32" ? "seller-server.exe" : "seller-server"
      );
      const seller = spawn(sellerExecutable, [], {
        cwd: join(prepared.repositoryRoot, "seller-server"),
        env: prepared.sellerEnvironment,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      owned.push(seller);
      forward("seller", seller.stdout);
      forward("seller", seller.stderr);
      await waitFor(
        defaultHealthProbes({ sellerUrl: prepared.endpoints.seller }).seller!,
        "seller"
      );
    }
    const control = spawn(
      process.execPath,
      [join(prepared.buyerDirectory, "dist", "web", "start.js")],
      {
        cwd: prepared.buyerDirectory,
        env: prepared.childEnvironment,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    owned.push(control);
    forward("control", control.stdout);
    forward("control", control.stderr);
    await Promise.all([
      waitFor(
        defaultHealthProbes({ mcpUrl: prepared.endpoints.mcp }).mcp!,
        "MCP"
      ),
      waitFor(async () => {
        const response = await fetch(
          new URL("/api/health", prepared.endpoints.control),
          { signal: AbortSignal.timeout(1_000) }
        );
        return response.ok;
      }, "control plane"),
    ]);
    process.stdout.write(
      `\nSeller       OK          ${prepared.endpoints.seller}\n`
    );
    process.stdout.write(
      `MCP          OK          ${prepared.endpoints.mcp}\n`
    );
    process.stdout.write(
      `Control      OK          ${prepared.endpoints.control}\n\nReady.\n`
    );
    await new Promise<void>((complete, reject) => {
      for (const child of owned) {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (stopping) complete();
          else reject(new Error(`owned child exited unexpectedly (${code})`));
        });
      }
    });
  } finally {
    stop();
  }
}
