import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

export interface CreateTaskParams {
  buyer: Keypair;
  seller: PublicKey;
  verifier: PublicKey;
  mint: PublicKey;
  buyerTokenAccount: PublicKey;
  taskId: bigint;
  amount: number | bigint;
  timeoutSeconds: number;
  isPrivate?: boolean;
}

export class SetraClient {
  public program: Program;

  constructor(idl: Idl, provider: anchor.AnchorProvider) {
    this.program = new Program(idl, provider);
  }

  public getTaskPda(buyer: PublicKey, taskId: bigint): [PublicKey, number] {
    const idBuffer = Buffer.alloc(8);
    idBuffer.writeBigUInt64LE(taskId);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("task"), buyer.toBuffer(), idBuffer],
      this.program.programId
    );
  }

  public getVaultPda(taskPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), taskPda.toBuffer()],
      this.program.programId
    );
  }

  public getNullifierPda(nullifier: Buffer | Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), Buffer.from(nullifier)],
      this.program.programId
    );
  }

  public async createTask(params: CreateTaskParams): Promise<string> {
    const [taskState] = this.getTaskPda(params.buyer.publicKey, params.taskId);
    const [vault] = this.getVaultPda(taskState);

    return await this.program.methods
      .initializeTask(
        new anchor.BN(params.taskId.toString()),
        new anchor.BN(params.amount.toString()),
        new anchor.BN(params.timeoutSeconds),
        params.isPrivate ?? false
      )
      .accounts({
        buyer: params.buyer.publicKey,
        seller: params.seller,
        verifier: params.verifier,
        mint: params.mint,
        taskState,
        vault,
        buyerTokenAccount: params.buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([params.buyer])
      .rpc();
  }

  public async settleTask(
    verifier: Keypair,
    taskState: PublicKey,
    vault: PublicKey,
    sellerTokenAccount: PublicKey,
    treasuryTokenAccount: PublicKey
  ): Promise<string> {
    return await this.program.methods
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
  }

  public async settleTaskPrivate(
    verifier: Keypair,
    taskState: PublicKey,
    vault: PublicKey,
    sellerTokenAccount: PublicKey,
    treasuryTokenAccount: PublicKey,
    nullifier: Uint8Array
  ): Promise<string> {
    const [nullifierRecord] = this.getNullifierPda(nullifier);

    return await this.program.methods
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
  }

  public async cancelTask(
    buyer: Keypair,
    taskState: PublicKey,
    vault: PublicKey,
    buyerTokenAccount: PublicKey,
    treasuryTokenAccount: PublicKey
  ): Promise<string> {
    return await this.program.methods
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
  }

  public async refundTask(
    buyer: Keypair,
    taskState: PublicKey,
    vault: PublicKey,
    buyerTokenAccount: PublicKey
  ): Promise<string> {
    return await this.program.methods
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
  }
}