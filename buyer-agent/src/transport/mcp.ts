import { ResultUnavailable, TaskConflict, mapHttpFailure } from "../errors.js";
import { protectedCallSchema } from "../mcp/contracts.js";
import type {
  FundedTaskContext,
  LegacyTaskQuoteWire,
  RequestContext,
} from "../types.js";
import { normalizeResult, type RetryOptions } from "./rest-x402.js";
import type { QuoteNormalizer, SetraTransport } from "./types.js";

export class McpTransport implements SetraTransport {
  private nextId = 1;
  constructor(
    private readonly endpoint: string,
    private readonly normalizeQuote: QuoteNormalizer,
    private readonly retry: RetryOptions = {
      maxAttempts: 3,
      baseDelayMs: 100,
      requestTimeoutMs: 10_000,
    }
  ) {
    if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1)
      throw new RangeError("maxAttempts must be positive");
  }
  async discoverServices() {
    return await this.tool("discover_services", {});
  }
  async requestQuote(context: RequestContext) {
    const state = await this.protectedCall(context);
    if (state.http_status === 402)
      return this.normalizeQuote(state.quote as LegacyTaskQuoteWire, context);
    if (state.http_status === 200)
      throw new TaskConflict("result returned before quote negotiation");
    throw mapHttpFailure(Number(state.http_status), state.error, this.endpoint);
  }
  async executeFundedTask(context: FundedTaskContext) {
    const state = await this.protectedCall(context);
    if (state.http_status === 200) return normalizeResult(state.result);
    throw mapHttpFailure(Number(state.http_status), state.error, this.endpoint);
  }
  private async protectedCall(context: RequestContext) {
    const args = protectedCallSchema.parse({
      task_id: context.taskId.toString(),
      buyer: context.buyer,
      service_id: context.serviceId ?? "legacy-rest",
      is_private: context.isPrivate,
      input: context.input,
    });
    const body = (await this.tool("protected_call", args)) as {
      setra402?: Record<string, unknown>;
    };
    if (!body?.setra402 || !Number.isInteger(body.setra402.http_status))
      throw new ResultUnavailable("malformed MCP protected response");
    return body.setra402;
  }
  private async tool(name: string, args: unknown): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
      try {
        const id = this.nextId++;
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
          signal: AbortSignal.timeout(this.retry.requestTimeoutMs ?? 10_000),
        });
        if (!response.ok)
          throw mapHttpFailure(
            response.status,
            await response.text(),
            this.endpoint
          );
        const rpc = (await response.json()) as {
          id?: unknown;
          jsonrpc?: unknown;
          error?: unknown;
          result?: {
            isError?: boolean;
            content?: { type: string; text?: string }[];
          };
        };
        if (
          rpc.id !== id ||
          rpc.jsonrpc !== "2.0" ||
          rpc.error ||
          rpc.result?.isError ||
          rpc.result?.content?.[0]?.type !== "text" ||
          typeof rpc.result.content[0].text !== "string"
        )
          throw new ResultUnavailable(
            "MCP tool request rejected or response malformed"
          );
        return JSON.parse(rpc.result.content[0].text);
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < this.retry.maxAttempts)
        await new Promise((resolve) =>
          setTimeout(resolve, this.retry.baseDelayMs * 2 ** attempt)
        );
    }
    throw lastError;
  }
}
