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
import { randomBytes } from "node:crypto";

describe("setra402-escrow", () => {
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com", "confirmed"
  );
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const key = JSON.parse(fs.readFileSync(
    path.join(os.homedir(), ".config/solana/id.json"), "utf8"
  ));
  const payer = Keypair.fromSecretKey(Uint8Array.from(key));
  const provider = new anchor.AnchorProvider(
    connection, new anchor.Wallet(payer), { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const idl = require("../target/idl/setra402.json");
  const program = new Program<Setra402>(idl, provider);
  if (program.programId.toBase58() !== "DHyQV6Khe42Papqad63dqkMHxqiKAUMcE4bugiHpZYtb") {
    throw new Error("WRONG PROGRAM ID: refusing to run Devnet tests");
  }
  console.log("DEVNET PROGRAM:", program.programId.toBase58());

  let mint: PublicKey;
  let buyerTokenAccount: PublicKey;
  let sellerTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;

  const buyer = payer;
  const seller = Keypair.generate();
  const verifier = payer;
  const treasury = Keypair.generate();

  const TASK_AMOUNT = new anchor.BN(1_000_000);
  const TIMEOUT_SECONDS = new anchor.BN(900);
  const runId = Math.floor(Date.now() / 1000);

  before(async () => {
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

    const [treasuryAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_authority")],
      program.programId
    );

    treasuryTokenAccount = await createAccount(
      provider.connection,
      buyer,
      mint,
      treasuryAuthority,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID,
      true
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


  it("Scenario 6: Unauthorized Verifier Must Be Rejected", async () => {
    const attacker = Keypair.generate();

    const fundingTx = await provider.connection.sendTransaction(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: buyer.publicKey,
          toPubkey: attacker.publicKey,
          lamports: 10_000_000,
        })
      ),
      [buyer]
    );
    await provider.connection.confirmTransaction(fundingTx, "confirmed");
    const taskId = new anchor.BN(runId + 60);
    const [taskState] = getTaskPda(buyer.publicKey, taskId);
    const [vault] = getVaultPda(taskState);
    const nullifier = randomBytes(32);
    const [nullifierRecord] = getNullifierPda(nullifier);

    await program.methods
      .initializeTask(taskId, TASK_AMOUNT, TIMEOUT_SECONDS, true)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        protocolTreasury: treasuryTokenAccount,
        taskState,
        vault,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const vaultBefore = await provider.connection.getTokenAccountBalance(vault);
    const sellerBefore = await provider.connection.getTokenAccountBalance(sellerTokenAccount);
    const treasuryBefore = await provider.connection.getTokenAccountBalance(treasuryTokenAccount);

    let rejectedForCorrectReason = false;

    try {
      await program.methods
        .settleTaskPrivate(Array.from(nullifier))
        .accounts({
          taskState,
          verifier: attacker.publicKey,
          nullifierRecord,
          vault,
          sellerTokenAccount,
          protocolTreasury: treasuryTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .transaction()
        .then(async tx => {
          tx.feePayer = buyer.publicKey;
          const latest = await provider.connection.getLatestBlockhash();
          tx.recentBlockhash = latest.blockhash;
          tx.partialSign(attacker);
          tx.partialSign(buyer);
          return provider.connection.simulateTransaction(tx);
        })
        .then(result => {
          const logs = (result.value.logs || []).join("\\n");
          if (!result.value.err) {
            throw new Error("SECURITY FAILURE: unauthorized verifier accepted");
          }
          if (!logs.includes("InvalidVerifier") &&
              !logs.includes("Signer is not the designated verifier") &&
              !logs.includes("ConstraintHasOne")) {
            throw new Error("UNEXPECTED REJECTION: " + logs);
          }
          rejectedForCorrectReason = true;
          console.log("EXPECTED_UNAUTHORIZED_REJECTION:", logs.slice(-700));
        });
    } catch (err: any) {
      throw new Error("Scenario 6 failed: " + String(err?.message ?? err));
    }

    expect(rejectedForCorrectReason).to.equal(true);

    const state = await program.account.taskState.fetch(taskState);
    expect(state.status).to.deep.equal({ pending: {} });

    const vaultAfter = await provider.connection.getTokenAccountBalance(vault);
    const sellerAfter = await provider.connection.getTokenAccountBalance(sellerTokenAccount);
    const treasuryAfter = await provider.connection.getTokenAccountBalance(treasuryTokenAccount);

    expect(vaultAfter.value.amount).to.equal(vaultBefore.value.amount);
    expect(sellerAfter.value.amount).to.equal(sellerBefore.value.amount);
    expect(treasuryAfter.value.amount).to.equal(treasuryBefore.value.amount);

    const record = await provider.connection.getAccountInfo(nullifierRecord);
    expect(record).to.equal(null);

    console.log("PASS: Unauthorized verifier rejected; escrow and balances unchanged");
  });

  it("Scenario 1: Settle Task (99% Seller / 1% Protocol Treasury)", async () => {
    const taskId = new anchor.BN(runId + 1);
    const [taskState] = getTaskPda(buyer.publicKey, taskId);
    const [vault] = getVaultPda(taskState);

    await program.methods
      .initializeTask(taskId, TASK_AMOUNT, TIMEOUT_SECONDS, false)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        protocolTreasury: treasuryTokenAccount,
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
    const taskId = new anchor.BN(runId + 2);
    const [taskState] = getTaskPda(buyer.publicKey, taskId);
    const [vault] = getVaultPda(taskState);

    await program.methods
      .initializeTask(taskId, TASK_AMOUNT, TIMEOUT_SECONDS, false)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        protocolTreasury: treasuryTokenAccount,
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
    const taskId = new anchor.BN(runId + 3);
    const [taskState] = getTaskPda(buyer.publicKey, taskId);
    const [vault] = getVaultPda(taskState);

    const nullifier = randomBytes(32);
    const [nullifierRecord] = getNullifierPda(nullifier);

    await program.methods
      .initializeTask(taskId, TASK_AMOUNT, TIMEOUT_SECONDS, true)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        protocolTreasury: treasuryTokenAccount,
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

    const record = await program.account.nullifierRecord.fetch(
      nullifierRecord
    );

    expect(record.taskId.toString()).to.equal(taskId.toString());
  });

  it("Scenario 4: Expired Refund (100% Refund to Buyer after Timeout)", async () => {
    const taskId = new anchor.BN(runId + 4);
    const shortTimeout = new anchor.BN(2);

    const [taskState] = getTaskPda(buyer.publicKey, taskId);
    const [vault] = getVaultPda(taskState);

    await program.methods
      .initializeTask(taskId, TASK_AMOUNT, shortTimeout, false)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        protocolTreasury: treasuryTokenAccount,
        taskState,
        vault,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

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

  it("Scenario 5: Double-Spend Rejection (Same Nullifier Cannot Settle Twice)", async () => {
    const taskId5A = new anchor.BN(runId + 5);
    const taskId5B = new anchor.BN(runId + 6);

    const sharedNullifier = randomBytes(32);
    const [nullifierRecord] = getNullifierPda(sharedNullifier);

    const [taskStateA] = getTaskPda(buyer.publicKey, taskId5A);
    const [vaultA] = getVaultPda(taskStateA);

    await program.methods
      .initializeTask(taskId5A, TASK_AMOUNT, TIMEOUT_SECONDS, true)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        protocolTreasury: treasuryTokenAccount,
        taskState: taskStateA,
        vault: vaultA,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    await program.methods
      .settleTaskPrivate(Array.from(sharedNullifier))
      .accounts({
        taskState: taskStateA,
        verifier: verifier.publicKey,
        nullifierRecord,
        vault: vaultA,
        sellerTokenAccount,
        protocolTreasury: treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([verifier])
      .rpc();

    const [taskStateB] = getTaskPda(buyer.publicKey, taskId5B);
    const [vaultB] = getVaultPda(taskStateB);

    await program.methods
      .initializeTask(taskId5B, TASK_AMOUNT, TIMEOUT_SECONDS, true)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        verifier: verifier.publicKey,
        mint,
        protocolTreasury: treasuryTokenAccount,
        taskState: taskStateB,
        vault: vaultB,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    let replayRejected = false;
    try {
      await program.methods
        .settleTaskPrivate(Array.from(sharedNullifier))
        .accounts({
          taskState: taskStateB,
          verifier: verifier.publicKey,
          nullifierRecord,
          vault: vaultB,
          sellerTokenAccount,
          protocolTreasury: treasuryTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([verifier])
        .rpc();

      throw new Error("SECURITY FAILURE: duplicate nullifier was accepted");
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (message.includes("SECURITY FAILURE")) throw err;
      if (!/already in use|already initialized|AccountAlreadyInitialized|custom program error: 0x0/i.test(message)) {
        throw err;
      }
      replayRejected = true;
      console.log("EXPECTED_REPLAY_REJECTION:", message.slice(0, 500));
    }

    expect(replayRejected).to.equal(true);
    const secondTask = await program.account.taskState.fetch(taskStateB);
    expect(secondTask.status).to.deep.equal({ pending: {} });
    console.log("PASS: Duplicate nullifier rejected; second task remains pending");
  });
});