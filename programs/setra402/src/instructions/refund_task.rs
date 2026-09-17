use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::errors::SetraError;
use crate::state::*;

#[derive(Accounts)]
pub struct RefundTask<'info> {
    #[account(
        mut,
        has_one = buyer,
        seeds = [TASK_SEED, task_state.buyer.as_ref(), &task_state.task_id.to_le_bytes()],
        bump = task_state.bump
    )]
    pub task_state: Account<'info, TaskState>,

    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, task_state.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = buyer_token_account.owner == task_state.buyer)]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RefundTask>) -> Result<()> {
    let task_state = &mut ctx.accounts.task_state;
    require!(task_state.status == TaskStatus::Pending, SetraError::TaskNotPending);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp >= task_state.deadline_unix, SetraError::TaskNotExpired);

    let amount = task_state.amount;
    let buyer_key = task_state.buyer;
    let task_id_bytes = task_state.task_id.to_le_bytes();
    let bump = [task_state.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        TASK_SEED,
        buyer_key.as_ref(),
        &task_id_bytes,
        &bump,
    ]];

    // 100% Refund to Buyer on expiration
    let cpi_to_buyer = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.buyer_token_account.to_account_info(),
        authority: task_state.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_to_buyer,
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)?;

    task_state.status = TaskStatus::Refunded;
    Ok(())
}