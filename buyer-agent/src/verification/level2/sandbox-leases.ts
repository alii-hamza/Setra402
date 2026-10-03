import { readdirSync, unlinkSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { DurableJournal, ensureDurableDirectory } from "../../core/journal.js";

const leaseSchema = z
  .object({
    pid: z.number().int().positive(),
    container: z
      .string()
      .regex(/^setra402-verify-[0-9a-f-]{36}-[0-9a-f-]{36}$/),
    directory: z.string(),
  })
  .strict();
export class SandboxLeases {
  private readonly journal = new DurableJournal();
  constructor(
    private readonly root = resolve(
      process.env.SETRA_STATE_DIR ?? ".setra-state",
      "sandbox-leases"
    )
  ) {
    ensureDurableDirectory(root);
  }
  claim(container: string, directory: string): string {
    const path = join(this.root, `${container}.lease`);
    if (
      !this.journal.publish(
        path,
        leaseSchema.parse({ pid: process.pid, container, directory })
      )
    )
      throw new Error("sandbox lease conflict");
    return path;
  }
  complete(path: string) {
    unlinkSync(path);
  }
  async recover(remove: (container: string) => Promise<void>) {
    for (const file of readdirSync(this.root).filter((name) =>
      name.endsWith(".lease")
    )) {
      const path = join(this.root, file);
      const lease = leaseSchema.parse(this.journal.read(path));
      if (
        file !== `${lease.container}.lease` ||
        dirname(resolve(lease.directory)) !== resolve(tmpdir()) ||
        !basename(lease.directory).startsWith(
          `${lease.container.slice(0, -37)}-input-`
        )
      )
        throw new Error("invalid sandbox lease; reconciliation required");
      try {
        process.kill(lease.pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      // Only a proven dead owner and our validated fixed-name inputs qualify.
      // Daemon failure retains evidence and prevents subsequent verification.
      await remove(lease.container);
      const { chmod, unlink, rmdir } = await import("node:fs/promises");
      for (const name of ["artifact.mjs", "tests.mjs"]) {
        const input = join(lease.directory, name);
        await chmod(input, 0o600).catch(() => {});
        await unlink(input).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      await rmdir(lease.directory).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.complete(path);
    }
  }
}
