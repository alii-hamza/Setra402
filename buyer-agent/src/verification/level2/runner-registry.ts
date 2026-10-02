import { createHash } from "node:crypto";

export interface RunnerProfile {
  id: string;
  image: string;
  command: readonly string[];
  artifactEvidenceId: string;
  testBundle: Uint8Array;
  maxArtifactBytes: number;
}

export class RunnerProfileRegistry {
  private readonly profiles = new Map<string, RunnerProfile>();
  constructor(profiles: readonly RunnerProfile[] = []) {
    for (const profile of profiles) {
      if (
        this.profiles.has(profile.id) ||
        !/^[a-z0-9][a-z0-9-]*$/.test(profile.id) ||
        !/^(?:[a-z0-9/.:-]+@)?sha256:[0-9a-f]{64}$/.test(profile.image) ||
        !profile.command.length ||
        !Number.isSafeInteger(profile.maxArtifactBytes) ||
        profile.maxArtifactBytes < 1 ||
        !profile.testBundle.byteLength ||
        profile.testBundle.byteLength > 1_048_576
      )
        throw new Error("invalid trusted runner profile");
      this.profiles.set(profile.id, {
        ...profile,
        command: [...profile.command],
        testBundle: Uint8Array.from(profile.testBundle),
      });
    }
  }
  get(id: string): RunnerProfile | undefined {
    const profile = this.profiles.get(id);
    return (
      profile && {
        ...profile,
        command: [...profile.command],
        testBundle: Uint8Array.from(profile.testBundle),
      }
    );
  }
  list() {
    return [...this.profiles.values()].map((p) => ({
      id: p.id,
      test_bundle_hash: createHash("sha256").update(p.testBundle).digest("hex"),
    }));
  }
}
