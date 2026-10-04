import {
  readFileSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseVerificationPolicy } from "../verification/policy.js";
import { hashCanonical } from "../manifest/hash.js";
import { defaultRunners } from "../verification/level2/default-runners.js";
import {
  ensureDurableDirectory,
  syncDirectory,
  type JournalFault,
} from "../core/journal.js";
import {
  parseProviderDefinitions,
  type ProviderDefinitionV1,
} from "./providers.js";

export const PROVIDER_PROFILES = Object.freeze(
  parseProviderDefinitions(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../seller-server/config/provider-profiles.json",
          import.meta.url
        ),
        "utf8"
      )
    )
  ).map((p) => Object.freeze(p))
);
const definition = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z
      .string()
      .min(1)
      .max(120)
      .refine((v) => v.trim().length > 0),
    description: z.string().min(1).max(2000),
    capability: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
    exposure: z.enum(["rest", "mcp", "both"]),
    price_base_units: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .refine((v) => BigInt(v) <= 18446744073709551615n),
    timeout_seconds: z.number().int().min(5).max(3600),
    privacy_support: z.boolean(),
    provider_connector_ref: z.string().min(1).max(64),
    verification_policy: z.unknown(),
  })
  .strict();
export function normalizeService(
  value: unknown,
  providerProfiles: readonly ProviderDefinitionV1[] = PROVIDER_PROFILES
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid service definition");
  // Ignore the display-only hash/type supplied by a browser or disk. The
  // server recomputes them from shared policy and allowlisted profile bytes.
  const {
    policy_hash: _hash,
    provider_type: _type,
    ...input
  } = value as Record<string, unknown>;
  const service = definition.parse(input),
    policy = parseVerificationPolicy(service.verification_policy);
  const profile = providerProfiles.find(
    (p) => p.provider_id === service.provider_connector_ref
  );
  if (!profile) throw new Error("unknown execution profile");
  if (!profile.active) throw new Error("inactive execution profile");
  if (!profile.capabilities.includes(service.capability))
    throw new Error("provider does not declare service capability");
  if (service.privacy_support && !profile.privacy_support)
    throw new Error("incompatible privacy configuration");
  const runners = defaultRunners();
  for (const check of policy.checks) {
    if (check.type === "test_suite") {
      const runner = runners.list().find((p) => p.id === check.runner_profile);
      if (!runner || runner.test_bundle_hash !== check.test_bundle_hash)
        throw new Error("unknown runner or trusted bundle hash mismatch");
      if (check.timeout_seconds + 2 >= service.timeout_seconds)
        throw new Error(
          "service deadline must exceed runner timeout and settlement safety margin"
        );
    }
  }
  return {
    ...service,
    verification_policy: policy,
    policy_hash: hashCanonical(policy),
    provider_type: profile.connector_type,
  };
}
export type ServiceDefinition = ReturnType<typeof normalizeService>;
export class ServiceRegistry {
  constructor(
    private readonly baseline: string | URL,
    readonly overlay: string,
    readonly writeEnabled = false,
    private readonly fault?: JournalFault,
    private readonly providerProfiles: readonly ProviderDefinitionV1[] = PROVIDER_PROFILES
  ) {
    if (fault && process.env.NODE_ENV !== "test")
      throw new Error("registry failpoints are test-only");
  }
  private baselineServices() {
    const values = JSON.parse(readFileSync(this.baseline, "utf8")) as Record<
      string,
      unknown
    >[];
    return values.map((v) =>
      normalizeService(
        {
          description: String(v.name),
          exposure: "both",
          privacy_support: true,
          provider_connector_ref:
            v.id === "lead-scraper-demo" ? "fixture-lead" : "fixture-echo",
          ...v,
        },
        this.providerProfiles
      )
    );
  }
  private local(): ServiceDefinition[] {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.overlay);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    try {
      if (bytes.length > 1_048_576) throw new Error("overlay too large");
      const raw = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(raw) || raw.length > 500)
        throw new Error("invalid overlay");
      const services = raw.map((value) =>
          normalizeService(value, this.providerProfiles)
        ),
        ids = new Set(this.baselineServices().map((v) => v.id));
      for (const service of services) {
        if (ids.has(service.id)) throw new Error("duplicate ID");
        ids.add(service.id);
      }
      return services;
    } catch {
      throw new Error("malformed overlay; writes blocked until repaired");
    }
  }
  list() {
    const baseline = this.baselineServices();
    try {
      return [...baseline, ...this.local()];
    } catch {
      return baseline;
    }
  }
  async register(value: unknown): Promise<ServiceDefinition> {
    if (!this.writeEnabled) throw new Error("onboarding writes disabled");
    const service = normalizeService(value, this.providerProfiles);
    ensureDurableDirectory(dirname(this.overlay));
    const lock = `${this.overlay}.lock`;
    let descriptor: number | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        descriptor = openSync(lock, "wx", 0o600);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    if (descriptor === undefined)
      throw new Error(
        "registry busy or interrupted write; lock requires reconciliation"
      );
    let temporary: string | undefined;
    try {
      const local = this.local();
      if (
        [...this.baselineServices(), ...local].some((v) => v.id === service.id)
      )
        throw new Error("duplicate service_id");
      const bytes = Buffer.from(
        JSON.stringify([...local, service], null, 2) + "\n"
      );
      if (bytes.length > 1_048_576 || local.length >= 500)
        throw new Error("registry capacity reached");
      temporary = `${this.overlay}.${randomUUID()}.tmp`;
      this.fault?.("before_temp_write", this.overlay);
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        this.fault?.("after_temp_write", this.overlay);
        this.fault?.("before_fsync", this.overlay);
        fsyncSync(fd);
        this.fault?.("after_fsync", this.overlay);
      } finally {
        closeSync(fd);
      }
      this.fault?.("before_rename", this.overlay);
      renameSync(temporary, this.overlay);
      temporary = undefined;
      syncDirectory(dirname(this.overlay));
      this.fault?.("after_rename", this.overlay);
      const saved = this.local().find((v) => v.id === service.id);
      if (!saved || hashCanonical(saved) !== hashCanonical(service))
        throw new Error("registry read-back failed");
      return saved;
    } finally {
      if (temporary)
        try {
          unlinkSync(temporary);
        } catch {}
      closeSync(descriptor);
      unlinkSync(lock);
    }
  }
}
