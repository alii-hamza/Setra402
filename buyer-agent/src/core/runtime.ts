import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { loadConfig, type BuyerAgentConfig } from "../config.js";
import { ChainClient } from "../chain/client.js";
import { EscrowCoordinator } from "../chain/escrow.js";
import { SettlementCoordinator } from "../chain/settlement-coordinator.js";
import { ManifestStore } from "../manifest/store.js";
import { BuyerOrchestrator } from "../orchestrator.js";
import { LegacyChaumianClient } from "../privacy/legacy-chaumian.js";
import { validateQuote } from "../quote.js";
import { RestX402Transport } from "../transport/rest-x402.js";
import { McpTransport } from "../transport/mcp.js";
import type { LegacyTaskQuoteWire, RequestContext } from "../types.js";
import { VerificationCoordinator } from "../verification/coordinator.js";
import { VerificationEngine } from "../verification/engine.js";
import { DEFAULT_SCHEMA_REGISTRY } from "../verification/schemas.js";
import { SolanaRpcStateReader } from "../verification/solana-reader.js";
import { defaultRunners } from "../verification/level2/default-runners.js";
import { DockerSandbox } from "../verification/level2/docker-sandbox.js";
import { SourceClient } from "../verification/level2/source-client.js";
import { FileChallengeStore } from "../verification/level2/challenge-store.js";
import { ProtectedTaskController } from "./task-controller.js";

export interface RuntimeOptions {
  config?: BuyerAgentConfig;
  expectedMint?: PublicKey;
  directory?: string;
  mcpUrl?: string;
  sourceClient?: SourceClient;
  sandbox?: DockerSandbox;
}
export function createRuntime(options: RuntimeOptions = {}) {
  const config = options.config ?? loadConfig();
  const expectedMint =
    options.expectedMint ?? new PublicKey(process.env.EXPECTED_MINT ?? "");
  const directory = resolve(
    options.directory ?? process.env.SETRA_STATE_DIR ?? ".setra-state"
  );
  const connection = new Connection(config.rpcUrl, "confirmed");
  const chain = new ChainClient({
    connection,
    idl: JSON.parse(
      readFileSync(
        new URL("../../../target/idl/setra402.json", import.meta.url),
        "utf8"
      )
    ) as Idl,
    programId: config.programId,
    buyer: config.buyer,
    verifier: config.verifier,
    protocolTreasury: config.protocolTreasuryAddress,
  });
  const escrow = new EscrowCoordinator(
    chain,
    new ManifestStore(join(directory, "manifests"))
  );
  const privacy = new LegacyChaumianClient(config.sellerUrl);
  const settlement = new SettlementCoordinator(
    chain,
    config.settlementSafetyMarginSec,
    async (n) => {
      await privacy.mirrorNullifierAfterSettlement(n);
    }
  );
  const normalizeQuote = (raw: unknown, context: RequestContext) =>
    validateQuote(raw as LegacyTaskQuoteWire, {
      programId: config.programId,
      buyer: config.buyer.publicKey,
      verifier: config.verifier.publicKey,
      expectedMint,
      taskId: context.taskId,
      isPrivate: context.isPrivate,
      serviceId: context.serviceId ?? "legacy-rest",
    });
  const transports = {
    REST: new RestX402Transport(config.sellerUrl, normalizeQuote),
    MCP: new McpTransport(
      options.mcpUrl ?? process.env.MCP_URL ?? "http://127.0.0.1:3002/mcp",
      normalizeQuote
    ),
  };
  const sourceClient = options.sourceClient ?? new SourceClient();
  const sandbox = options.sandbox ?? new DockerSandbox();
  const runners = defaultRunners(),
    challenges = new FileChallengeStore(join(directory, "challenges"));
  const controller = new ProtectedTaskController(join(directory, "tasks"), {
    normalizeQuote,
    async quote(input, transport) {
      return transports[transport].requestQuote(input);
    },
    async fund(quote, input) {
      if (input.buyer !== config.buyer.publicKey.toBase58())
        throw new Error("buyer does not match configured signer");
      return escrow.ensureFunded({
        quote,
        serviceId: quote.serviceId,
        input: input.input,
        policyHash: quote.policyHash,
      });
    },
    async run(input, quote, transport) {
      if (input.buyer !== config.buyer.publicKey.toBase58())
        throw new Error("buyer does not match configured signer");
      const loadArtifact = async (id: string, maxBytes: number) => {
        const response = await fetch(
          `${config.sellerUrl}/tasks/${
            input.taskId
          }/artifacts/${encodeURIComponent(id)}?buyer=${encodeURIComponent(
            input.buyer
          )}`,
          { signal: AbortSignal.timeout(10_000) }
        );
        if (!response.ok) return null;
        let bytes = Buffer.alloc(0);
        if (!response.body) return null;
        for await (const chunk of response.body) {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > maxBytes)
            throw new Error("artifact response exceeds byte limit");
        }
        return {
          bytes,
          mimeType:
            response.headers.get("content-type") ?? "application/octet-stream",
        };
      };
      const verification = new VerificationCoordinator(
        new VerificationEngine(),
        chain,
        DEFAULT_SCHEMA_REGISTRY,
        new SolanaRpcStateReader(connection),
        loadArtifact,
        {
          source: { sourceClient, challenges },
          tests: { runners, sandbox, loadArtifact },
        }
      );
      // Saved quote is revalidated above. Both transports use this exact path.
      return new BuyerOrchestrator(
        {
          async requestQuote() {
            return quote;
          },
          executeFundedTask: (input) =>
            transports[transport].executeFundedTask(input),
        },
        escrow,
        settlement,
        verification,
        privacy
      ).run({ ...input, serviceId: quote.serviceId });
    },
    async state(quote) {
      return chain.fetchTaskState(new PublicKey(quote.taskStatePda));
    },
    async now() {
      return chain.getChainUnixTime();
    },
    async refund(quote) {
      return settlement.refundExpired(quote);
    },
  });
  return { controller, chain, escrow, settlement, transports, config, runners };
}
