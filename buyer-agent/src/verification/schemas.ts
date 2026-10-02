export const DEFAULT_SCHEMA_REGISTRY = new Map<string, unknown>([
  [
    "generic-object-v1",
    {
      type: "object",
    },
  ],
  [
    "lead-list-v1",
    {
      type: "object",
      required: ["records", "generated_at_unix"],
      properties: {
        records: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "company", "email"],
            properties: {
              name: { type: "string", minLength: 1 },
              company: { type: "string", minLength: 1 },
              email: { type: "string", minLength: 3 },
            },
            additionalProperties: false,
          },
        },
        generated_at_unix: { type: "integer" },
      },
      additionalProperties: false,
    },
  ],
]);
