import { describe, expect, it } from "vitest";
import { deriveSampleIndices } from "../../src/verification/level2/source-sampling.js";
import {
  isPublicAddress,
  SourceClient,
} from "../../src/verification/level2/source-client.js";

describe("post-result source challenge", () => {
  it("replays the persisted seed with unique bounded indices", () => {
    const indices = deriveSampleIndices(
      "ab".repeat(32),
      "cd".repeat(32),
      100,
      15
    );
    expect(
      deriveSampleIndices("ab".repeat(32), "cd".repeat(32), 100, 15)
    ).toEqual(indices);
    expect(new Set(indices).size).toBe(15);
    expect(
      indices.every((i) => Number.isSafeInteger(i) && i >= 0 && i < 100)
    ).toBe(true);
    expect(
      deriveSampleIndices("ef".repeat(32), "cd".repeat(32), 100, 15)
    ).not.toEqual(indices);
  });
  it.each([
    ["bad", 10, 2],
    ["ab".repeat(32), 0, 1],
    ["ab".repeat(32), 5, 6],
    ["ab".repeat(32), 5, 1.5],
  ])("rejects malformed sampling inputs", (seed, total, count) => {
    expect(() =>
      deriveSampleIndices(
        seed as string,
        "cd".repeat(32),
        total as number,
        count as number
      )
    ).toThrow();
  });
});

describe("production source SSRF boundary", () => {
  it.each([
    "127.0.0.1",
    "127.8.9.10",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "224.0.0.1",
  ])("blocks %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])(
    "permits public unicast %s",
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    }
  );
  it.each([
    "http://example.com",
    "file:///etc/passwd",
    "ftp://example.com",
    "gopher://example.com",
    "https://user:pass@example.com",
    "https://localhost",
    "https://2130706433",
    "https://0x7f000001",
    "https://[::ffff:127.0.0.1]",
  ])("rejects hostile URL %s", async (url) => {
    await expect(
      new SourceClient().retrieve(url, [
        "example.com",
        "localhost",
        "127.0.0.1",
        "[::ffff:7f00:1]",
      ])
    ).rejects.toThrow();
  });
  it("denies all hosts without a policy allowlist", async () => {
    await expect(
      new SourceClient().retrieve("https://example.com", [])
    ).rejects.toThrow();
  });
  it("blocks private DNS answers", async () => {
    const client = new SourceClient({}, async () => [
      { address: "10.1.2.3", family: 4 },
    ]);
    await expect(
      client.retrieve("https://example.com", ["example.com"])
    ).rejects.toThrow("address");
  });
});
