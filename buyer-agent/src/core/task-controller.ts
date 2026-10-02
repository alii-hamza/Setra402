import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashCanonical } from "../manifest/hash.js";
import { protectedCallSchema, requestContext } from "../mcp/contracts.js";
import { jsonSafe } from "../mcp/protocol.js";
import type { RequestContext, TaskQuote, TaskStateView } from "../types.js";

export const taskCallSchema = protectedCallSchema
  .innerType()
  .extend({ transport: z.enum(["REST", "MCP"]) })
  .superRefine((value, ctx) => {
    const { transport: _transport, ...input } = value;
    const parsed = protectedCallSchema.safeParse(input);
    if (!parsed.success)
      for (const issue of parsed.error.issues) ctx.addIssue(issue);
  });
export type TaskCall = z.infer<typeof taskCallSchema>;
export interface TaskDependencies {
  quote(input: RequestContext, transport: "REST" | "MCP"): Promise<TaskQuote>;
  normalizeQuote(raw: unknown, input: RequestContext): TaskQuote;
  fund(quote: TaskQuote, input: RequestContext): Promise<unknown>;
  run(
    input: RequestContext,
    quote: TaskQuote,
    transport: "REST" | "MCP"
  ): Promise<unknown>;
  state(quote: TaskQuote): Promise<TaskStateView | null>;
  now(): Promise<number>;
  refund(quote: TaskQuote): Promise<string>;
}
// A single local controller owns one configured buyer. Journals hold public
// contracts/reports, never signing keys. Orphan execution intents fail closed.
export class ProtectedTaskController {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly directory: string,
    private readonly deps: TaskDependencies
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private paths(call: TaskCall) {
    const key = hashCanonical({ buyer: call.buyer, task_id: call.task_id });
    return (suffix: string) => join(this.directory, `${key}.${suffix}`);
  }
  private read(path: string): unknown | null {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  private save(path: string, value: unknown) {
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(jsonSafe(value)), {
      mode: 0o600,
      flush: true,
    });
    renameSync(tmp, path);
  }
  private bind(call: TaskCall) {
    const path = this.paths(call)("identity");
    const identity = hashCanonical({
      buyer: call.buyer,
      task_id: call.task_id,
      service_id: call.service_id,
      is_private: call.is_private,
      input: call.input,
    });
    try {
      writeFileSync(path, identity, { flag: "wx", mode: 0o600, flush: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (readFileSync(path, "utf8") !== identity)
      throw new Error(
        "task identity reused with different input, service or privacy"
      );
  }
  private async exclusive(
    call: TaskCall,
    operation: () => Promise<unknown>
  ): Promise<unknown> {
    const key = this.paths(call)("identity");
    const existing = this.pending.get(key);
    if (existing) {
      await existing;
      return this.exclusive(call, operation);
    }
    const promise = operation();
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }
  private async quote(call: TaskCall) {
    const context = requestContext(call),
      path = this.paths(call)("quote.json");
    const raw = this.read(path);
    if (raw) return this.deps.normalizeQuote(raw, context);
    const quote = await this.deps.quote(context, call.transport);
    this.save(path, quote.raw);
    return quote;
  }
  async protectedCall(value: unknown): Promise<unknown> {
    const call = taskCallSchema.parse(value);
    this.bind(call);
    return this.exclusive(call, async () => {
      const path = this.paths(call);
      const saved = this.read(path("result.json"));
      if (saved) return saved;
      const quote = await this.quote(call);
      const state = await this.deps.state(quote);
      if (!state) return { status: "payment_required", quote: jsonSafe(quote) };
      if (state.status !== "pending")
        return {
          status: state.status,
          chainState: jsonSafe(state),
          reconciliationRequired: true,
        };
      if (existsSync(path("run.intent")))
        throw new Error(
          "execution outcome unknown; reconciliation required before retry"
        );
      writeFileSync(path("run.intent"), "claimed", {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      const result = await this.deps.run(
        requestContext(call),
        quote,
        call.transport
      );
      this.save(path("result.json"), result);
      return jsonSafe(result);
    });
  }
  async fund(value: unknown): Promise<unknown> {
    const call = taskCallSchema.parse(value);
    this.bind(call);
    return this.exclusive(call, async () => {
      const quote = await this.quote(call),
        path = this.paths(call);
      const saved = this.read(path("funded.json"));
      if (saved) return saved;
      const state = await this.deps.state(quote);
      if (state && state.status !== "pending")
        throw new Error("task is already terminal");
      if (!state && existsSync(path("fund.intent")))
        throw new Error("funding outcome unknown; reconciliation required");
      if (!existsSync(path("fund.intent")))
        writeFileSync(path("fund.intent"), "claimed", {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      const funded = await this.deps.fund(quote, requestContext(call));
      const result = {
        status: "funded",
        quote: jsonSafe(quote),
        funded: jsonSafe(funded),
      };
      this.save(path("funded.json"), result);
      return result;
    });
  }
  async status(value: unknown): Promise<unknown> {
    const call = taskCallSchema.parse(value);
    this.bind(call);
    const quote = await this.quote(call),
      state = await this.deps.state(quote),
      now = await this.deps.now();
    const saved = this.read(this.paths(call)("result.json"));
    const chainAction =
      state?.status === "settled"
        ? "settled"
        : state?.status === "refunded"
        ? "refunded"
        : state && now >= state.deadlineUnix
        ? "refund_available"
        : state
        ? "awaiting_refund_deadline"
        : "funding_required";
    return {
      status: chainAction,
      chainAction,
      chainState: jsonSafe(state),
      chainUnixTime: now,
      quote: jsonSafe(quote),
      outcome: saved,
    };
  }
  async refund(value: unknown): Promise<unknown> {
    const call = taskCallSchema.parse(value);
    this.bind(call);
    return this.exclusive(call, async () => {
      const quote = await this.quote(call),
        state = await this.deps.state(quote);
      if (state?.status === "refunded") return this.status(call);
      if (
        !state ||
        state.status !== "pending" ||
        (await this.deps.now()) < state.deadlineUnix
      )
        throw new Error("refund is not eligible at the chain deadline");
      const signature = await this.deps.refund(quote);
      return {
        ...((await this.status(call)) as object),
        refundSignature: signature,
      };
    });
  }
}
