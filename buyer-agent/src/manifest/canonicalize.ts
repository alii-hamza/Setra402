function normalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TypeError(
        `floating-point and non-finite numbers are forbidden at ${path}`
      );
    }
    if (!Number.isSafeInteger(value))
      throw new TypeError(`unsafe integer at ${path}`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry, index) => normalize(entry, `${path}/${index}`));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined)
        throw new TypeError(`undefined is forbidden at ${path}/${key}`);
      output[key] = normalize(entry, `${path}/${key}`);
    }
    return output;
  }
  throw new TypeError(`unsupported value at ${path}`);
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}
