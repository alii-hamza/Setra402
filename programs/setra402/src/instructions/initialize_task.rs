use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::{constants::*, state::*};

#[derive(Accounts)]
#[instruction(task_id: u64)]
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
    #[account(mut, constraint = buyer_token_account.mint == mint.key())]
    pub buyer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    _ctx: Context<InitializeTask>,
    _task_id: u64,
    _amount: u64,
    _timeout_seconds: i64,
    _is_private: bool,
) -> Result<()> {
    Ok(())
}