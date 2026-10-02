import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChainClient } from "../../src/chain/client.js";
import { EscrowCoordinator } from "../../src/chain/escrow.js";
import { SettlementCoordinator } from "../../src/chain/settlement-coordinator.js";
import { deriveTaskPda, deriveVaultPda } from "../../src/chain/pda.js";
import { loadKeypair } from "../../src/config.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { ManifestStore } from "../../src/manifest/store.js";
import { BuyerOrchestrator } from "../../src/orchestrator.js";
import { validateQuote } from "../../src/quote.js";
import { RestX402Transport } from "../../src/transport/rest-x402.js";
import type { VerificationPolicyV1 } from "../../src/types.js";
import { VerificationCoordinator } from "../../src/verification/coordinator.js";
import { VerificationEngine } from "../../src/verification/engine.js";
import { FileChallengeStore } from "../../src/verification/level2/challenge-store.js";
import { DockerSandbox } from "../../src/verification/level2/docker-sandbox.js";
import { defaultRunners } from "../../src/verification/level2/default-runners.js";
import { SourceClient } from "../../src/verification/level2/source-client.js";
import { DEFAULT_SCHEMA_REGISTRY } from "../../src/verification/schemas.js";
import { SolanaRpcStateReader } from "../../src/verification/solana-reader.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required for live E2E`);
  return value;
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let chain: ChainClient, origin: string, orchestrator: BuyerOrchestrator;
let programId: PublicKey, buyer: string, verifier: string, mint: PublicKey;
let artifacts = Buffer.from("");
let id = BigInt(Date.now()) + 100_000n;
const runners = defaultRunners();
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") {
      res.end(JSON.stringify({ company: "Acme" }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const taskId = BigInt(req.url!.split("/").pop()!);
    const [task] = deriveTaskPda(programId, new PublicKey(input.buyer), taskId);
    const [vault] = deriveVaultPda(programId, task);
    const type = input.service_id === "source-fixture" ? "source" : "tests";
    const policy: VerificationPolicyV1 = {
      version: "1",
      level: 2,
      checks:
        type === "source"
          ? [
              { type: "record_count", pointer: "/records", exact: 3 },
              {
                type: "source_sampling",
                pointer: "/records",
                sample_count: 3,
                source_url_field: "source_url",
                fields: ["company"],
                allowed_domains: ["127.0.0.1"],
                minimum_match_bps: 10_000,
              },
            ]
          : [
              {
                type: "test_suite",
                runner_profile: "node22-test-v1",
                test_bundle_hash: runners.list()[0]!.test_bundle_hash,
                timeout_seconds: 10,
              },
            ],
    };
    const funded = await chain.fetchTaskState(task);
    if (!funded) {
      const fixture = JSON.parse(
        readFileSync(
          new URL("../../../target/e2e-fixture.json", import.meta.url),
          "utf8"
        )
      );
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          task_id: taskId.toString(),
          service_id: input.service_id,
          program_id: programId.toBase58(),
          task_state_pda: task.toBase58(),
          vault_pda: vault.toBase58(),
          mint: mint.toBase58(),
          seller_token_account: fixture.sellerTokenAccount,
          verifier,
          amount: "1500000",
          timeout_seconds: 30,
          is_private: false,
          protocol_fee_bps: 100,
          verification_policy: policy,
          policy_hash: hashCanonical(policy),
        })
      );
      return;
    }
    if (
      funded.status !== "pending" ||
      (await chain.getChainUnixTime()) >= funded.deadlineUnix
    ) {
      res.writeHead(410);
      res.end();
      return;
    }
    artifacts = Buffer.from(
      input.input.fixture === "invalid"
        ? "export const add = (a,b) => a-b;"
        : "export const add = (a,b) => a+b;"
    );
    const value =
      type === "source"
        ? {
            records: Array.from({ length: 3 }, () => ({
              source_url: origin + "/source",
              company: input.input.fixture === "invalid" ? "Wrong" : "Acme",
            })),
          }
        : {
            artifact: {
              id: "code-module",
              content_hash: sha(artifacts),
              size_bytes: artifacts.length,
            },
          };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        version: "1",
        task_id: taskId.toString(),
        service_id: input.service_id,
        result: value,
        result_hash: hashCanonical(value),
        input: input.input,
        output_hash: hashCanonical(input.input),
        completed_at_unix: await chain.getChainUnixTime(),
        evidence:
          type === "source"
            ? []
            : [
                {
                  type: "artifact",
                  id: "code-module",
                  content_hash: sha(artifacts),
                  size_bytes: artifacts.length,
                },
              ],
      })
    );
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
beforeAll(async () => {
  const connection = new Connection(required("ROLE_C_RPC_URL"), "confirmed");
  const buyerKey = loadKeypair(required("ROLE_C_BUYER_KEYPAIR_PATH"));
  const verifierKey = loadKeypair(required("ROLE_C_VERIFIER_KEYPAIR_PATH"));
  buyer = buyerKey.publicKey.toBase58();
  verifier = verifierKey.publicKey.toBase58();
  programId = new PublicKey(required("ROLE_C_PROGRAM_ID"));
  mint = new PublicKey(required("ROLE_C_EXPECTED_MINT"));
  chain = new ChainClient({
    connection,
    idl: JSON.parse(
      readFileSync(
        new URL("../../../target/idl/setra402.json", import.meta.url),
        "utf8"
      )
    ) as Idl,
    programId,
    buyer: buyerKey,
    verifier: verifierKey,
    protocolTreasury: new PublicKey(required("ROLE_C_PROTOCOL_TREASURY")),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport = new RestX402Transport(origin, (wire, ctx) =>
    validateQuote(wire, {
      programId,
      buyer: buyerKey.publicKey,
      verifier: verifierKey.publicKey,
      expectedMint: mint,
      taskId: ctx.taskId,
      isPrivate: ctx.isPrivate,
      serviceId: ctx.serviceId!,
    })
  );
  const loadArtifact = async () => ({ bytes: artifacts });
  const sandbox = new DockerSandbox(
    process.env.ROLE_C_DOCKER_WSL === "1"
      ? {
          executable: "wsl.exe",
          prefix: ["-u", "root", "--", "docker"],
          mapInputPath: (path) =>
            `/mnt/${path[0]!.toLowerCase()}${path
              .slice(2)
              .replaceAll("\\", "/")}`,
        }
      : { executable: "docker" }
  );
  const verification = new VerificationCoordinator(
    new VerificationEngine(),
    chain,
    DEFAULT_SCHEMA_REGISTRY,
    new SolanaRpcStateReader(connection),
    loadArtifact,
    {
      source: {
        sourceClient: new SourceClient({}, undefined, [origin]),
        challenges: new FileChallengeStore(
          mkdtempSync(join(tmpdir(), "setra-live-challenges-"))
        ),
      },
      tests: { runners, sandbox, loadArtifact },
    }
  );
  orchestrator = new BuyerOrchestrator(
    transport,
    new EscrowCoordinator(
      chain,
      new ManifestStore(mkdtempSync(join(tmpdir(), "setra-l2-live-")))
    ),
    new SettlementCoordinator(chain, 1),
    verification
  );
}, 30_000);
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
describe("live REST L2 with deterministic seller/source fixtures and real chain/sandbox", () => {
  it.each([
    ["source-fixture", "valid"],
    ["source-fixture", "invalid"],
    ["tests-fixture", "valid"],
    ["tests-fixture", "invalid"],
  ])(
    "%s %s -> authoritative settlement decision",
    async (serviceId, fixture) => {
      const result = await orchestrator.run({
        taskId: id++,
        buyer,
        serviceId,
        isPrivate: false,
        input: { fixture },
      });
      expect(result.status).toBe(
        fixture === "valid" ? "settled" : "verification_failed"
      );
      expect(
        (await chain.fetchTaskState(new PublicKey(result.quote.taskStatePda)))
          ?.status
      ).toBe(fixture === "valid" ? "settled" : "pending");
    },
    30_000
  );
});
