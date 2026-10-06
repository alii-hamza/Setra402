import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { defaultHealthProbes } from "../core/operator-health.js";
import {
  normalizedHost,
  type PreparedDevelopmentEnvironment,
} from "./environment.js";
import {
  inspectPortOwner,
  ownerAction,
  type PortOwner,
} from "./process-ownership.js";

type CheckState = "OK" | "START_REQUIRED" | "BLOCKED" | "UNAVAILABLE";

export interface DevelopmentCheck {
  name: string;
  state: CheckState;
  detail: string;
}

export interface DevelopmentProbes {
  fileExists(path: string): boolean;
  rpc(): Promise<boolean>;
  redis(): Promise<boolean>;
  docker(): Promise<boolean>;
  seller(): Promise<boolean>;
  portAvailable(port: number, host: string): Promise<boolean>;
  inspectPort?(port: number): Promise<PortOwner> | PortOwner;
}

function portAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((finish) => {
    const server = createServer();
    server.unref();
    server.once("error", () => finish(false));
    server.listen({ port, host, exclusive: true }, () =>
      server.close(() => finish(true))
    );
  });
}

function createDefaultProbes(
  prepared: PreparedDevelopmentEnvironment
): DevelopmentProbes {
  const redisUrl = new URL(prepared.childEnvironment.REDIS_URL!);
  const health = defaultHealthProbes({
    rpcUrl: prepared.endpoints.solana,
    sellerUrl: prepared.endpoints.seller,
    redisHost: redisUrl.hostname,
    redisPort: Number(redisUrl.port || 6379),
  });
  return {
    fileExists: existsSync,
    rpc: health.rpc!,
    redis: health.redis!,
    docker: health.docker!,
    seller: health.seller!,
    portAvailable,
    inspectPort: (port) =>
      inspectPortOwner(
        port,
        prepared.repositoryRoot,
        prepared.runtime.stateDirectory
      ),
  };
}

async function blockedDetail(
  port: number,
  probes: DevelopmentProbes
): Promise<string> {
  const owner = await probes.inspectPort?.(port);
  if (!owner) return `port ${port} is already in use`;
  return `:${port} — ${owner.detail}. ${ownerAction(owner)}`;
}

export async function safeProbe(
  value: () => Promise<boolean>
): Promise<boolean> {
  try {
    return await value();
  } catch {
    return false;
  }
}

export async function runDevelopmentPreflight(
  prepared: PreparedDevelopmentEnvironment,
  probes: DevelopmentProbes = createDefaultProbes(prepared)
): Promise<{ ready: boolean; checks: DevelopmentCheck[] }> {
  const checks: DevelopmentCheck[] = [];
  const missing = prepared.requiredFiles.filter(
    (path) => !probes.fileExists(path)
  );
  checks.push({
    name: "Fixtures",
    state: missing.length ? "UNAVAILABLE" : "OK",
    detail: missing.length ? `missing ${missing.join(", ")}` : "available",
  });
  const [rpc, redis, docker, seller] = await Promise.all([
    safeProbe(probes.rpc),
    safeProbe(probes.redis),
    safeProbe(probes.docker),
    safeProbe(probes.seller),
  ]);
  checks.push({
    name: "Solana",
    state: rpc ? "OK" : "START_REQUIRED",
    detail: rpc
      ? prepared.endpoints.solana
      : `${prepared.endpoints.solana} (will retry)`,
  });
  checks.push({
    name: "Redis",
    state: redis ? "OK" : "UNAVAILABLE",
    detail: prepared.endpoints.redis,
  });
  checks.push({
    name: "Docker",
    state: docker ? "OK" : "UNAVAILABLE",
    detail: docker ? "daemon reachable" : "daemon unavailable",
  });

  const sellerUrl = new URL(prepared.endpoints.seller);
  const sellerPort = Number(sellerUrl.port || 80);
  if (seller) {
    checks.push({
      name: "Seller",
      state: "OK",
      detail: prepared.endpoints.seller,
    });
  } else {
    const available = await probes.portAvailable(
      sellerPort,
      normalizedHost(sellerUrl.hostname)
    );
    checks.push({
      name: "Seller",
      state: available ? "START_REQUIRED" : "BLOCKED",
      detail: available
        ? prepared.endpoints.seller
        : await blockedDetail(sellerPort, probes),
    });
  }
  for (const [name, port] of [
    ["MCP", prepared.control.mcpPort],
    ["Control", prepared.control.webPort],
  ] as const) {
    const available = await probes.portAvailable(port, "127.0.0.1");
    checks.push({
      name,
      state: available ? "START_REQUIRED" : "BLOCKED",
      detail: available
        ? name === "MCP"
          ? prepared.endpoints.mcp
          : prepared.endpoints.control
        : await blockedDetail(port, probes),
    });
  }
  return {
    ready: checks.every(
      (check) => check.state !== "UNAVAILABLE" && check.state !== "BLOCKED"
    ),
    checks,
  };
}
