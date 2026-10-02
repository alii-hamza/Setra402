import AjvModule, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/ajv.js";
import type {
  JsonSchemaCheckV1,
  VerificationCheckResult,
} from "../../types.js";
import { fail, pass } from "./common.js";

export interface JsonSchemaContext {
  schemas: ReadonlyMap<string, unknown>;
  maxSchemaBytes?: number;
  maxSchemaDepth?: number;
}

const Ajv = AjvModule as unknown as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => { compile(schema: unknown): ValidateFunction };

function inspectSchema(
  value: unknown,
  depth: number,
  maxDepth: number
): string | null {
  if (depth > maxDepth) return "schema exceeds maximum depth";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const issue = inspectSchema(entry, depth + 1, maxDepth);
      if (issue) return issue;
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (
        key === "$ref" &&
        (typeof entry !== "string" || !entry.startsWith("#"))
      )
        return "remote or registry-crossing $ref is forbidden";
      const issue = inspectSchema(entry, depth + 1, maxDepth);
      if (issue) return issue;
    }
  }
  return null;
}

export async function checkJsonSchema(
  policy: JsonSchemaCheckV1,
  result: unknown,
  context: JsonSchemaContext
): Promise<VerificationCheckResult> {
  const schema = context.schemas.get(policy.schema_ref);
  if (!schema)
    return fail(policy.type, "schema_ref is not in the local registry");
  try {
    const encoded = JSON.stringify(schema);
    if (Buffer.byteLength(encoded, "utf8") > (context.maxSchemaBytes ?? 65_536))
      return fail(policy.type, "schema exceeds maximum size");
    const issue = inspectSchema(schema, 0, context.maxSchemaDepth ?? 32);
    if (issue) return fail(policy.type, issue);
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    if (validate(result))
      return pass(policy.type, "result matches local schema");
    const errors = (validate.errors ?? [])
      .map(
        (error: ErrorObject) =>
          `${error.instancePath}|${error.keyword}|${error.schemaPath}`
      )
      .sort();
    return fail(policy.type, "result does not match local schema", { errors });
  } catch {
    return fail(policy.type, "local schema is invalid");
  }
}
