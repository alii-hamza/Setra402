import { mkdtemp, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashCanonical } from "../../src/manifest/hash.js";
import { FileChallengeStore } from "../../src/verification/level2/challenge-store.js";
import { SourceClient } from "../../src/verification/level2/source-client.js";
import { checkSourceSampling } from "../../src/verification/level2/source-sampling.js";
import { parseVerificationPolicy } from "../../src/verification/policy.js";
import type { SourceSamplingCheckV1 } from "../../src/types.js";

let origin: string;
let active = 0;
let peak = 0;
const server = createServer((req, res) => {
  const path = req.url ?? "";
  if (path === "/private") {
    res.writeHead(302, { location: "https://10.1.2.3/" });
    res.end();
  } else if (path === "/loop") {
    res.writeHead(302, { location: "/loop" });
    res.end();
  } else if (path.startsWith("/redirect/")) {
    res.writeHead(302, {
      location: `/redirect/${Number(path.split("/").pop()) + 1}`,
    });
    res.end();
  } else if (path === "/large") {
    res.writeHead(200, { "content-length": 10_000 });
    res.end("x".repeat(10_000));
  } else if (path === "/chunked") {
    res.writeHead(200);
    res.write("x".repeat(500));
    res.end("x".repeat(500));
  } else if (path === "/slow") {
    res.writeHead(200);
    res.flushHeaders();
  } else if (path === "/concurrency") {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.end('{"company":"Acme"}');
    }, 25);
  } else res.end('{"company":"Acme","email":"A@EXAMPLE.com"}');
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const policy: SourceSamplingCheckV1 = {
  type: "source_sampling",
  pointer: "/records",
  sample_count: 2,
  source_url_field: "source_url",
  fields: ["company", "email"],
  allowed_domains: ["127.0.0.1"],
  minimum_match_bps: 10_000,
};
const fixtureClient = (limits = {}) =>
  new SourceClient(limits, undefined, [origin]);

describe("bounded independent sources", () => {
  it("permits explicit local test fixture and matches deterministic fields", async () => {
    const challenges = new FileChallengeStore(
      await mkdtemp(join(tmpdir(), "setra-challenges-"))
    );
    const records = Array.from({ length: 5 }, () => ({
      source_url: origin,
      company: "Acme",
      email: "A@EXAMPLE.com",
    }));
    const first = await checkSourceSampling(policy, { records }, "immutable", {
      challenges,
      sourceClient: fixtureClient(),
    });
    expect(first.passed).toBe(true);
    expect(
      await checkSourceSampling(policy, { records }, "immutable", {
        challenges,
        sourceClient: fixtureClient(),
      })
    ).toEqual(first);
    expect(first.details?.challenge_seed).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([
    "field-mismatch",
    "missing-field",
    "missing-url",
    "no-normalization",
  ])("fails sampled record on %s", async (problem) => {
    const record: Record<string, unknown> = {
      source_url: origin,
      company: "Acme",
      email: "A@EXAMPLE.com",
    };
    if (problem === "field-mismatch") record.company = "Other";
    if (problem === "missing-field") delete record.company;
    if (problem === "missing-url") delete record.source_url;
    if (problem === "no-normalization") record.email = "a@example.com";
    const check = await checkSourceSampling(
      { ...policy, sample_count: 1 },
      { records: [record] },
      "immutable",
      {
        challenges: new FileChallengeStore(
          await mkdtemp(join(tmpdir(), "setra-challenges-"))
        ),
        sourceClient: fixtureClient(),
      }
    );
    expect(check.passed).toBe(false);
  });
  it("uses integer BPS and rejects insufficient matches", async () => {
    const challenges = new FileChallengeStore(
      await mkdtemp(join(tmpdir(), "setra-challenges-"))
    );
    const records = [
      { source_url: origin, company: "Acme", email: "A@EXAMPLE.com" },
      { source_url: origin, company: "Other", email: "A@EXAMPLE.com" },
    ];
    const check = await checkSourceSampling(
      { ...policy, minimum_match_bps: 8000 },
      { records },
      "immutable",
      { challenges, sourceClient: fixtureClient() }
    );
    expect(check.passed).toBe(false);
    expect(check.details?.actual_bps).toBe(5000);
    expect(
      (
        await checkSourceSampling(
          { ...policy, minimum_match_bps: 5000 },
          { records },
          "immutable",
          { challenges, sourceClient: fixtureClient() }
        )
      ).passed
    ).toBe(true);
  });
  it("blocks a redirect into a private address", async () => {
    await expect(
      fixtureClient().retrieve(`${origin}/private`, ["127.0.0.1", "10.1.2.3"])
    ).rejects.toThrow("address");
  });
  it.each([
    ["/loop", "loop"],
    ["/redirect/0", "redirects"],
    ["/large", "large"],
    ["/chunked", "large"],
    ["/slow", "read timeout"],
  ])("bounds %s", async (path, message) => {
    await expect(
      fixtureClient({
        maxResponseBytes: 600,
        readTimeoutMs: 100,
        maxRedirects: 2,
      }).retrieve(origin + path, ["127.0.0.1"])
    ).rejects.toThrow(message);
  });
  it("times out TLS connect independently of the read timeout", async () => {
    const sockets: import("node:net").Socket[] = [];
    const listener = createTcpServer((socket) => sockets.push(socket));
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
    const secureOrigin = `https://127.0.0.1:${
      (listener.address() as { port: number }).port
    }`;
    try {
      await expect(
        new SourceClient({ connectTimeoutMs: 100 }, undefined, [
          secureOrigin,
        ]).retrieve(secureOrigin, ["127.0.0.1"])
      ).rejects.toThrow("connect timeout");
    } finally {
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((r) => listener.close(() => r()));
    }
  });
  it("times out stalled DNS", async () => {
    await expect(
      new SourceClient(
        { connectTimeoutMs: 100 },
        async () => new Promise(() => {})
      ).retrieve("https://example.com", ["example.com"])
    ).rejects.toThrow("DNS");
  });
  it("enforces one global concurrency limit across simultaneous requests", async () => {
    peak = 0;
    const client = fixtureClient({ maxSamplingConcurrency: 2 });
    await Promise.all(
      Array.from({ length: 12 }, () =>
        client.retrieve(`${origin}/concurrency`, ["127.0.0.1"])
      )
    );
    expect(peak).toBe(2);
  });
  it("pins the checked DNS answer rather than resolving again for connection", async () => {
    const url = origin.replace("127.0.0.1", "fixture.test");
    const resolver = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const client = new SourceClient({}, resolver, [url]);
    expect(await client.retrieve(url, ["fixture.test"])).toMatchObject({
      company: "Acme",
    });
    expect(resolver).toHaveBeenCalledOnce();
  });
  it("production config cannot enable fixture bypass", () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new SourceClient({}, undefined, [origin])).toThrow(
        "test-only"
      );
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
  it("concurrent persisted challenges never expose a partial seed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "setra-challenges-"));
    const store = new FileChallengeStore(directory);
    const seeds = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.getOrCreate(hashCanonical({ result: 1 }))
      )
    );
    expect(new Set(seeds).size).toBe(1);
    expect(await readdir(directory)).toHaveLength(1);
  });
  it("rejects unknown or uncommitted source semantics", () => {
    for (const extra of [
      { normalize: true },
      { minimum_match_bps: 10001 },
      { sample_count: -1 },
      { allowed_domains: ["*"] },
    ])
      expect(() =>
        parseVerificationPolicy({
          version: "1",
          level: 2,
          checks: [{ ...policy, ...extra }],
        })
      ).toThrow();
  });
});
