import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, chmod, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerProfile } from "./runner-registry.js";

export interface SandboxResult {
  exitCode: number;
  output: string;
  durationMs: number;
}
export interface Sandbox {
  execute(
    profile: RunnerProfile,
    artifact: Uint8Array,
    timeoutSeconds: number
  ): Promise<SandboxResult>;
}
export interface DockerCommand {
  executable: string;
  prefix?: readonly string[];
  mapInputPath?: (path: string) => string;
}

// The only host mount contains two fixed-name, read-only verification inputs.
export class DockerSandbox implements Sandbox {
  readonly containerPrefix = `setra402-verify-${randomUUID()}`;
  constructor(
    private readonly cli: DockerCommand = { executable: "docker" },
    private readonly maxOutputBytes = 65_536
  ) {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
      throw new Error("invalid sandbox output limit");
  }
  private run(
    args: string[],
    timeoutMs: number
  ): Promise<{ code: number; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.cli.executable,
        [...(this.cli.prefix ?? []), ...args],
        {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH ?? "",
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
          },
        }
      );
      let bytes = 0;
      const chunks: Buffer[] = [];
      let failure: Error | null = null;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(
        () => stop(new Error("sandbox wall-clock timeout")),
        timeoutMs
      );
      const collect = (data: Buffer) => {
        bytes += data.length;
        if (bytes > this.maxOutputBytes)
          stop(new Error("sandbox output limit exceeded"));
        else chunks.push(data);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.stdin.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else
          resolve({
            code: code ?? -1,
            output: Buffer.concat(chunks).toString("utf8"),
          });
      });
      child.stdin.end();
    });
  }
  async execute(
    profile: RunnerProfile,
    artifact: Uint8Array,
    timeoutSeconds: number
  ): Promise<SandboxResult> {
    if (
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 300
    )
      throw new Error("invalid sandbox timeout");
    const started = Date.now();
    const name = `${this.containerPrefix}-${randomUUID()}`;
    const directory = await mkdtemp(
      join(tmpdir(), `${this.containerPrefix}-input-`)
    );
    const artifactPath = join(directory, "artifact.mjs");
    const bundlePath = join(directory, "tests.mjs");
    let created = false;
    try {
      await chmod(directory, 0o755);
      await writeFile(artifactPath, artifact, { mode: 0o444, flag: "wx" });
      await writeFile(bundlePath, profile.testBundle, {
        mode: 0o444,
        flag: "wx",
      });
      const inputPath = this.cli.mapInputPath?.(directory) ?? directory;
      if (inputPath.includes(","))
        throw new Error("sandbox input mount path is invalid");
      const create = await this.run(
        [
          "create",
          "--name",
          name,
          "--pull",
          "never",
          "--network",
          "none",
          "--read-only",
          "--user",
          "65534:65534",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--memory",
          "128m",
          "--memory-swap",
          "128m",
          "--cpus",
          "0.5",
          "--pids-limit",
          "64",
          "--ulimit",
          "nofile=128:128",
          "--ulimit",
          "core=0:0",
          "--ipc",
          "none",
          "--log-driver",
          "none",
          "--tmpfs",
          "/work:rw,noexec,nosuid,nodev,size=16777216,uid=65534,gid=65534,mode=700",
          "--workdir",
          "/work",
          "--env",
          "TMPDIR=/work",
          "--env",
          "NODE_OPTIONS=--max-old-space-size=64",
          "--mount",
          `type=bind,src=${inputPath},dst=/tmp,readonly`,
          "--entrypoint",
          profile.command[0]!,
          profile.image,
          ...profile.command.slice(1),
        ],
        10_000
      );
      if (create.code !== 0)
        throw new Error("safe sandbox unavailable: container creation failed");
      created = true;
      const run = await this.run(
        ["start", "--attach", name],
        timeoutSeconds * 1000
      );
      return {
        exitCode: run.code,
        output: run.output,
        durationMs: Date.now() - started,
      };
    } finally {
      // Even a killed CLI can leave a live container. Removing the named
      // container forcibly kills every namespaced child before returning.
      try {
        const cleanup = await this.run(
          ["rm", "--force", "--volumes", name],
          10_000
        );
        if (created && cleanup.code !== 0)
          throw new Error("sandbox cleanup failed");
      } finally {
        // Fixed files in our exclusive directory; no recursive removal and no
        // seller-derived filesystem target. Container mount is read-only.
        for (const path of [artifactPath, bundlePath]) {
          await chmod(path, 0o600).catch(() => {});
          await unlink(path).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        await rmdir(directory);
      }
    }
  }
}
