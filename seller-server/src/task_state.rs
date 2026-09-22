//! Re-exports shared types from task-anchor-types workspace crate
//! This eliminates manual byte-offset decoding and uses the official Anchor types

/* The shared crate uses official BorshDeserialize which:

- Automatically handles structural changes
- Ensures type consistency
- Provides serialization guarantees                      */


pub use task_anchor_types::{TaskState, TaskStatus, NullifierRecord};

// PDA seeds that aren't in the shared crate
pub const TASK_SEED: &[u8] = b"task";
pub const VAULT_SEED: &[u8] = b"vault";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";

use borsh::de::BorshDeserialize;

/// Decodes Anchor-serialized TaskState using the shared crate's deserializer
pub fn try_from_account_data(data: &[u8]) -> Result<TaskState, DecodeError> {
    // Skip 8-byte Anchor discriminator
    let body = data.get(8..).ok_or(DecodeError::TooShort)?;
    
    // Use shared crate's AnchorDeserialize (BorshDeserialize)
    TaskState::try_from_slice(body).map_err(|_| DecodeError::Corrupt)
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DecodeError {
    #[error("account data too short to contain a TaskState")]
    TooShort,
    #[error("corrupt task state data")]
    Corrupt,
}
