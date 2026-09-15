use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
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

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    Settled,
    Refunded,
}

#[account]
#[derive(InitSpace)]
pub struct NullifierRecord {
    pub nullifier: [u8; 32],
    pub task_id: u64,
    pub settled_at: i64,
    pub bump: u8,
}