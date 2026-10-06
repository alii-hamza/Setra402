import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { defaultHealthProbes } from "../core/operator-health.js";
import {
  normalizedHost,
  type PreparedDevelopmentEnvironment,
} from "./environment.js";

type CheckState = "OK" | "START_REQUIRED" | "UNAVAILABLE";

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
  };
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
    state: rpc ? "OK" : "UNAVAILABLE",
    detail: prepared.endpoints.solana,
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
  } else if (
    await probes.portAvailable(sellerPort, normalizedHost(sellerUrl.hostname))
  ) {
    checks.push({
      name: "Seller",
      state: "START_REQUIRED",
      detail: prepared.endpoints.seller,
    });
  } else {
    checks.push({
      name: "Seller",
      state: "UNAVAILABLE",
      detail: `port ${sellerPort} is already in use`,
    });
  }
  for (const [name, port] of [
    ["MCP", prepared.control.mcpPort],
    ["Control", prepared.control.webPort],
  ] as const) {
    const available = await probes.portAvailable(port, "127.0.0.1");
    checks.push({
      name,
      state: available ? "START_REQUIRED" : "UNAVAILABLE",
      detail: available
        ? name === "MCP"
          ? prepared.endpoints.mcp
          : prepared.endpoints.control
        : `port ${port} is already in use`,
    });
  }
  return {
    ready: checks.every((check) => check.state !== "UNAVAILABLE"),
    checks,
  };
}
