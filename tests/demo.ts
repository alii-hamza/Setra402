import * as anchor from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import { expect } from "chai";
import idl from "../target/idl/setra402.json";
import { SetraClient } from "../sdk/src/client";
import { FacilitatorAgent } from "../facilitator/src/agent";

describe("Phase 4: Client SDK & Autonomous Facilitator Demo", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const client = new SetraClient(idl as anchor.Idl, provider);

  const buyer = Keypair.generate();
  const seller = Keypair.generate();
  const verifier = Keypair.generate();
  const treasury = Keypair.generate();

  let mint: anchor.web3.PublicKey;
  let buyerAta: anchor.web3.PublicKey;
  let sellerAta: anchor.web3.PublicKey;
  let treasuryAta: anchor.web3.PublicKey;

  before(async () => {
    for (const actor of [buyer, seller, verifier, treasury]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    mint = await createMint(provider.connection, buyer, buyer.publicKey, null, 6);
    buyerAta = await createAccount(provider.connection, buyer, mint, buyer.publicKey);
    sellerAta = await createAccount(provider.connection, buyer, mint, seller.publicKey);
    treasuryAta = await createAccount(provider.connection, buyer, mint, treasury.publicKey);

    await mintTo(provider.connection, buyer, mint, buyerAta, buyer, 50_000_000);
  });

  it("Executes end-to-end: SDK task lock -> Agent verification -> Settlement", async () => {
    const agent = new FacilitatorAgent(client, verifier, treasuryAta);
    const taskId = BigInt(402001);
    const taskInput = { model: "claude-3-5-sonnet", prompt: "2+2", temperature: 0 };

    // 1. Buyer locks escrow through SDK
    const [taskState] = client.getTaskPda(buyer.publicKey, taskId);
    const [vault] = client.getVaultPda(taskState);

    console.log("1. Buyer locking 1 USDC escrow via SetraClient...");
    await client.createTask({
      buyer,
      seller: seller.publicKey,
      verifier: verifier.publicKey,
      mint,
      buyerTokenAccount: buyerAta,
      taskId,
      amount: 1_000_000,
      timeoutSeconds: 300,
      isPrivate: false,
    });

    // 2. Simulate worker producing deterministic output
    const workerOutputHash = agent.computeHash(taskInput);

    // 3. Facilitator verifies computation and settles
    console.log("2. Facilitator polling result and verifying output hash...");
    const tx = await agent.verifyAndSettle(
      taskState,
      vault,
      sellerAta,
      taskInput,
      workerOutputHash
    );

    expect(tx).to.be.a("string");

    // 4. Verify on-chain state
    const state: any = await client.program.account.taskState.fetch(taskState);
    expect(state.status).to.deep.equal({ settled: {} });
    console.log("3. Escrow settled successfully. Status:", state.status);
  });
});