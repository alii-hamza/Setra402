import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

function taskIdBytes(taskId: bigint): Buffer {
  if (taskId < 0n || taskId > 0xffff_ffff_ffff_ffffn)
    throw new RangeError("taskId must fit u64");
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(taskId);
  return bytes;
}

export function deriveTaskPda(
  programId: PublicKey,
  buyer: PublicKey,
  taskId: bigint
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), buyer.toBuffer(), taskIdBytes(taskId)],
    programId
  );
}

export function deriveVaultPda(programId: PublicKey, taskState: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), taskState.toBuffer()],
    programId
  );
}

export function deriveNullifierPda(
  programId: PublicKey,
  nullifier: Uint8Array
) {
  if (nullifier.length !== 32)
    throw new RangeError("nullifier must be exactly 32 bytes");
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), Buffer.from(nullifier)],
    programId
  );
}

export function deriveBuyerAta(mint: PublicKey, buyer: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, buyer);
}
