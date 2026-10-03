import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Keypair } from "@solana/web3.js";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { describe, it, expect } from "vitest";
import { LegacyChaumianClient } from "../../src/privacy/legacy-chaumian.js";
async function fixture(drop = false) {
  let received = 0;
  const server = createServer(async (req, res) => {
    let bytes = "";
    for await (const chunk of req) bytes += chunk.toString();
    const body = JSON.parse(bytes);
    received++;
    const blinded = ristretto255.Point.fromHex(body.blinded_point);
    const response = {
      blind_signature: Buffer.from(blinded.multiply(7n).toBytes()).toString(
        "hex"
      ),
      mint_pubkey: Buffer.from(
        ristretto255.Point.BASE.multiply(7n).toBytes()
      ).toString("hex"),
    };
    if (drop) {
      res.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = mkdtempSync(join(tmpdir(), "setra35-voucher-"));
  return {
    directory,
    url,
    server,
    received: () => received,
    input: { buyer: Keypair.generate().publicKey.toBase58(), taskId: 35n },
    client: () => new LegacyChaumianClient(url, directory),
  };
}
describe("Phase 3.5 private issuance ambiguity (ACTUAL HTTP/FS, SIMULATED mint)", () => {
  it("lost issuance response prevents automatic creation of a replacement credential", async () => {
    const f = await fixture(true);
    try {
      await expect(f.client().createVoucher(f.input)).rejects.toThrow();
      await expect(f.client().createVoucher(f.input)).rejects.toThrow(
        /reconciliation|unknown/i
      );
      expect(f.received()).toBe(1);
    } finally {
      f.server.closeAllConnections();
      f.server.close();
    }
  });
  it("completed issuance replays the exact same voucher after client restart", async () => {
    const f = await fixture();
    try {
      const first = await f.client().createVoucher(f.input);
      const second = await f.client().createVoucher(f.input);
      expect(second).toEqual(first);
      expect(f.received()).toBe(1);
    } finally {
      f.server.closeAllConnections();
      f.server.close();
    }
  });
});
