import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../../src/config.js";
import {
  loadControlPlaneSettings,
  loadMcpBridgeSettings,
  loadOperatorSettings,
  loadRuntimeSettings,
} from "../../src/runtime-config.js";

describe("strict configuration", () => {
  it("loads persisted buyer and verifier keypairs without generating identities", () => {
    const dir = mkdtempSync(join(tmpdir(), "setra402-config-"));
    const buyer = Keypair.generate();
    const verifier = Keypair.generate();
    const buyerPath = join(dir, "buyer.json");
    const verifierPath = join(dir, "verifier.json");
    writeFileSync(buyerPath, JSON.stringify(Array.from(buyer.secretKey)));
    writeFileSync(verifierPath, JSON.stringify(Array.from(verifier.secretKey)));

    const config = loadConfig({
      PROGRAM_ID: "FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN",
      RPC_URL: "http://127.0.0.1:8899",
      SELLER_URL: "http://127.0.0.1:3000",
      BUYER_KEYPAIR_PATH: buyerPath,
      VERIFIER_KEYPAIR_PATH: verifierPath,
      PROTOCOL_TREASURY_ADDRESS: Keypair.generate().publicKey.toBase58(),
      SETTLEMENT_SAFETY_MARGIN_SEC: "5",
    });

    expect(config.buyer.publicKey.equals(buyer.publicKey)).toBe(true);
    expect(config.verifier.publicKey.equals(verifier.publicKey)).toBe(true);
  });

  it("fails fast when the required treasury account is absent", () => {
    expect(() => loadConfig({})).toThrow(
      /PROGRAM_ID|PROTOCOL_TREASURY_ADDRESS/
    );
  });

  it("rejects a zero settlement safety margin", () => {
    const dir = mkdtempSync(join(tmpdir(), "setra402-config-"));
    const keypair = Keypair.generate();
    const keypairPath = join(dir, "keypair.json");
    writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)));

    expect(() =>
      loadConfig({
        PROGRAM_ID: "FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN",
        RPC_URL: "http://127.0.0.1:8899",
        SELLER_URL: "http://127.0.0.1:3000",
        BUYER_KEYPAIR_PATH: keypairPath,
        VERIFIER_KEYPAIR_PATH: keypairPath,
        PROTOCOL_TREASURY_ADDRESS: Keypair.generate().publicKey.toBase58(),
        SETTLEMENT_SAFETY_MARGIN_SEC: "0",
      })
    ).toThrow(/SETTLEMENT_SAFETY_MARGIN_SEC/);
  });

  it("validates public runtime settings separately from signer configuration", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const settings = loadRuntimeSettings({
      EXPECTED_MINT: mint,
      SETRA_STATE_DIR: "state",
      MCP_URL: "http://127.0.0.1:4102/mcp",
    });

    expect(settings.expectedMint.toBase58()).toBe(mint);
    expect(settings.stateDirectory).toMatch(/[\\/]state$/);
    expect(settings.mcpUrl).toBe("http://127.0.0.1:4102/mcp");
    expect(() => loadRuntimeSettings({})).toThrow(/EXPECTED_MINT/);
  });

  it("rejects malformed control-plane ports and boolean flags", () => {
    expect(
      loadControlPlaneSettings(
        { MCP_PORT: "4102", WEB_PORT: "4103" },
        "services.local.json"
      )
    ).toMatchObject({
      mcpPort: 4102,
      webPort: 4103,
      onboardingWriteEnabled: false,
    });
    expect(() =>
      loadControlPlaneSettings(
        { MCP_PORT: "0", WEB_PORT: "4103" },
        "services.local.json"
      )
    ).toThrow(/MCP_PORT/);
    expect(() =>
      loadControlPlaneSettings(
        { SETRA_ONBOARDING_WRITE_ENABLED: "yes" },
        "services.local.json"
      )
    ).toThrow(/SETRA_ONBOARDING_WRITE_ENABLED/);
  });

  it("loads operator and standalone MCP settings without signer secrets", () => {
    expect(
      loadOperatorSettings({
        RPC_URL: "http://127.0.0.1:8899",
        SELLER_URL: "http://127.0.0.1:3001/",
        REDIS_URL: "redis://127.0.0.1:6380",
        SETRA_REFUND_SCHEDULER_ENABLED: "false",
      })
    ).toMatchObject({
      rpcUrl: "http://127.0.0.1:8899",
      sellerUrl: "http://127.0.0.1:3001",
      redisHost: "127.0.0.1",
      redisPort: 6380,
      refundSchedulerEnabled: false,
    });
    expect(
      loadMcpBridgeSettings({
        MCP_PORT: "4202",
        SELLER_URL: "http://127.0.0.1:3001/",
      })
    ).toEqual({
      mcpPort: 4202,
      sellerUrl: "http://127.0.0.1:3001",
    });
  });

  it("preserves TLS Redis settings for operational health probes", () => {
    expect(
      loadOperatorSettings({
        SETRA_STATE_DIR: ".setra-state",
        REDIS_URL: "rediss://cache.example.test:6380",
      })
    ).toMatchObject({
      redisHost: "cache.example.test",
      redisPort: 6380,
      redisTls: true,
    });
  });
});
