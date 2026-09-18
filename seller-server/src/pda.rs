//! PDA derivation. This is the one thing the server must never take on
//! trust from a client (architecture doc, Section 1.2 and Section 4): every
//! address is re-derived here from `(program_id, buyer, task_id)`, never
//! read off an incoming request.

use crate::task_state::{TASK_SEED, VAULT_SEED};
use solana_pubkey::Pubkey;

pub fn task_state_pda(program_id: &Pubkey, buyer: &Pubkey, task_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[TASK_SEED, buyer.as_ref(), &task_id.to_le_bytes()],
        program_id,
    )
}

pub fn vault_pda(program_id: &Pubkey, task_state: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, task_state.as_ref()], program_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_inputs_always_derive_the_same_address() {
        let program_id = Pubkey::new_unique();
        let buyer = Pubkey::new_unique();
        let (a, bump_a) = task_state_pda(&program_id, &buyer, 7);
        let (b, bump_b) = task_state_pda(&program_id, &buyer, 7);
        assert_eq!(a, b);
        assert_eq!(bump_a, bump_b);
    }

    #[test]
    fn different_task_ids_derive_different_addresses() {
        let program_id = Pubkey::new_unique();
        let buyer = Pubkey::new_unique();
        let (a, _) = task_state_pda(&program_id, &buyer, 1);
        let (b, _) = task_state_pda(&program_id, &buyer, 2);
        assert_ne!(a, b, "different task_ids must not collide");
    }

    #[test]
    fn different_buyers_derive_different_addresses_for_the_same_task_id() {
        let program_id = Pubkey::new_unique();
        let (a, _) = task_state_pda(&program_id, &Pubkey::new_unique(), 1);
        let (b, _) = task_state_pda(&program_id, &Pubkey::new_unique(), 1);
        assert_ne!(a, b);
    }

    #[test]
    fn vault_pda_depends_on_the_task_state_address() {
        let program_id = Pubkey::new_unique();
        let (task_state_a, _) = task_state_pda(&program_id, &Pubkey::new_unique(), 1);
        let (task_state_b, _) = task_state_pda(&program_id, &Pubkey::new_unique(), 2);
        let (vault_a, _) = vault_pda(&program_id, &task_state_a);
        let (vault_b, _) = vault_pda(&program_id, &task_state_b);
        assert_ne!(vault_a, vault_b);
    }
}
