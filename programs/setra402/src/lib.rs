use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

pub use instructions::*;

declare_id!("7dDxB8tm3RgFtJ1UDugM6B5qUa1xitAXdNo7ciuKhYZS");

#[program]
pub mod setra402 {
    use super::*;

    pub fn initialize_task(
        ctx: Context<InitializeTask>,
        task_id: u64,
        amount: u64,
        timeout_seconds: i64,
        is_private: bool,
    ) -> Result<()> {
        instructions::initialize_task::handler(ctx, task_id, amount, timeout_seconds, is_private)
    }

    pub fn settle_task(ctx: Context<SettleTask>) -> Result<()> {
        instructions::settle_task::handler(ctx)
    }

    pub fn settle_task_private(
        ctx: Context<SettleTaskPrivate>,
        nullifier: [u8; 32],
    ) -> Result<()> {
        instructions::settle_task_private::handler(ctx, nullifier)
    }

    pub fn refund_task(ctx: Context<RefundTask>) -> Result<()> {
        instructions::refund_task::handler(ctx)
    }

    pub fn cancel_task(ctx: Context<CancelTask>) -> Result<()> {
        instructions::cancel_task::handler(ctx)
    }
}