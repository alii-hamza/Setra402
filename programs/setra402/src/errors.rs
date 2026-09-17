use anchor_lang::prelude::*;

#[error_code]
pub enum SetraError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Timeout must be greater than zero")]
    InvalidTimeout,
    #[msg("Calculation overflowed")]
    Overflow,
    #[msg("Task is not in Pending status")]
    TaskNotPending,
    #[msg("Task deadline has not passed yet")]
    TaskNotExpired,
    #[msg("Task deadline has already passed")]
    TaskExpired,
    #[msg("Signer is not the designated verifier")]
    InvalidVerifier,
    #[msg("Nullifier has already been spent")]
    NullifierAlreadySpent,
    #[msg("Invalid Chaumian proof verification")]
    InvalidProof,
}