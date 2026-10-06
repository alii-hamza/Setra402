import { resolve } from "node:path";
import type { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { publicKeyStringSchema } from "./config.js";

const portSchema = (name: string, fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be a decimal port`)
    .default(String(fallback))
    .transform(Number)
    .refine(
      (value) => Number.isInteger(value) && value >= 1 && value <= 65_535,
      `${name} must be between 1 and 65535`
    );

const booleanFlag = (name: string, fallback = "false") =>
  z
    .enum(["true", "false"], {
      errorMap: () => ({ message: `${name} must be true or false` }),
    })
    .default(fallback as "true" | "false")
    .transform((value) => value === "true");

const httpUrl = (name: string) =>
  z
    .string()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, `${name} must use http or https`)
    .transform((value) => value.replace(/\/$/, ""));

export interface RuntimeSettings {
  expectedMint: PublicKey;
  stateDirectory: string;
  mcpUrl: string;
}

export function loadRuntimeSettings(
  env: NodeJS.ProcessEnv = process.env
): RuntimeSettings {
  const parsed = z
    .object({
      EXPECTED_MINT: publicKeyStringSchema,
      SETRA_STATE_DIR: z.string().min(1).default(".setra-state"),
      MCP_URL: httpUrl("MCP_URL").default("http://127.0.0.1:3002/mcp"),
    })
    .parse(env);
  return {
    expectedMint: parsed.EXPECTED_MINT,
    stateDirectory: resolve(parsed.SETRA_STATE_DIR),
    mcpUrl: parsed.MCP_URL,
  };
}

export interface ControlPlaneSettings {
  mcpPort: number;
  webPort: number;
  serviceOverlay: string;
  onboardingWriteEnabled: boolean;
}

export function loadControlPlaneSettings(
  env: NodeJS.ProcessEnv = process.env,
  defaultServiceOverlay: string
): ControlPlaneSettings {
  const parsed = z
    .object({
      MCP_PORT: portSchema("MCP_PORT", 3002),
      WEB_PORT: portSchema("WEB_PORT", 3003),
      SETRA_SERVICE_OVERLAY: z.string().min(1).optional(),
      SETRA_ONBOARDING_WRITE_ENABLED: booleanFlag(
        "SETRA_ONBOARDING_WRITE_ENABLED"
      ),
    })
    .parse(env);
  if (parsed.MCP_PORT === parsed.WEB_PORT)
    throw new Error("MCP_PORT and WEB_PORT must be different");
  return {
    mcpPort: parsed.MCP_PORT,
    webPort: parsed.WEB_PORT,
    serviceOverlay: resolve(
      parsed.SETRA_SERVICE_OVERLAY ?? defaultServiceOverlay
    ),
    onboardingWriteEnabled: parsed.SETRA_ONBOARDING_WRITE_ENABLED,
  };
}

export interface McpBridgeSettings {
  mcpPort: number;
  sellerUrl: string;
}

export function loadMcpBridgeSettings(
  env: NodeJS.ProcessEnv = process.env
): McpBridgeSettings {
  const parsed = z
    .object({
      MCP_PORT: portSchema("MCP_PORT", 3002),
      SELLER_URL: httpUrl("SELLER_URL").default("http://127.0.0.1:3000"),
    })
    .parse(env);
  return { mcpPort: parsed.MCP_PORT, sellerUrl: parsed.SELLER_URL };
}

export interface OperatorSettings {
  stateDirectory: string;
  sellerExecutionDirectory?: string;
  sellerMintDirectory?: string;
  rpcUrl?: string;
  sellerUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisTls?: boolean;
  mcpUrl: string;
  refundSchedulerEnabled: boolean;
}

export function loadOperatorSettings(
  env: NodeJS.ProcessEnv = process.env
): OperatorSettings {
  const rpcUrl = env.RPC_URL ?? env.ROLE_C_RPC_URL;
  const sellerUrl =
    env.SELLER_URL ?? env.SETRA_SELLER_URL ?? env.ROLE_C_SELLER_URL;
  const redisUrl =
    env.REDIS_URL ??
    (env.SETRA_REDIS_HOST ? undefined : "redis://127.0.0.1:6379");
  const redisHost = env.SETRA_REDIS_HOST;
  const parsed = z
    .object({
      SETRA_STATE_DIR: z.string().min(1).default(".setra-state"),
      SETRA_SELLER_EXECUTION_DIR: z.string().min(1).optional(),
      SETRA_SELLER_MINT_DIR: z.string().min(1).optional(),
      RPC_URL: httpUrl("RPC_URL").optional(),
      SELLER_URL: httpUrl("SELLER_URL").optional(),
      REDIS_URL: z.string().url().optional(),
      SETRA_REDIS_HOST: z.string().min(1).optional(),
      SETRA_REDIS_PORT: portSchema("SETRA_REDIS_PORT", 6379),
      MCP_URL: httpUrl("MCP_URL").default("http://127.0.0.1:3002/mcp"),
      SETRA_REFUND_SCHEDULER_ENABLED: booleanFlag(
        "SETRA_REFUND_SCHEDULER_ENABLED"
      ),
    })
    .parse({
      ...env,
      RPC_URL: rpcUrl,
      SELLER_URL: sellerUrl,
      REDIS_URL: redisUrl,
    });
  const parsedRedis = parsed.REDIS_URL ? new URL(parsed.REDIS_URL) : undefined;
  if (parsedRedis && !["redis:", "rediss:"].includes(parsedRedis.protocol))
    throw new Error("REDIS_URL must use redis or rediss");
  return {
    stateDirectory: resolve(parsed.SETRA_STATE_DIR),
    ...(parsed.SETRA_SELLER_EXECUTION_DIR
      ? { sellerExecutionDirectory: resolve(parsed.SETRA_SELLER_EXECUTION_DIR) }
      : {}),
    ...(parsed.SETRA_SELLER_MINT_DIR
      ? { sellerMintDirectory: resolve(parsed.SETRA_SELLER_MINT_DIR) }
      : {}),
    ...(parsed.RPC_URL ? { rpcUrl: parsed.RPC_URL } : {}),
    ...(parsed.SELLER_URL ? { sellerUrl: parsed.SELLER_URL } : {}),
    ...(parsedRedis || redisHost
      ? {
          redisHost: parsedRedis?.hostname ?? redisHost!,
          redisPort: parsedRedis?.port
            ? Number(parsedRedis.port)
            : parsed.SETRA_REDIS_PORT,
          redisTls: parsedRedis?.protocol === "rediss:",
        }
      : {}),
    mcpUrl: parsed.MCP_URL,
    refundSchedulerEnabled: parsed.SETRA_REFUND_SCHEDULER_ENABLED,
  };
}
