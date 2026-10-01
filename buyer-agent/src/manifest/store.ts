import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskManifestV1 } from "../types.js";

export interface StoredManifest {
  manifest: TaskManifestV1;
  manifestHash: string;
  initializeSignature: string | null;
}

export class ManifestStore {
  constructor(private readonly directory: string) {}

  pathFor(taskStatePda: string): string {
    return join(this.directory, `${taskStatePda}.json`);
  }

  save(taskStatePda: string, record: StoredManifest): void {
    const path = this.pathFor(taskStatePda);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
  }

  load(taskStatePda: string): StoredManifest | null {
    try {
      return JSON.parse(
        readFileSync(this.pathFor(taskStatePda), "utf8")
      ) as StoredManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
