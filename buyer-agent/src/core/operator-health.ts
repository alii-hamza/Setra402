import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statfsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { connect as createTlsConnection } from "node:tls";
import { z } from "zod";

export type HealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "NOT_CONFIGURED";
export interface OperatorHealthV1 {
  version: "1";
  status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  resources: {
    rpc: HealthState;
    sellerEvidence: HealthState;
    redis: HealthState;
    docker: HealthState;
    providerCatalog: HealthState;
    providerSecrets: HealthState;
    mcp: HealthState;
    stateRootRead: HealthState;
    stateRootWrite: HealthState;
    diskCapacity: HealthState;
    workerLeases: HealthState;
    reconciliation: HealthState;
    refundScheduler: HealthState;
  };
  diskFreeBytes: number | null;
}
export interface HealthProbes {
  rpc?: () => Promise<boolean>;
  seller?: () => Promise<boolean>;
  redis?: () => Promise<boolean>;
  docker?: () => Promise<boolean>;
  mcp?: () => Promise<boolean>;
  providers?: () => Promise<{
    catalog: HealthState;
    secrets: HealthState;
  }>;
  disk?: () => number;
}
async function safe(
  probe: (() => Promise<boolean>) | undefined
): Promise<HealthState> {
  if (!probe) return "NOT_CONFIGURED";
  try {
    return (await probe()) ? "HEALTHY" : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}
function url(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("invalid health URL");
  return parsed.href;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("health response body unavailable");
  let body = Buffer.alloc(0);
  for await (const chunk of response.body) {
    body = Buffer.concat([body, Buffer.from(chunk)]);
    if (body.length > 131_072) throw new Error("health response too large");
  }
  return JSON.parse(body.toString("utf8"));
}

const providerHealthSchema = z
  .array(
    z
      .object({
        provider_id: z.string().min(1).max(64),
        activation_state: z.enum(["ACTIVE", "INACTIVE", "DEGRADED"]),
        health_state: z.string().min(1).max(64),
        required_secret_status: z.enum(["AVAILABLE", "MISSING"]),
        can_accept_new_execution: z.boolean(),
      })
      .passthrough()
  )
  .max(500);

export function defaultHealthProbes(options: {
  rpcUrl?: string;
  sellerUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisTls?: boolean;
  mcpUrl?: string;
}): HealthProbes {
  const rpcUrl = options.rpcUrl ? url(options.rpcUrl) : undefined;
  const sellerUrl = options.sellerUrl ? url(options.sellerUrl) : undefined;
  const mcpUrl = options.mcpUrl ? url(options.mcpUrl) : undefined;
  const redisHost = options.redisHost;
  const redisPort = options.redisPort ?? 6379;
  const redisTls = options.redisTls ?? false;
  return {
    ...(rpcUrl
      ? {
          rpc: async () => {
            const response = await fetch(rpcUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getHealth",
              }),
              signal: AbortSignal.timeout(3_000),
            });
            return (
              response.ok &&
              ((await boundedJson(response)) as { result?: string }).result ===
                "ok"
            );
          },
        }
      : {}),
    ...(sellerUrl
      ? {
          providers: async () => {
            const response = await fetch(new URL("/providers", sellerUrl), {
              method: "GET",
              signal: AbortSignal.timeout(3_000),
            });
            if (!response.ok)
              return { catalog: "UNAVAILABLE", secrets: "UNAVAILABLE" };
            const providers = providerHealthSchema.parse(
              await boundedJson(response)
            );
            const active = providers.filter(
              (provider) => provider.activation_state !== "INACTIVE"
            );
            return {
              catalog: providers.length ? "HEALTHY" : "DEGRADED",
              secrets: active.every(
                (provider) => provider.required_secret_status === "AVAILABLE"
              )
                ? "HEALTHY"
                : "DEGRADED",
            } as const;
          },
        }
      : {}),
    ...(sellerUrl
      ? {
          seller: async () => {
            const response = await fetch(new URL("/services", sellerUrl), {
              method: "GET",
              signal: AbortSignal.timeout(3_000),
            });
            return response.ok;
          },
        }
      : {}),
    ...(mcpUrl
      ? {
          mcp: async () => {
            const response = await fetch(mcpUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: "health",
                method: "ping",
              }),
              signal: AbortSignal.timeout(3_000),
            });
            if (!response.ok) return false;
            const body = (await boundedJson(response)) as {
              jsonrpc?: unknown;
              id?: unknown;
              result?: unknown;
            };
            return (
              body.jsonrpc === "2.0" &&
              body.id === "health" &&
              !!body.result &&
              typeof body.result === "object"
            );
          },
        }
      : {}),
    ...(redisHost
      ? {
          redis: () =>
            new Promise<boolean>((finish) => {
              const socket = redisTls
                ? createTlsConnection({
                    host: redisHost,
                    port: redisPort,
                    servername: redisHost,
                  })
                : createConnection({ host: redisHost, port: redisPort });
              let settled = false;
              const done = (value: boolean) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                finish(value);
              };
              socket.setTimeout(3_000, () => done(false));
              socket.on("error", () => done(false));
              socket.on(redisTls ? "secureConnect" : "connect", () =>
                socket.write("*1\r\n$4\r\nPING\r\n")
              );
              socket.on("data", (bytes) =>
                done(bytes.toString("utf8").startsWith("+PONG"))
              );
            }),
        }
      : {}),
    docker: async () => {
      try {
        return Boolean(
          execFileSync(
            "docker",
            ["version", "--format", "{{.Server.Version}}"],
            {
              encoding: "utf8",
              timeout: 3_000,
              windowsHide: true,
              stdio: ["ignore", "pipe", "ignore"],
            }
          ).trim()
        );
      } catch {
        return false;
      }
    },
  };
}
/** Health probes are read-only; availability never relaxes verification or sandbox rules. */
export async function inspectOperatorHealth(
  stateDirectory: string,
  probes: HealthProbes = {},
  lowDiskBytes = 1_073_741_824,
  configuration: { refundSchedulerEnabled?: boolean } = {}
): Promise<OperatorHealthV1> {
  const root = resolve(stateDirectory);
  let stateRootRead: HealthState = "UNAVAILABLE",
    stateRootWrite: HealthState = "UNAVAILABLE";
  try {
    accessSync(root, constants.R_OK);
    stateRootRead = "HEALTHY";
  } catch {
    /* unavailable */
  }
  try {
    accessSync(root, constants.W_OK);
    stateRootWrite = "HEALTHY";
  } catch {
    /* unavailable */
  }
  let diskFreeBytes: number | null = null,
    diskCapacity: HealthState = "UNAVAILABLE";
  try {
    diskFreeBytes =
      probes.disk?.() ??
      Number(statfsSync(root).bavail) * Number(statfsSync(root).bsize);
    diskCapacity = diskFreeBytes < lowDiskBytes ? "DEGRADED" : "HEALTHY";
  } catch {
    /* unavailable */
  }
  const workerLeases: HealthState =
    existsSync(join(root, "reconciliation", "claims")) &&
    existsSync(join(root, "reconciliation", "gates"))
      ? "HEALTHY"
      : "UNAVAILABLE";
  const reconciliation: HealthState =
    workerLeases === "HEALTHY" &&
    existsSync(join(root, "reconciliation", "records"))
      ? "HEALTHY"
      : "UNAVAILABLE";
  const [rpc, sellerEvidence, redis, docker, mcp, providerHealth] =
    await Promise.all([
      safe(probes.rpc),
      safe(probes.seller),
      safe(probes.redis),
      safe(probes.docker),
      safe(probes.mcp),
      (async () => {
        if (!probes.providers)
          return {
            catalog: "NOT_CONFIGURED" as const,
            secrets: "NOT_CONFIGURED" as const,
          };
        try {
          return await probes.providers();
        } catch {
          return {
            catalog: "UNAVAILABLE" as const,
            secrets: "UNAVAILABLE" as const,
          };
        }
      })(),
    ]);
  const resources = {
    rpc,
    sellerEvidence,
    redis,
    docker,
    providerCatalog: providerHealth.catalog,
    providerSecrets: providerHealth.secrets,
    mcp,
    stateRootRead,
    stateRootWrite,
    diskCapacity,
    workerLeases,
    reconciliation,
    refundScheduler: configuration.refundSchedulerEnabled
      ? ("HEALTHY" as const)
      : ("NOT_CONFIGURED" as const),
  };
  const core = [
    resources.rpc,
    resources.sellerEvidence,
    resources.redis,
    resources.docker,
    resources.providerCatalog,
    resources.mcp,
    resources.stateRootRead,
    resources.stateRootWrite,
  ];
  const status = core.includes("UNAVAILABLE")
    ? "UNAVAILABLE"
    : Object.entries(resources).some(
        ([name, state]) =>
          state === "DEGRADED" ||
          state === "UNAVAILABLE" ||
          (state === "NOT_CONFIGURED" && name !== "refundScheduler")
      )
    ? "DEGRADED"
    : "HEALTHY";
  return {
    version: "1",
    status,
    resources,
    diskFreeBytes,
  };
}
