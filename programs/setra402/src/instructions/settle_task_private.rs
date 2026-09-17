use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::errors::SetraError;
use crate::state::*;

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

    #[account(mut)]
    pub protocol_treasury: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SettleTaskPrivate>, nullifier: [u8; 32]) -> Result<()> {
    let task_state = &mut ctx.accounts.task_state;
    require!(task_state.status == TaskStatus::Pending, SetraError::TaskNotPending);

    let amount = task_state.amount;
    let fee = (amount as u128)
        .checked_mul(PROTOCOL_FEE_BPS as u128)
        .ok_or(SetraError::Overflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(SetraError::Overflow)? as u64;

    let seller_amount = amount.checked_sub(fee).ok_or(SetraError::Overflow)?;

    let buyer_key = task_state.buyer;
    let task_id_bytes = task_state.task_id.to_le_bytes();
    let bump = [task_state.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        TASK_SEED,
        buyer_key.as_ref(),
        &task_id_bytes,
        &bump,
    ]];

    // 99% to Seller
    let cpi_to_seller = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.seller_token_account.to_account_info(),
        authority: task_state.to_account_info(),
    };
    let cpi_ctx_seller = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_to_seller,
        signer_seeds,
    );
    token::transfer(cpi_ctx_seller, seller_amount)?;

    // 1% to Protocol Treasury
    if fee > 0 {
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
        token::transfer(cpi_ctx_treasury, fee)?;
    }

    // Record Nullifier
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.nullifier = nullifier;
    nullifier_record.task_id = task_state.task_id;
    nullifier_record.settled_at = Clock::get()?.unix_timestamp;
    nullifier_record.bump = ctx.bumps.nullifier_record;

    task_state.status = TaskStatus::Settled;
    Ok(())
}