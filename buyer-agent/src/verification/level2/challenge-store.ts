import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureDurableDirectory, syncDirectory } from "../../core/journal.js";

export interface ChallengeStore {
  getOrCreate(contextHash: string): Promise<string>;
}

// Each immutable result/check context has one seed. Exclusive creation makes
// concurrent retries reuse the winner, including across verifier processes.
export class FileChallengeStore implements ChallengeStore {
  constructor(private readonly directory: string) {}
  async getOrCreate(contextHash: string): Promise<string> {
    if (!/^[0-9a-f]{64}$/.test(contextHash))
      throw new Error("invalid challenge context");
    ensureDurableDirectory(this.directory);
    const path = join(this.directory, `${contextHash}.seed`);
    const seed = randomBytes(32).toString("hex");
    const temporary = join(
      this.directory,
      `${contextHash}.${randomUUID()}.tmp`
    );
    await writeFile(temporary, seed, { flag: "wx", mode: 0o600, flush: true });
    try {
      try {
        await link(temporary, path);
        syncDirectory(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await unlink(temporary);
    }
    const saved = await readFile(path, "utf8");
    if (!/^[0-9a-f]{64}$/.test(saved))
      throw new Error("corrupt persisted challenge");
    return saved;
  }
}
