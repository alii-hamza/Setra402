import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { DurableJournal } from "../../src/core/journal.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { createBlindMaterial } from "../../src/privacy/legacy-chaumian.js";
import { inspectVoucherRecovery } from "../../src/privacy/voucher-recovery.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "setra4a4-"));
  const sellerUrl = "https://seller.example";
  const buyer = "buyer-fixture";
  const taskId = 35n;
  const stem = hashCanonical({
    seller: sellerUrl,
    buyer,
    taskId: taskId.toString(),
  });
  const intentPath = join(directory, `${stem}.intent`);
  const responsePath = join(directory, `${stem}.voucher.json`);
  const material = createBlindMaterial({
    nullifierScalar: 11n,
    blindingScalar: 3n,
  });
  const point = ristretto255.Point.fromHex(material.blindedPointHex);
  const response = {
    blind_signature: Buffer.from(point.multiply(7n).toBytes()).toString("hex"),
    mint_pubkey: Buffer.from(
      ristretto255.Point.BASE.multiply(7n).toBytes()
    ).toString("hex"),
  };
  const journal = new DurableJournal();
  const saveIntent = () =>
    journal.publish(intentPath, {
      nullifierScalar: "11",
      blindingScalar: "3",
      blindedPointHex: material.blindedPointHex,
    });
  const saveResponse = () => journal.publish(responsePath, response);
  const evidence = (
    state: "NO_LOCAL_EVIDENCE" | "INTENT_ONLY" | "RESPONSE_PERSISTED",
    overrides: Record<string, unknown> = {}
  ) => ({
    version: "1",
    buyer,
    task_id: "35",
    task_state_pda: "pda-fixture",
    state,
    blinded_point:
      state === "NO_LOCAL_EVIDENCE" ? null : material.blindedPointHex,
    mint_pubkey: state === "NO_LOCAL_EVIDENCE" ? null : response.mint_pubkey,
    blind_signature:
      state === "RESPONSE_PERSISTED" ? response.blind_signature : null,
    current_mint_matches_receipt: state === "NO_LOCAL_EVIDENCE" ? null : true,
    ...overrides,
  });
  const query = (body: unknown, status = 200) => {
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      expect(options?.method).toBe("GET");
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    return {
      fetcher,
      run: () =>
        inspectVoucherRecovery({
          sellerUrl,
          buyer,
          taskId,
          directory,
          fetcher: fetcher as unknown as typeof fetch,
        }),
    };
  };
  return {
    directory,
    intentPath,
    responsePath,
    material,
    response,
    saveIntent,
    saveResponse,
    evidence,
    query,
  };
}

describe("4A.4 private voucher evidence (ACTUAL journals, SIMULATED seller GET)", () => {
  it("recovers exact saved issuance without sending a mutating request or writing", async () => {
    const f = fixture();
    f.saveIntent();
    f.saveResponse();
    const before = [
      readFileSync(f.intentPath, "utf8"),
      readFileSync(f.responsePath, "utf8"),
    ];
    const q = f.query(f.evidence("RESPONSE_PERSISTED"));
    const view = await q.run();
    expect(view.classification).toBe("PROVEN_OCCURRED");
    expect(view.voucher?.mintPubkey).toBe(f.response.mint_pubkey);
    expect(q.fetcher).toHaveBeenCalledTimes(1);
    expect([
      readFileSync(f.intentPath, "utf8"),
      readFileSync(f.responsePath, "utf8"),
    ]).toEqual(before);
  });
  it("keeps an intent-only issuance unknown", async () => {
    const f = fixture();
    f.saveIntent();
    const view = await f.query(f.evidence("INTENT_ONLY")).run();
    expect(view.classification).toBe("UNKNOWN_EXTERNAL_EFFECT");
    expect(view.voucher).toBeUndefined();
  });
  it("recovers lost buyer response only from matching seller receipt", async () => {
    const f = fixture();
    f.saveIntent();
    const view = await f.query(f.evidence("RESPONSE_PERSISTED")).run();
    expect(view.classification).toBe("PROVEN_OCCURRED");
    expect(view.localResponse).toBe("ABSENT");
    expect(view.voucher?.blindSignature).toBe(f.response.blind_signature);
  });
  it("does not infer non-occurrence from a missing seller record or unavailable query", async () => {
    const f = fixture();
    f.saveIntent();
    expect(
      (await f.query(f.evidence("NO_LOCAL_EVIDENCE")).run()).classification
    ).toBe("UNKNOWN_EXTERNAL_EFFECT");
    expect((await f.query({}, 503).run()).classification).toBe(
      "UNKNOWN_EXTERNAL_EFFECT"
    );
  });
  it("fails closed on rotated mint identity, changed blind request, or response conflict", async () => {
    const f = fixture();
    f.saveIntent();
    for (const overrides of [
      { current_mint_matches_receipt: false },
      { blinded_point: "f".repeat(64) },
      { blind_signature: "0".repeat(64) },
      { buyer: "other" },
    ])
      expect(
        (await f.query(f.evidence("RESPONSE_PERSISTED", overrides)).run())
          .classification
      ).toBe("RECONCILIATION_REQUIRED");
  });
  it("fails closed on orphan, corrupted, and unknown-version local journals", async () => {
    const orphan = fixture();
    orphan.saveResponse();
    expect(
      (await orphan.query(orphan.evidence("RESPONSE_PERSISTED")).run())
        .classification
    ).toBe("RECONCILIATION_REQUIRED");
    const corrupt = fixture();
    corrupt.saveIntent();
    writeFileSync(corrupt.intentPath, "{bad");
    expect(
      (await corrupt.query(corrupt.evidence("RESPONSE_PERSISTED")).run())
        .localIntent
    ).toBe("CORRUPT");
    const future = fixture();
    future.saveIntent();
    writeFileSync(
      future.intentPath,
      readFileSync(future.intentPath, "utf8").replace(
        '"version":1',
        '"version":2'
      )
    );
    expect(
      (await future.query(future.evidence("RESPONSE_PERSISTED")).run())
        .classification
    ).toBe("RECONCILIATION_REQUIRED");
  });
});
