import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hashCanonical } from "../manifest/hash.js";
import { jsonSafe } from "../mcp/protocol.js";

export type JournalFault = (point: string, path: string) => void;
// Hooks are constructor dependencies for test processes, never runtime inputs.
export class DurableJournal {
  constructor(private readonly fault?: JournalFault) {
    if (fault && process.env.NODE_ENV !== "test")
      throw new Error("journal failpoints are test-only");
  }
  private point(name: string, path: string) {
    this.fault?.(name, path);
  }
  read(path: string): unknown | null {
    let bytes: string;
    try {
      bytes = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const record = JSON.parse(bytes);
      if (
        !record ||
        Object.keys(record).sort().join(",") !== "checksum,key,value,version" ||
        record.version !== 1 ||
        record.key !== basename(path) ||
        record.value === null ||
        hashCanonical({ key: record.key, value: record.value }) !==
          record.checksum
      )
        throw new Error("invalid journal");
      return record.value;
    } catch {
      throw new Error("corrupt or legacy journal; reconciliation required");
    }
  }
  write(path: string, value: unknown): void {
    this.commit(path, value, false);
  }
  publish(path: string, value: unknown): boolean {
    return this.commit(path, value, true);
  }
  private commit(path: string, value: unknown, exclusive: boolean): boolean {
    ensureDurableDirectory(dirname(path));
    const safe = jsonSafe(value),
      key = basename(path);
    if (safe === null) throw new Error("null journal value");
    const bytes = JSON.stringify({
      version: 1,
      key,
      value: safe,
      checksum: hashCanonical({ key, value: safe }),
    });
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      this.point("before_temp_write", path);
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, bytes);
      this.point("after_temp_write", path);
      this.point("before_fsync", path);
      fsyncSync(fd);
      this.point("after_fsync", path);
      closeSync(fd);
      fd = undefined;
      this.point("before_publish", path);
      if (exclusive) {
        try {
          linkSync(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
      } else renameSync(temporary, path);
      syncDirectory(dirname(path));
      this.point("after_publish", path);
      return true;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export function syncDirectory(directory: string): void {
  // Windows does not support opening directories via Node's fs API. File data
  // is flushed; POSIX additionally flushes namespace metadata after publication.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Flush each namespace ancestor, including the configured state root's parent.
// Windows file fsync supports process-restart safety; Node cannot establish
// directory/host-power-loss durability there, which remains an explicit limit.
export function ensureDurableDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let current = resolve(directory);
  for (;;) {
    syncDirectory(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
