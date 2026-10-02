import type { PublicKey } from "@solana/web3.js";
import type { StoredManifest } from "../manifest/store.js";
import type {
  ResultEnvelopeV1,
  TaskManifestV1,
  VerificationPolicyV1,
  VerificationReport,
} from "../types.js";
import { VerificationEngine, type VerificationContext } from "./engine.js";
import type { LoadedArtifact } from "./level1/artifact-integrity.js";
import type { SolanaStateReader } from "./level1/solana-state.js";

export interface VerificationChain {
  verifier: PublicKey;
  getChainUnixTime(): Promise<number>;
  verifyManifestMemo(signature: string, expectedHash: string): Promise<void>;
}

export class VerificationCoordinator {
  constructor(
    private readonly engine: VerificationEngine,
    private readonly chain: VerificationChain,
    private readonly schemas: ReadonlyMap<string, unknown>,
    private readonly solana: SolanaStateReader,
    private readonly loadArtifact: (
      id: string
    ) => Promise<LoadedArtifact | null> = async () => null
  ) {}

  async verify(
    manifest: TaskManifestV1,
    policy: VerificationPolicyV1,
    result: ResultEnvelopeV1,
    record: StoredManifest
  ): Promise<VerificationReport> {
    const context: VerificationContext = {
      committedManifestHash: record.manifestHash,
      verifierPubkey: this.chain.verifier.toBase58(),
      nowUnix: await this.chain.getChainUnixTime(),
      schemas: this.schemas,
      loadArtifact: this.loadArtifact,
      solana: this.solana,
      verifyManifestCommitment: async (manifestHash) => {
        if (!record.initializeSignature)
          throw new Error("initialize transaction signature is missing");
        await this.chain.verifyManifestMemo(
          record.initializeSignature,
          manifestHash
        );
      },
    };
    return this.engine.verify(manifest, policy, result, context);
  }
}
