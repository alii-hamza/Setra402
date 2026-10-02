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
        "Discover registry services and committed verification policies",
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
              "Get a quote or complete the same funded task through verification and the shared SettlementCoordinator",
            fund_task:
              "Fund the quoted escrow using the configured local buyer signer",
            task_status: "Read real on-chain status and refund eligibility",
            refund_task:
              "Request an eligible timeout refund through the shared coordinator",
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
  ) {}
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
