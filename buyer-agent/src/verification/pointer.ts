export interface PointerResolution {
  found: boolean;
  value?: unknown;
}

function decodeToken(token: string): string | null {
  if (/~(?:[^01]|$)/.test(token)) return null;
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function resolveJsonPointer(
  document: unknown,
  pointer: string
): PointerResolution {
  if (pointer === "") return { found: true, value: document };
  if (!pointer.startsWith("/")) return { found: false };
  let value = document;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = decodeToken(rawToken);
    if (token === null) return { found: false };
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= value.length)
        return { found: false };
      value = value[index];
      continue;
    }
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.prototype.hasOwnProperty.call(value, token)
    )
      return { found: false };
    value = (value as Record<string, unknown>)[token];
  }
  return { found: true, value };
}
