import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statfsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

export type HealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "NOT_CONFIGURED";
export interface OperatorHealthV1 {
  version: "1";
  resources: {
    rpc: HealthState;
    sellerEvidence: HealthState;
    redis: HealthState;
    docker: HealthState;
    stateRootRead: HealthState;
    stateRootWrite: HealthState;
    diskCapacity: HealthState;
    workerLeases: HealthState;
  };
  diskFreeBytes: number | null;
}
export interface HealthProbes {
  rpc?: () => Promise<boolean>;
  seller?: () => Promise<boolean>;
  redis?: () => Promise<boolean>;
  docker?: () => Promise<boolean>;
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
export function defaultHealthProbes(options: {
  rpcUrl?: string;
  sellerUrl?: string;
  redisHost?: string;
  redisPort?: number;
}): HealthProbes {
  const rpcUrl = options.rpcUrl ? url(options.rpcUrl) : undefined;
  const sellerUrl = options.sellerUrl ? url(options.sellerUrl) : undefined;
  const redisHost = options.redisHost;
  const redisPort = options.redisPort ?? 6379;
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
              ((await response.json()) as { result?: string }).result === "ok"
            );
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
    ...(redisHost
      ? {
          redis: () =>
            new Promise<boolean>((finish) => {
              const socket = createConnection({
                host: redisHost,
                port: redisPort,
              });
              let settled = false;
              const done = (value: boolean) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                finish(value);
              };
              socket.setTimeout(3_000, () => done(false));
              socket.on("error", () => done(false));
              socket.on("connect", () => socket.write("*1\r\n$4\r\nPING\r\n"));
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
  lowDiskBytes = 1_073_741_824
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
  const [rpc, sellerEvidence, redis, docker] = await Promise.all([
    safe(probes.rpc),
    safe(probes.seller),
    safe(probes.redis),
    safe(probes.docker),
  ]);
  return {
    version: "1",
    resources: {
      rpc,
      sellerEvidence,
      redis,
      docker,
      stateRootRead,
      stateRootWrite,
      diskCapacity,
      workerLeases,
    },
    diskFreeBytes,
  };
}
