import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { LoadedArtifact } from "./level1/artifact-integrity.js";

export interface ArtifactDescriptor {
  relativePath: string;
  mimeType?: string;
}

export class DirectoryArtifactLoader {
  constructor(
    private readonly root: string,
    private readonly artifacts: ReadonlyMap<string, ArtifactDescriptor>
  ) {}

  async loadArtifact(
    id: string,
    maxBytes: number
  ): Promise<LoadedArtifact | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
    const descriptor = this.artifacts.get(id);
    if (!descriptor) return null;
    try {
      const root = await realpath(this.root);
      const target = await realpath(resolve(root, descriptor.relativePath));
      const relativeTarget = relative(root, target);
      if (
        relativeTarget === "" ||
        relativeTarget === ".." ||
        relativeTarget.startsWith(
          `..${process.platform === "win32" ? "\\" : "/"}`
        ) ||
        isAbsolute(relativeTarget)
      )
        return null;
      const handle = await open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      );
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > maxBytes) return null;
        const bytes = await handle.readFile();
        return descriptor.mimeType
          ? { bytes, mimeType: descriptor.mimeType }
          : { bytes };
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }
}
