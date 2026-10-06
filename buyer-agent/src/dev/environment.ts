import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { loadConfig, type BuyerAgentConfig } from "../config.js";
import {
  loadControlPlaneSettings,
  loadRuntimeSettings,
  type ControlPlaneSettings,
  type RuntimeSettings,
} from "../runtime-config.js";

export interface PreparedDevelopmentEnvironment {
  repositoryRoot: string;
  buyerDirectory: string;
  fixtureFile: string;
  buyer: BuyerAgentConfig;
  runtime: RuntimeSettings;
  control: ControlPlaneSettings;
  endpoints: {
    solana: string;
    redis: string;
    seller: string;
    mcp: string;
    control: string;
  };
  requiredFiles: string[];
  sellerEnvironment: NodeJS.ProcessEnv;
  childEnvironment: NodeJS.ProcessEnv;
  summary: Record<string, unknown>;
}

const fixtureSchema = z.object({
  buyer: z.string().min(1),
  verifier: z.string().min(1),
  mint: z.string().min(1),
  treasuryTokenAccount: z.string().min(1),
  sellerTokenAccount: z.string().min(1),
});

function first(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function requireValue(value: string | undefined, names: string): string {
  if (!value) throw new Error(`${names} is required`);
  return value;
}

function assertPublicKey(value: string, label: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new Error(`${label} must be a valid Solana public key`);
  }
}

function loopbackAddress(value: string, label: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:")
    throw new Error(`${label} must use http for local development`);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
    throw new Error(`${label} must use a loopback host`);
  if (parsed.username || parsed.password)
    throw new Error(`${label} must not contain credentials`);
  return parsed;
}

export function normalizedHost(hostname: string): string {
  return hostname === "localhost" || hostname === "[::1]"
    ? "127.0.0.1"
    : hostname;
}

