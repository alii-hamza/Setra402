use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use crate::{constants::*, errors::SetraError, state::*};

#[derive(Accounts)]
#[instruction(nullifier: [u8; 32])]
pub struct SettleTaskPrivate<'info> {
    #[account(
        mut,
        has_one = verifier @ SetraError::InvalidVerifier,
        seeds = [TASK_SEED, task_state.buyer.as_ref(), &task_state.task_id.to_le_bytes()],
        bump = task_state.bump
    )]
    pub task_state: Account<'info, TaskState>,

    #[account(mut)]
    pub verifier: Signer<'info>,

    #[account(
        init,
        payer = verifier,
        space = 8 + NullifierRecord::INIT_SPACE,
        seeds = [NULLIFIER_SEED, nullifier.as_ref()],
        bump
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    #[account(
        mut,
        seeds = [VAULT_SEED, task_state.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = seller_token_account.owner == task_state.seller)]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<SettleTaskPrivate>, _nullifier: [u8; 32]) -> Result<()> {
    Ok(())
}