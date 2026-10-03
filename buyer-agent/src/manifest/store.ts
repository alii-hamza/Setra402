import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DurableJournal } from "../core/journal.js";
import { parseTaskManifest } from "../verification/contracts.js";
import { hashCanonical } from "./hash.js";
import type { TaskManifestV1 } from "../types.js";

export interface StoredManifest {
  manifest: TaskManifestV1;
  manifestHash: string;
  initializeSignature: string | null;
}

export class ManifestStore {
  constructor(
    private readonly directory: string,
    private readonly journal = new DurableJournal()
  ) {}
  private validate(value: unknown): StoredManifest {
    try {
      const record = z
        .object({
          manifest: z.unknown(),
          manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
          initializeSignature: z.string().min(1).nullable(),
        })
        .strict()
        .parse(value);
      const manifest = parseTaskManifest(record.manifest);
      if (hashCanonical(manifest) !== record.manifestHash)
        throw new Error("hash mismatch");
      return { ...record, manifest };
    } catch {
      throw new Error("corrupt manifest journal; reconciliation required");
    }
  }

  pathFor(taskStatePda: string): string {
    return join(this.directory, `${taskStatePda}.json`);
  }

  save(taskStatePda: string, record: StoredManifest): void {
    this.journal.write(this.pathFor(taskStatePda), this.validate(record));
  }

  load(taskStatePda: string): StoredManifest | null {
    try {
      const raw = JSON.parse(readFileSync(this.pathFor(taskStatePda), "utf8"));
      // Valid Phase 1/2/3 manifests remain readable; incomplete legacy records
      // never bypass schema/hash checks. All new writes use flushed envelopes.
      return this.validate(
        raw?.version === 1 ? this.journal.read(this.pathFor(taskStatePda)) : raw
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