export function prepareDevelopmentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
): PreparedDevelopmentEnvironment {
  const buyerDirectory = join(repositoryRoot, "buyer-agent");
  const fixtureFile = resolve(
    first(source, "SETRA_FIXTURE_FILE") ??
      join(repositoryRoot, "target", "e2e-fixture.json")
  );
  const buyerKeypairPath = resolve(
    requireValue(
      first(source, "BUYER_KEYPAIR_PATH", "ROLE_C_BUYER_KEYPAIR_PATH"),
      "BUYER_KEYPAIR_PATH or ROLE_C_BUYER_KEYPAIR_PATH"
    )
  );
  const verifierKeypairPath = resolve(
    requireValue(
      first(source, "VERIFIER_KEYPAIR_PATH", "ROLE_C_VERIFIER_KEYPAIR_PATH"),
      "VERIFIER_KEYPAIR_PATH or ROLE_C_VERIFIER_KEYPAIR_PATH"
    )
  );
  const normalized: NodeJS.ProcessEnv = {
    ...source,
    PROGRAM_ID: requireValue(
      first(source, "PROGRAM_ID", "ROLE_C_PROGRAM_ID"),
      "PROGRAM_ID or ROLE_C_PROGRAM_ID"
    ),
    RPC_URL: requireValue(
      first(source, "RPC_URL", "ROLE_C_RPC_URL"),
      "RPC_URL or ROLE_C_RPC_URL"
    ),
    SELLER_URL: requireValue(
      first(source, "SELLER_URL", "ROLE_C_SELLER_URL"),
      "SELLER_URL or ROLE_C_SELLER_URL"
    ),
    EXPECTED_MINT: requireValue(
      first(source, "EXPECTED_MINT", "ROLE_C_EXPECTED_MINT"),
      "EXPECTED_MINT or ROLE_C_EXPECTED_MINT"
    ),
    BUYER_KEYPAIR_PATH: buyerKeypairPath,
    VERIFIER_KEYPAIR_PATH: verifierKeypairPath,
    PROTOCOL_TREASURY_ADDRESS: requireValue(
      first(source, "PROTOCOL_TREASURY_ADDRESS", "ROLE_C_PROTOCOL_TREASURY"),
      "PROTOCOL_TREASURY_ADDRESS or ROLE_C_PROTOCOL_TREASURY"
    ),
    SETTLEMENT_SAFETY_MARGIN_SEC: source.SETTLEMENT_SAFETY_MARGIN_SEC ?? "5",
    SETRA_STATE_DIR:
      source.SETRA_STATE_DIR ?? join(repositoryRoot, ".setra-state"),
  };
  const buyer = loadConfig(normalized);
  const control = loadControlPlaneSettings(
    normalized,
    join(repositoryRoot, "seller-server", "config", "services.local.json")
  );
  const mcpUrl = `http://127.0.0.1:${control.mcpPort}/mcp`;
  const runtime = loadRuntimeSettings({ ...normalized, MCP_URL: mcpUrl });
  const sellerUrl = loopbackAddress(buyer.sellerUrl, "SELLER_URL");
  const sellerPort = Number(sellerUrl.port || 80);
  if (!Number.isInteger(sellerPort) || sellerPort < 1 || sellerPort > 65_535)
    throw new Error("SELLER_URL must contain a valid port");

  let fixture: z.infer<typeof fixtureSchema>;
  try {
    fixture = fixtureSchema.parse(
      JSON.parse(readFileSync(fixtureFile, "utf8")) as unknown
    );
  } catch (error) {
    throw new Error(
      `could not load fixture ${fixtureFile}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const bindings = [
    [fixture.buyer, buyer.buyer.publicKey.toBase58(), "fixture buyer"],
    [fixture.verifier, buyer.verifier.publicKey.toBase58(), "fixture verifier"],
    [fixture.mint, runtime.expectedMint.toBase58(), "fixture mint"],
    [
      fixture.treasuryTokenAccount,
      buyer.protocolTreasuryAddress.toBase58(),
      "fixture treasury",
    ],
  ] as const;
  for (const [actual, expected, label] of bindings) {
    if (assertPublicKey(actual, label) !== expected)
      throw new Error(`${label} does not match the configured identity`);
  }
  const sellerTokenAccount = assertPublicKey(
    source.SETRA_SELLER_TOKEN_ACCOUNT ?? fixture.sellerTokenAccount,
    "seller token account"
  );
  const redisUrl = new URL(source.REDIS_URL ?? "redis://127.0.0.1:6379");
  if (redisUrl.protocol !== "redis:")
    throw new Error("REDIS_URL must use redis for local development");

  const sellerEnvironment: NodeJS.ProcessEnv = {
    ...source,
    RPC_URL: buyer.rpcUrl,
    PROGRAM_ID: buyer.programId.toBase58(),
    MINT: runtime.expectedMint.toBase58(),
    SELLER_TOKEN_ACCOUNT: sellerTokenAccount,
    VERIFIER: buyer.verifier.publicKey.toBase58(),
    PROTOCOL_TREASURY: buyer.protocolTreasuryAddress.toBase58(),
    BIND_ADDR: `${normalizedHost(sellerUrl.hostname)}:${sellerPort}`,
    SETRA_EXECUTION_STORE:
      source.SETRA_EXECUTION_STORE ??
      join(runtime.stateDirectory, "seller-executions"),
  };
  const childEnvironment: NodeJS.ProcessEnv = {
    ...normalized,
    MCP_URL: mcpUrl,
    REDIS_URL: redisUrl.href,
  };
  const endpoints = {
    solana: buyer.rpcUrl,
    redis: `${redisUrl.hostname}:${Number(redisUrl.port || 6379)}`,
    seller: buyer.sellerUrl,
    mcp: mcpUrl,
    control: `http://127.0.0.1:${control.webPort}`,
  };
  return {
    repositoryRoot,
    buyerDirectory,
    fixtureFile,
    buyer,
    runtime,
    control,
    endpoints,
    requiredFiles: [
      fixtureFile,
      buyerKeypairPath,
      verifierKeypairPath,
      join(repositoryRoot, "target", "idl", "setra402.json"),
      join(buyerDirectory, "config", "test-bundles", "add-v1.mjs"),
    ],
    sellerEnvironment,
    childEnvironment,
    summary: {
      programId: buyer.programId.toBase58(),
      buyer: buyer.buyer.publicKey.toBase58(),
      verifier: buyer.verifier.publicKey.toBase58(),
      mint: runtime.expectedMint.toBase58(),
      treasury: buyer.protocolTreasuryAddress.toBase58(),
      stateDirectory: runtime.stateDirectory,
      endpoints,
    },
  };
}
