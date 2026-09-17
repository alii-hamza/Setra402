use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::errors::SetraError;
use crate::state::*;

#[derive(Accounts)]
pub struct CancelTask<'info> {
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

    #[account(mut)]
    pub protocol_treasury: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelTask>) -> Result<()> {
    let task_state = &mut ctx.accounts.task_state;
    require!(task_state.status == TaskStatus::Pending, SetraError::TaskNotPending);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < task_state.deadline_unix, SetraError::TaskExpired);

    let amount = task_state.amount;
    let penalty = (amount as u128)
        .checked_mul(CANCEL_PENALTY_BPS as u128)
        .ok_or(SetraError::Overflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(SetraError::Overflow)? as u64;

    let refund_amount = amount.checked_sub(penalty).ok_or(SetraError::Overflow)?;

    let buyer_key = task_state.buyer;
    let task_id_bytes = task_state.task_id.to_le_bytes();
    let bump = [task_state.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        TASK_SEED,
        buyer_key.as_ref(),
        &task_id_bytes,
        &bump,
    ]];

    // 95% Refund to Buyer
    let cpi_to_buyer = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.buyer_token_account.to_account_info(),
        authority: task_state.to_account_info(),
    };
    let cpi_ctx_buyer = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_to_buyer,
        signer_seeds,
    );
    token::transfer(cpi_ctx_buyer, refund_amount)?;

    // 5% Friction Penalty to Treasury
    if penalty > 0 {
        let cpi_to_treasury = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.protocol_treasury.to_account_info(),
            authority: task_state.to_account_info(),
        };
        let cpi_ctx_treasury = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_to_treasury,
            signer_seeds,
        );
        token::transfer(cpi_ctx_treasury, penalty)?;
    }

    task_state.status = TaskStatus::Refunded;
    Ok(())
}