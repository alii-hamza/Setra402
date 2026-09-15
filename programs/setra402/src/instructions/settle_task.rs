use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use crate::{constants::*, errors::SetraError, state::*};

#[derive(Accounts)]
pub struct SettleTask<'info> {
    #[account(
        mut,
        has_one = verifier @ SetraError::InvalidVerifier,
        seeds = [TASK_SEED, task_state.buyer.as_ref(), &task_state.task_id.to_le_bytes()],
        bump = task_state.bump
    )]
    pub task_state: Account<'info, TaskState>,
    pub verifier: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, task_state.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = seller_token_account.owner == task_state.seller)]
    pub seller_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(_ctx: Context<SettleTask>) -> Result<()> {
    Ok(())
}