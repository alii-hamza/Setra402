import { z } from "zod";
import { protectedCallSchema, protectedInputSchema } from "./contracts.js";
import type { ToolHandler } from "./protocol.js";
import type { ProtectedTaskController } from "../core/task-controller.js";
import { SellerMcpAdapter } from "./seller-adapter.js";

export class CoreMcpTools implements ToolHandler {
  readonly tools = [
    {
      name: "discover_services",
      description:
        "Discover available protected services with pricing, verification policies, and capability metadata. Returns services that can be called with payment protection via escrow and verification.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    ...["protected_call", "fund_task", "task_status", "refund_task"].map(
      (name) => ({
        name,
        description: (
          {
            protected_call:
              "Execute a service with payment protection via escrow and verification. Payment is held in escrow until verification passes. If verification fails, payment is refunded. Use this when you need guarantees that a service will deliver as promised or your payment will be returned. Note: Unknown outcomes (UNKNOWN_EXTERNAL_EFFECT) require manual investigation - do NOT blindly retry.",
            fund_task:
              "Add funds to an existing task using the configured local buyer signer. Funding is explicit - services cannot automatically debit more funds. Must occur before task execution completes.",
            task_status:
              "Check the status and outcome of a task. Returns execution state, verification result, and settlement status. Task outcomes: 'settled' (payment released), 'verification_failed' (refund available), 'unknown' (requires investigation). Unknown outcomes indicate provider ambiguity - consult operator before retrying.",
            refund_task:
              "Request refund for a failed or expired task through the shared coordinator. Refunds are only available when verification fails or the task expires without completion. Manual refund requests are rejected if task is still active or already settled.",
          } as Record<string, string>
        )[name]!,
        inputSchema: protectedInputSchema,
      })
    ),
  ];
  constructor(
    private readonly controller: ProtectedTaskController,
    private readonly sellerUrl: string,
    private readonly buyer: string
  ) { }
  async call(name: string, args: unknown) {
    if (name === "discover_services") {
      z.object({}).strict().parse(args);
      return new SellerMcpAdapter(this.sellerUrl).call(name, args);
    }
    const input = protectedCallSchema.parse(args);
    if (input.buyer !== this.buyer)
      throw new Error("buyer does not match configured signer");
    const call = { ...input, transport: "MCP" };
    if (name === "protected_call") return this.controller.protectedCall(call);
    if (name === "fund_task") return this.controller.fund(call);
    if (name === "task_status") return this.controller.status(call);
    if (name === "refund_task") return this.controller.refund(call);
    throw new Error("unknown tool");
  }
}
