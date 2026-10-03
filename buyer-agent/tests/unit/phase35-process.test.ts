import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DurableJournal } from "../../src/core/journal.js";
import { ServiceRegistry } from "../../src/registry/services.js";
import { FileChallengeStore } from "../../src/verification/level2/challenge-store.js";

const moduleUrl = (file: string) => pathToFileURL(resolve("dist", file)).href;
const directory = () => mkdtempSync(join(tmpdir(), "setra35-process-"));
function crash(code: string) {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      env: { ...process.env, NODE_ENV: "test" },
      windowsHide: true,
      timeout: 10_000,
    }
  );
  expect(child.status, child.stderr?.toString()).toBe(73);
}
describe("Phase 3.5 real child process crashes (ACTUAL process/filesystem)", () => {
  it.each(["after_temp_write", "after_fsync", "after_publish"])(
    "journal restart after exit at %s",
    (point) => {
      const path = join(directory(), "operation.intent");
      crash(
        `import {DurableJournal} from ${JSON.stringify(
          moduleUrl("core/journal.js")
        )}; new DurableJournal(p=>{if(p===${JSON.stringify(
          point
        )})process.exit(73)}).publish(${JSON.stringify(
          path
        )},{state:"UNKNOWN_EXTERNAL_EFFECT"});`
      );
      const saved = new DurableJournal().read(path);
      expect(saved).toEqual(
        point === "after_publish" ? { state: "UNKNOWN_EXTERNAL_EFFECT" } : null
      );
      if (saved)
        expect(new DurableJournal().publish(path, { state: "retry" })).toBe(
          false
        );
    }
  );
  it("a persisted sampling challenge survives verifier process exit without regeneration", async () => {
    const dir = directory(),
      context = "a".repeat(64);
    crash(
      `import {FileChallengeStore} from ${JSON.stringify(
        moduleUrl("verification/level2/challenge-store.js")
      )}; await new FileChallengeStore(${JSON.stringify(
        dir
      )}).getOrCreate(${JSON.stringify(context)});process.exit(73);`
    );
    const original = readFileSync(join(dir, `${context}.seed`), "utf8");
    expect(await new FileChallengeStore(dir).getOrCreate(context)).toBe(
      original
    );
    expect(readdirSync(dir).filter((f) => f.endsWith(".seed"))).toHaveLength(1);
  });
  const baseline = resolve("../seller-server/config/services.json");
  const service = {
    id: "phase35-crash",
    name: "Crash test",
    description: "Deterministic fixture",
    capability: "setra402.task.echo",
    exposure: "both",
    price_base_units: "1",
    timeout_seconds: 30,
    privacy_support: false,
    provider_connector_ref: "fixture-echo",
    verification_policy: {
      version: "1",
      level: 1,
      checks: [{ type: "json_schema", schema_ref: "generic-object-v1" }],
    },
  };
  it.each(["after_temp_write", "after_fsync", "before_rename", "after_rename"])(
    "overlay restart after exit at %s remains all-old or all-new",
    (point) => {
      const overlay = join(directory(), "services.local.json");
      const before = readFileSync(baseline);
      crash(
        `import {ServiceRegistry} from ${JSON.stringify(
          moduleUrl("registry/services.js")
        )};await new ServiceRegistry(${JSON.stringify(
          baseline
        )},${JSON.stringify(overlay)},true,p=>{if(p===${JSON.stringify(
          point
        )})process.exit(73)}).register(${JSON.stringify(service)});`
      );
      const fresh = new ServiceRegistry(baseline, overlay, true);
      expect(fresh.list().some((s) => s.id === service.id)).toBe(
        point === "after_rename"
      );
      expect(readFileSync(baseline)).toEqual(before);
    }
  );
  it("registry readers during registration observe complete validated snapshots", async () => {
    const overlay = join(directory(), "services.local.json"),
      reader = new ServiceRegistry(baseline, overlay, true);
    const writer = new ServiceRegistry(baseline, overlay, true, () => {
      const values = reader.list();
      expect(values.length === 2 || values.length === 3).toBe(true);
      expect(
        values.every((value) => /^[0-9a-f]{64}$/.test(value.policy_hash))
      ).toBe(true);
    });
    await writer.register(service);
    expect(
      reader.list().find((value) => value.id === service.id)
    ).toBeDefined();
  });
});
