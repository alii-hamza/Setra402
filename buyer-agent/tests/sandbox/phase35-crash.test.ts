import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DockerSandbox,
  type DockerCommand,
} from "../../src/verification/level2/docker-sandbox.js";
import { SandboxLeases } from "../../src/verification/level2/sandbox-leases.js";
import { defaultRunners } from "../../src/verification/level2/default-runners.js";

const cli: DockerCommand =
  process.env.ROLE_C_DOCKER_WSL === "1"
    ? {
        executable: "wsl.exe",
        prefix: ["-u", "root", "--", "docker"],
        mapInputPath: (path) =>
          `/mnt/${path[0]!.toLowerCase()}${path
            .slice(2)
            .replaceAll("\\", "/")}`,
      }
    : { executable: "docker" };
const url = (file: string) =>
  pathToFileURL(resolve("dist/verification/level2", file)).href;
describe("Phase 3.5 verifier termination (ACTUAL Docker/process)", () => {
  it("dead verifier retains a lease, cannot produce PASS, and restart cleans its container", async () => {
    const root = mkdtempSync(join(tmpdir(), "setra35-lease-"));
    const script = `import {DockerSandbox} from ${JSON.stringify(
      url("docker-sandbox.js")
    )}; import {SandboxLeases} from ${JSON.stringify(
      url("sandbox-leases.js")
    )}; import {defaultRunners} from ${JSON.stringify(
      url("default-runners.js")
    )}; const cli=${JSON.stringify(cli)}; ${
      process.env.ROLE_C_DOCKER_WSL === "1"
        ? 'cli.mapInputPath=p=>"/mnt/"+p[0].toLowerCase()+p.slice(2).split(String.fromCharCode(92)).join("/");'
        : ""
    } await new DockerSandbox(cli,65536,new SandboxLeases(${JSON.stringify(
      root
    )})).execute({...defaultRunners().get("node22-test-v1"),command:["/bin/sleep","60"]},Buffer.from("ignored"),30);console.log("UNEXPECTED_PASS");`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const exited = new Promise((r) => child.once("exit", r));
    let container = "";
    try {
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        if (child.exitCode !== null) break;
        const file = readdirSync(root).find((name) => name.endsWith(".lease"));
        if (file) {
          container = JSON.parse(readFileSync(join(root, file), "utf8")).value
            .container;
          try {
            if (
              execFileSync(
                cli.executable,
                [
                  ...(cli.prefix ?? []),
                  "inspect",
                  "--format",
                  "{{.State.Running}}",
                  container,
                ],
                { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
              )
                .toString()
                .trim() === "true"
            )
              break;
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(container, output).not.toBe("");
      expect(child.exitCode, output).toBeNull();
      child.kill("SIGKILL");
      await exited;
      expect(output).not.toContain("UNEXPECTED_PASS");
      expect(
        readdirSync(root).filter((f) => f.endsWith(".lease"))
      ).toHaveLength(1);
      const run = await new DockerSandbox(
        cli,
        65536,
        new SandboxLeases(root)
      ).execute(
        defaultRunners().get("node22-test-v1")!,
        Buffer.from("export const add=(a,b)=>a+b;"),
        10
      );
      expect(run.exitCode).toBe(0);
      expect(readdirSync(root).filter((f) => f.endsWith(".lease"))).toEqual([]);
      expect(() =>
        execFileSync(
          cli.executable,
          [...(cli.prefix ?? []), "inspect", container],
          { windowsHide: true, stdio: "ignore" }
        )
      ).toThrow();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      if (container) {
        try {
          execFileSync(
            cli.executable,
            [...(cli.prefix ?? []), "rm", "--force", "--volumes", container],
            { windowsHide: true, stdio: "ignore" }
          );
        } catch {}
      }
    }
  }, 60_000);
});
