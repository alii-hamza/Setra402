//! Mirrors the on-chain `TaskState` account from Role A's Anchor program
//! (architecture doc, Section 3.1: buyer, seller, verifier, mint, task_id,
//! amount, deadline_unix, status, bump — in that order).
//!
//! Role A's actual program isn't part of this deliverable, so this file
//! stands in for the shared `task-anchor-types` crate the architecture doc
//! describes. Once that crate exists, delete this file and depend on it
//! instead (see README) — everything else in this crate only imports
//! `TaskState`/`TaskStatus`/`TASK_SEED`/`VAULT_SEED` from here, so the swap
//! is a one-line change per file.

use solana_pubkey::Pubkey;

pub const TASK_SEED: &[u8] = b"task";
pub const VAULT_SEED: &[u8] = b"vault";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";

/// Anchor prefixes every account with an 8-byte discriminator (a hash of
/// "account:TaskState") before the struct's own fields. We only need its
/// length to skip past it — Role A's program is what writes those bytes,
/// we just need to not misread them as part of `buyer`.
const ANCHOR_DISCRIMINATOR_LEN: usize = 8;
const PUBKEY_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    Settled,
    Refunded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskState {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub verifier: Pubkey,
    pub mint: Pubkey,
    pub task_id: u64,
    pub amount: u64,
    pub deadline_unix: i64,
    pub status: TaskStatus,
    pub is_private: bool,
    pub bump: u8,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DecodeError {
    #[error("account data too short to contain a TaskState")]
    TooShort,
    #[error("unrecognized TaskStatus tag: {0}")]
    UnknownStatus(u8),
}

impl TaskState {
    /// Decodes the fixed-layout bytes Anchor's Borsh serialization produces
    /// for this exact struct shape. Every field is a fixed-width primitive
    /// (no `Vec`/`String`/`Option`, which are the cases where Borsh's
    /// encoding gets variable-length) — that's what makes straight
    /// sequential byte offsets safe here instead of needing a real Borsh
    /// decoder. If Role A ever adds a variable-length field to `TaskState`,
    /// this stops being true and this function needs to change with it.
    pub fn try_from_account_data(data: &[u8]) -> Result<Self, DecodeError> {
        let body = data
            .get(ANCHOR_DISCRIMINATOR_LEN..)
            .ok_or(DecodeError::TooShort)?;

        const FIXED_LEN: usize = PUBKEY_LEN * 4 // buyer, seller, verifier, mint
            + 8  // task_id
            + 8  // amount
            + 8  // deadline_unix
            + 1  // status
            + 1  // is_private
            + 1; // bump
        if body.len() < FIXED_LEN {
            return Err(DecodeError::TooShort);
        }

        let mut offset = 0usize;
        let mut next_pubkey = |body: &[u8]| -> Pubkey {
            let bytes: [u8; PUBKEY_LEN] = body[offset..offset + PUBKEY_LEN]
                .try_into()
                .expect("slice length checked above");
            offset += PUBKEY_LEN;
            Pubkey::from(bytes)
        };
        let buyer = next_pubkey(body);
        let seller = next_pubkey(body);
        let verifier = next_pubkey(body);
        let mint = next_pubkey(body);

        let mut next_u64 = |body: &[u8]| -> u64 {
            let v = u64::from_le_bytes(body[offset..offset + 8].try_into().unwrap());
            offset += 8;
            v
        };
        let task_id = next_u64(body);
        let amount = next_u64(body);
        let deadline_unix = i64::from_le_bytes(body[offset..offset + 8].try_into().unwrap());
        offset += 8;

        let status = match body[offset] {
            0 => TaskStatus::Pending,
            1 => TaskStatus::Settled,
            2 => TaskStatus::Refunded,
            other => return Err(DecodeError::UnknownStatus(other)),
        };
        offset += 1;
        let is_private = body[offset] != 0;
        offset += 1;
        let bump = body[offset];

        Ok(TaskState {
            buyer,
            seller,
            verifier,
            mint,
            task_id,
            amount,
            deadline_unix,
            status,
            is_private,
            bump,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds the exact byte layout Anchor would write, so the decoder can
    /// be tested without a real validator or Role A's program.
    fn encode_for_test(state: &TaskState) -> Vec<u8> {
        let mut bytes = vec![0u8; ANCHOR_DISCRIMINATOR_LEN]; // discriminator content doesn't matter to us
        bytes.extend_from_slice(state.buyer.as_ref());
        bytes.extend_from_slice(state.seller.as_ref());
        bytes.extend_from_slice(state.verifier.as_ref());
        bytes.extend_from_slice(state.mint.as_ref());
        bytes.extend_from_slice(&state.task_id.to_le_bytes());
        bytes.extend_from_slice(&state.amount.to_le_bytes());
        bytes.extend_from_slice(&state.deadline_unix.to_le_bytes());
        bytes.push(match state.status {
            TaskStatus::Pending => 0,
            TaskStatus::Settled => 1,
            TaskStatus::Refunded => 2,
        });
        bytes.push(state.is_private as u8);
        bytes.push(state.bump);
        bytes
    }

    fn sample() -> TaskState {
        TaskState {
            buyer: Pubkey::from([1u8; 32]),
            seller: Pubkey::from([2u8; 32]),
            verifier: Pubkey::from([3u8; 32]),
            mint: Pubkey::from([4u8; 32]),
            task_id: 42,
            amount: 1_500_000,
            deadline_unix: 1_800_000_000,
            status: TaskStatus::Pending,
            is_private: false,
            bump: 253,
        }
    }

    #[test]
    fn round_trips_through_encode_decode() {
        let original = sample();
        let bytes = encode_for_test(&original);
        let decoded = TaskState::try_from_account_data(&bytes).expect("should decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn decodes_each_status_tag() {
        for (tag, expected) in [
            (0u8, TaskStatus::Pending),
            (1u8, TaskStatus::Settled),
            (2u8, TaskStatus::Refunded),
        ] {
            let mut state = sample();
            state.status = expected;
            let bytes = encode_for_test(&state);
            assert_eq!(bytes[8 + 32 * 4 + 8 + 8 + 8], tag);
            let decoded = TaskState::try_from_account_data(&bytes).unwrap();
            assert_eq!(decoded.status, expected);
        }
    }

    #[test]
    fn rejects_truncated_data() {
        let bytes = encode_for_test(&sample());
        let truncated = &bytes[..bytes.len() - 5];
        assert_eq!(
            TaskState::try_from_account_data(truncated),
            Err(DecodeError::TooShort)
        );
    }

    #[test]
    fn rejects_unknown_status_tag() {
        let mut bytes = encode_for_test(&sample());
        let status_offset = ANCHOR_DISCRIMINATOR_LEN + PUBKEY_LEN * 4 + 8 + 8 + 8;
        bytes[status_offset] = 99;
        assert_eq!(
            TaskState::try_from_account_data(&bytes),
            Err(DecodeError::UnknownStatus(99))
        );
    }

    #[test]
    fn decodes_is_private_field() {
        let mut state = sample();
        state.is_private = true;
        let bytes = encode_for_test(&state);
        let decoded = TaskState::try_from_account_data(&bytes).unwrap();
        assert_eq!(decoded.is_private, true);

        state.is_private = false;
        let bytes = encode_for_test(&state);
        let decoded = TaskState::try_from_account_data(&bytes).unwrap();
        assert_eq!(decoded.is_private, false);
    }
}
