import { z } from "zod";
import { protectedCallSchema, protectedInputSchema } from "./contracts.js";
import type { ToolHandler } from "./protocol.js";

export class SellerMcpAdapter implements ToolHandler {
  readonly tools = [
    {
      name: "discover_services",
      description:
        "Discover services from the authoritative Setra seller registry",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: "protected_call",
      description:
        "Get a payment quote or retrieve the funded task result. Verification and settlement remain in the buyer core.",
      inputSchema: protectedInputSchema,
    },
  ];
  constructor(
    private readonly sellerUrl: string,
    private readonly timeoutMs = 10_000
  ) {}
  async call(name: string, args: unknown) {
    if (name === "discover_services") {
      z.object({}).strict().parse(args);
      const response = await fetch(`${this.sellerUrl}/services`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error("registry unavailable");
      const services = (await response.json()) as { exposure?: string }[];
      return {
        services: services.filter(
          (s) =>
            s.exposure === undefined ||
            s.exposure === "both" ||
            s.exposure === "mcp"
        ),
      };
    }
    if (name !== "protected_call") throw new Error("unknown tool");
    const input = protectedCallSchema.parse(args);
    const response = await fetch(`${this.sellerUrl}/tasks/${input.task_id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "setra-transport": "mcp" },
      body: JSON.stringify({
        buyer: input.buyer,
        service_id: input.service_id,
        is_private: input.is_private,
        input: input.input,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json();
    return {
      setra402: {
        status:
          response.status === 402
            ? "payment_required"
            : response.ok
            ? "completed"
            : response.status === 410
            ? "refund_available"
            : "failed",
        http_status: response.status,
        ...(response.status === 402
          ? { quote: body }
          : response.ok
          ? { result: body }
          : { error: body }),
      },
    };
  }
}
