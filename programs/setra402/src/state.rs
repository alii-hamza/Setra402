use anchor_lang::prelude::*;

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum TaskStatus {
    Pending = 0,
    Settled = 1,
    Refunded = 2,
}

impl TaskStatus {
    pub fn from_u8(val: u8) -> Option<Self> {
        match val {
            0 => Some(TaskStatus::Pending),
            1 => Some(TaskStatus::Settled),
            2 => Some(TaskStatus::Refunded),
            _ => None,
        }
    }
}

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

#[account]
#[derive(InitSpace)]
pub struct NullifierRecord {
    pub nullifier: [u8; 32],
    pub task_id: u64,
    pub settled_at: i64,
    pub bump: u8,
}