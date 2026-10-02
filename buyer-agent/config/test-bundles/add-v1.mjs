// Trusted tests supervise a separate container-confined worker. The profile
// exposes only a synchronous numeric add export, without process/console/imports
// or host object arguments. VM restrictions reduce the worker's API surface;
// Docker remains the security isolation boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const [a, b, expected] of [
  [2, 3, 5],
  [-2, 1, -1],
  [0, 0, 0],
  [8, 13, 21],
]) {
  test(`add(${a},${b})`, () => {
    const run = spawnSync(
      process.execPath,
      [
        "--disable-sigusr1",
        "--experimental-vm-modules",
        "--input-type=module",
        "-e",
        `import fs from 'node:fs'; import vm from 'node:vm';
        const input = JSON.parse(process.argv[1]);
        const context = vm.createContext(Object.create(null), {codeGeneration: {strings: false, wasm: false}});
        const module = new vm.SourceTextModule(fs.readFileSync('/tmp/artifact.mjs','utf8'), {context});
        await module.link(() => {throw new Error('artifact imports unavailable in this profile');});
        await module.evaluate({timeout: 1000});
        if (typeof module.namespace.add !== 'function') throw new Error('missing add export');
        const output = module.namespace.add(...input);
        if (!Number.isSafeInteger(output)) throw new Error('add must return a synchronous safe integer');
        process.stdout.write(JSON.stringify(output));`,
        JSON.stringify([a, b]),
      ],
      { env: {}, cwd: "/work", timeout: 2000, maxBuffer: 16384 }
    );
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0);
    assert.equal(JSON.parse(run.stdout.toString()), expected);
  });
}
