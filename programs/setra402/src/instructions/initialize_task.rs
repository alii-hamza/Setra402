use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::errors::SetraError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(task_id: u64, amount: u64, timeout_seconds: i64, is_private: bool)]
pub struct InitializeTask<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Target seller pubkey recorded in task terms
    pub seller: UncheckedAccount<'info>,

    /// CHECK: Verifier authority authorized to trigger settlement
    pub verifier: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = buyer,
        space = 8 + TaskState::INIT_SPACE,
        seeds = [TASK_SEED, buyer.key().as_ref(), &task_id.to_le_bytes()],
        bump
    )]
    pub task_state: Account<'info, TaskState>,

    #[account(
        init,
        payer = buyer,
        seeds = [VAULT_SEED, task_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = task_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = buyer_token_account.mint == mint.key(),
        constraint = buyer_token_account.owner == buyer.key()
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeTask>,
    task_id: u64,
    amount: u64,
    timeout_seconds: i64,
    is_private: bool,
) -> Result<()> {
    require!(amount > 0, SetraError::InvalidAmount);
    require!(timeout_seconds > 0, SetraError::InvalidTimeout);

    let clock = Clock::get()?;
    let deadline_unix = clock
        .unix_timestamp
        .checked_add(timeout_seconds)
        .ok_or(SetraError::Overflow)?;

    let task_state = &mut ctx.accounts.task_state;
    task_state.buyer = ctx.accounts.buyer.key();
    task_state.seller = ctx.accounts.seller.key();
    task_state.verifier = ctx.accounts.verifier.key();
    task_state.mint = ctx.accounts.mint.key();
    task_state.task_id = task_id;
    task_state.amount = amount;
    task_state.deadline_unix = deadline_unix;
    task_state.status = TaskStatus::Pending;
    task_state.is_private = is_private;
    task_state.bump = ctx.bumps.task_state;

    // Escrow transfer from buyer to vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.buyer_token_account.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.buyer.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    Ok(())
}