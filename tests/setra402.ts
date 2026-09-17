import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Setra402 } from "../target/types/setra402";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("setra402-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Setra402 as Program<Setra402>;

  let mint: PublicKey;
  let buyerTokenAccount: PublicKey;
  let sellerTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;

  const buyer = Keypair.generate();
  const seller = Keypair.generate();
  const verifier = Keypair.generate();
  const treasury = Keypair.generate();

  const TASK_AMOUNT = new anchor.BN(1_000_000); // 1.00 token (6 decimals)
  const TIMEOUT_SECONDS = new anchor.BN(60);

  before(async () => {
    for (const actor of [buyer, seller, verifier, treasury]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    mint = await createMint(
      provider.connection,
      buyer,
      buyer.publicKey,
      null,
      6
    );

    buyerTokenAccount = await createAccount(
      provider.connection,
      buyer,
      mint,
      buyer.publicKey
    );
    sellerTokenAccount = await createAccount(
      provider.connection,
      buyer,
      mint,
      seller.publicKey
    );
    treasuryTokenAccount = await createAccount(
      provider.connection,
      buyer,
      mint,
      treasury.publicKey
    );

    await mintTo(
      provider.connection,
      buyer,
      mint,
      buyerTokenAccount,
      buyer,
      100_000_000
    );
  });

  function getTaskPda(buyerKey: PublicKey, taskId: anchor.BN) {
    const idBuffer = Buffer.alloc(8);
    idBuffer.writeBigUInt64LE(BigInt(taskId.toString()));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("task"), buyerKey.toBuffer(), idBuffer],
      program.programId
    );
  }

  function getVaultPda(taskPda: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), taskPda.toBuffer()],
      program.programId
    );
  }

  function getNullifierPda(nullifier: Buffer) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), nullifier],
      program.programId
    );
  }

  it("Scenario 1: Settle Task (99% Seller / 1% Protocol Treasury)", async () => {
    const taskId = new anchor.BN(1);
    const [taskState] = getTaskPda(buyer.publicKey, taskId);
    const [vault] = getVaultPda(taskState);

    await program.methods
      .initializeTask(taskId, TASK_AMOUNT, TIMEOUT_SECONDS, false)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        taskState,
        vault,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    await program.methods
      .settleTask()
      .accounts({
        taskState,
        verifier: verifier.publicKey,
        vault,
        sellerTokenAccount,
        protocolTreasury: treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([verifier])
      .rpc();

    const state = await program.account.taskState.fetch(taskState);
    expect(state.status).to.deep.equal({ settled: {} });
  });

  it("Scenario 2: Voluntary Cancel (95% Buyer Refund / 5% Protocol Penalty)", async () => {
    const taskId = new anchor.BN(2);
    const [taskState] = getTaskPda(buyer.publicKey, taskId);
    const [vault] = getVaultPda(taskState);

    await program.methods
      .initializeTask(taskId, TASK_AMOUNT, TIMEOUT_SECONDS, false)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        taskState,
        vault,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    await program.methods
      .cancelTask()
      .accounts({
        taskState,
        buyer: buyer.publicKey,
        vault,
        buyerTokenAccount,
        protocolTreasury: treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const state = await program.account.taskState.fetch(taskState);
    expect(state.status).to.deep.equal({ refunded: {} });
  });

  it("Scenario 3: Private Settlement with Nullifier Record", async () => {
    const taskId = new anchor.BN(3);
    const [taskState] = getTaskPda(buyer.publicKey, taskId);
    const [vault] = getVaultPda(taskState);
    const nullifier = Buffer.alloc(32, 42);
    const [nullifierRecord] = getNullifierPda(nullifier);

    await program.methods
      .initializeTask(taskId, TASK_AMOUNT, TIMEOUT_SECONDS, true)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        taskState,
        vault,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    await program.methods
      .settleTaskPrivate(Array.from(nullifier))
      .accounts({
        taskState,
        verifier: verifier.publicKey,
        nullifierRecord,
        vault,
        sellerTokenAccount,
        protocolTreasury: treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([verifier])
      .rpc();

    const record = await program.account.nullifierRecord.fetch(nullifierRecord);
    expect(record.taskId.toNumber()).to.equal(3);
  });

  it("Scenario 4: Expired Refund (100% Refund to Buyer after Timeout)", async () => {
    const taskId = new anchor.BN(4);
    const shortTimeout = new anchor.BN(2); // 2 seconds
    const [taskState] = getTaskPda(buyer.publicKey, taskId);
    const [vault] = getVaultPda(taskState);

    await program.methods
      .initializeTask(taskId, TASK_AMOUNT, shortTimeout, false)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        taskState,
        vault,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    // Wait 3 seconds for on-chain deadline to pass
    await new Promise((resolve) => setTimeout(resolve, 3000));

    await program.methods
      .refundTask()
      .accounts({
        taskState,
        buyer: buyer.publicKey,
        vault,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const state = await program.account.taskState.fetch(taskState);
    expect(state.status).to.deep.equal({ refunded: {} });
  });
});