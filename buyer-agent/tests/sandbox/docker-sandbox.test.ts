import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DockerSandbox,
  type DockerCommand,
} from "../../src/verification/level2/docker-sandbox.js";
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
const profile = defaultRunners().get("node22-test-v1")!;
const sandbox = new DockerSandbox(cli);
function assertClean(instance = sandbox) {
  const containers = execFileSync(
    cli.executable,
    [
      ...(cli.prefix ?? []),
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `name=${instance.containerPrefix}`,
    ],
    { windowsHide: true }
  ).toString();
  expect(containers.trim()).toBe("");
  expect(
    readdirSync(tmpdir()).filter((name) =>
      name.startsWith(instance.containerPrefix)
    )
  ).toEqual([]);
}
describe("real isolated Docker artifact execution", () => {
  it("trusted tests pass for a correct artifact", async () => {
    const run = await sandbox.execute(
      profile,
      Buffer.from("export const add = (a,b) => a+b;"),
      10
    );
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("# pass 4");
    assertClean();
  }, 30_000);
  it.each([
    "export const add = (a,b) => a-b;",
    "export const add = (a,b) => a === 2 ? 0 : a+b;",
    "malformed {{{",
    "process.exit(0)",
    "throw new Error('crash')",
    "const args=JSON.parse(process.argv[1]); console.log(args[0]+args[1]); process.exit(0); export const add=()=>0;",
    "import process from 'node:process'; process.exit(0); export const add=()=>0;",
  ])(
    "fails incorrect or malicious artifact %s",
    async (artifact) => {
      expect(
        (await sandbox.execute(profile, Buffer.from(artifact), 10)).exitCode
      ).not.toBe(0);
      assertClean();
    },
    30_000
  );
  it("kills and removes a timed-out container", async () => {
    await expect(
      sandbox.execute(
        { ...profile, command: ["node", "/tmp/artifact.mjs"] },
        Buffer.from("while(true) {}"),
        1
      )
    ).rejects.toThrow("timeout");
    assertClean();
  }, 30_000);
  it("bounds memory and cleans up after OOM", async () => {
    const code =
      "const buffers=[]; while(true) buffers.push(Buffer.alloc(8*1024*1024, 1));";
    const run = await sandbox.execute(
      { ...profile, command: ["node", "/tmp/artifact.mjs"] },
      Buffer.from(code),
      10
    );
    expect(run.exitCode).not.toBe(0);
    assertClean();
  }, 30_000);
  it("bounds PID creation", async () => {
    const code =
      "import {spawn} from 'node:child_process'; for(let i=0;i<100;i++) {spawn('/bin/sleep',['10'],{stdio:'ignore'}).on('error',e=>{if(e.code==='EAGAIN') process.exit(23);});} setTimeout(()=>process.exit(1),2000);";
    const run = await sandbox.execute(
      { ...profile, command: ["node", "/tmp/artifact.mjs"] },
      Buffer.from(code),
      10
    );
    expect(run.exitCode).toBe(23);
    assertClean();
  }, 30_000);
  it("denies network, root writes, host secrets and Docker socket; executes as non-root", async () => {
    const code =
      "import assert from 'node:assert/strict'; import fs from 'node:fs'; " +
      "assert.equal(process.getuid(),65534); assert.equal(process.env.ROLE_C_VERIFIER_KEYPAIR_PATH,undefined); " +
      "assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'64'); " +
      "assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'134217728'); " +
      "assert.equal(fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),'50000 100000'); " +
      "assert.equal(fs.existsSync('/var/run/docker.sock'),false); assert.equal(fs.existsSync('/root/.ssh'),false); " +
      "assert.equal(fs.existsSync('/mnt/c'),false); assert.equal(fs.existsSync('/proc/1/root/root/.aws'),false); " +
      "assert.throws(()=>fs.writeFileSync('/tmp/root-write','x')); fs.writeFileSync('/work/allowed','ok'); " +
      "await assert.rejects(fetch('https://1.1.1.1',{signal:AbortSignal.timeout(500)})); console.log('guards verified');";
    const run = await sandbox.execute(
      { ...profile, command: ["node", "/tmp/artifact.mjs"] },
      Buffer.from(code),
      10
    );
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("guards verified");
    assertClean();
  }, 30_000);
  it("bounds output and cleans up", async () => {
    const limited = new DockerSandbox(cli, 4096);
    await expect(
      limited.execute(
        { ...profile, command: ["node", "/tmp/artifact.mjs"] },
        Buffer.from("console.log('x'.repeat(100000));"),
        10
      )
    ).rejects.toThrow("output limit");
    assertClean(limited);
  }, 30_000);
  it("uses exactly the checked-in trusted test bytes", () => {
    expect(Buffer.from(profile.testBundle)).toEqual(
      readFileSync(
        new URL("../../config/test-bundles/add-v1.mjs", import.meta.url)
      )
    );
  });
});
