import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultHealthProbes } from "../core/operator-health.js";
import type { PreparedDevelopmentEnvironment } from "./environment.js";
import { safeProbe, type DevelopmentCheck } from "./preflight.js";
import { createOwnershipRecord } from "./process-ownership.js";

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
  isStopping: () => boolean,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isStopping())
      throw new Error("Setra development environment is shutting down");
    if (await safeProbe(probeValue)) return;
    await new Promise((complete) => setTimeout(complete, 250));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

function isRunning(child: ChildProcess): boolean {
  return (
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isRunning(child)) return Promise.resolve(true);
  return new Promise((complete) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("error", finish);
      complete(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", finish);
      child.off("error", finish);
      complete(!isRunning(child));
    }, timeoutMs);
    child.once("exit", finish);
    child.once("error", finish);
  });
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
  const spawnResults = new WeakMap<ChildProcess, Promise<boolean>>();
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  const ownership = createOwnershipRecord(
    prepared.runtime.stateDirectory,
    prepared.repositoryRoot
  );
  const stop = (): Promise<void> => {
    if (shutdown) return shutdown;
    stopping = true;
    shutdown = (async () => {
      await Promise.all(
        owned.map(
          (child) =>
            spawnResults.get(child) ?? Promise.resolve(child.pid !== undefined)
        )
      );
      for (const child of owned) {
        if (isRunning(child)) child.kill("SIGTERM");
      }
      await Promise.all(owned.map((child) => waitForExit(child, 5_000)));
      for (const child of owned) {
        if (isRunning(child)) child.kill("SIGKILL");
      }
      await Promise.all(owned.map((child) => waitForExit(child, 2_000)));
      if (owned.every((child) => !isRunning(child))) ownership.remove();
      else
        process.stderr.write(
          "Setra shutdown left a child running; launcher ownership record retained for safe diagnosis.\n"
        );
    })();
    return shutdown;
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    void stop().catch((error: unknown) => {
      process.stderr.write(
        `Setra shutdown after ${signal} failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    });
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  const onSighup = () => handleSignal("SIGHUP");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("SIGHUP", onSighup);
  const rememberChild = async (
    role: string,
    command: string,
    child: ChildProcess
  ) => {
    let spawnError: Error | undefined;
    const spawnResult = new Promise<boolean>((complete) => {
      child.once("spawn", () => complete(true));
      child.once("exit", () => complete(false));
      child.once("error", (error) => {
        spawnError = error;
        complete(false);
      });
    });
    spawnResults.set(child, spawnResult);
    if (!(await spawnResult))
      throw spawnError ?? new Error(`${role} exited before it started`);
    if (child.pid === undefined)
      throw new Error(`${role} started without a process ID`);
    ownership.recordChild({
      role,
      pid: child.pid,
      command,
      startedAt: new Date().toISOString(),
    });
  };
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
      if (stopping)
        throw new Error("Setra development environment is shutting down");
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
      await rememberChild("Seller", sellerExecutable, seller);
      forward("seller", seller.stdout);
      forward("seller", seller.stderr);
      await waitFor(
        defaultHealthProbes({ sellerUrl: prepared.endpoints.seller }).seller!,
        "seller",
        () => stopping
      );
    }
    if (stopping)
      throw new Error("Setra development environment is shutting down");
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
    await rememberChild(
      "Control",
      join(prepared.buyerDirectory, "dist", "web", "start.js"),
      control
    );
    forward("control", control.stdout);
    forward("control", control.stderr);
    await Promise.all([
      waitFor(
        defaultHealthProbes({ mcpUrl: prepared.endpoints.mcp }).mcp!,
        "MCP",
        () => stopping
      ),
      waitFor(
        async () => {
          const response = await fetch(
            new URL("/api/health", prepared.endpoints.control),
            { signal: AbortSignal.timeout(1_000) }
          );
          return response.ok;
        },
        "control plane",
        () => stopping
      ),
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
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    await stop();
  }
}
