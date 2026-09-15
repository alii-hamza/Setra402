use anchor_lang::prelude::*;

pub const TASK_SEED: &[u8] = b"task";
pub const VAULT_SEED: &[u8] = b"vault";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";

pub fn task_pda_seeds(buyer: &[u8], task_id: u64, bump: u8) -> Vec<Vec<u8>> {
    vec![
        TASK_SEED.to_vec(),
        buyer.to_vec(),
        task_id.to_le_bytes().to_vec(),
        vec![bump],
    ]
}

pub fn vault_pda_seeds(task_state_key: &[u8], bump: u8) -> Vec<Vec<u8>> {
    vec![VAULT_SEED.to_vec(), task_state_key.to_vec(), vec![bump]]
}

pub fn nullifier_pda_seeds(eta: &[u8], bump: u8) -> Vec<Vec<u8>> {
    vec![NULLIFIER_SEED.to_vec(), eta.to_vec(), vec![bump]]
}
