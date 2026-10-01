# Observed Role B Live Contract

Observed on 2026-10-01 against:

- Agave `solana-test-validator 4.3.0`
- Setra402 program `FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN`, built from the checked-in program source
- seller-server built with repository Rust `1.89.0`
- Redis `8.0.5`

The addresses below were ephemeral localnet fixtures. The field names, status codes, and boundary behavior are the contract.

## Unpaid request

`POST /tasks/402001` with a valid buyer, JSON input, and `is_private: false` returned HTTP `402`:

```json
{
  "amount": 1500000,
  "is_private": false,
  "mint": "cdHBSJehTFWv8U5Ror4g1FToxMxRK3YJ4E3cvX1KAxa",
  "program_id": "FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN",
  "protocol_fee_bps": 100,
  "seller_token_account": "3QwJvvXompGmx6hsHkiL8QwJvorLitc3PHoE1nic19j5",
  "task_id": 402001,
  "task_state_pda": "GhSi7L8EyxSTxR7dNu1toZZuK5XWcqRGDLLDKAXxyopQ",
  "timeout_seconds": 180,
  "vault_pda": "FyhjauJSdwrWVBomVcBhS2NBzU2VkP4EHXvjuDaiiyXN",
  "verifier": "9PVTK8k9Hty9SKrRTykTdDmaTwLuSjv5xUNuUqFD4US7"
}
```

The live PDA values independently matched `["task", buyer, task_id_u64_le]` and `["vault", task_state]`.

## Funded request

After `initialize_task` confirmed and `TaskState` was re-read as Pending, the same POST returned HTTP `200`:

```json
{
  "input": { "...": "original task input" },
  "output_hash": "sha256(canonical(original task input))"
}
```

During E2E testing, the seller initially returned a false post-funding `402` because its raw RPC request used Solana's default finalized commitment while the buyer confirmed at confirmed. Phase 1 makes the seller's read explicitly `confirmed` and keeps a bounded post-funding 402 retry. A Rust regression test locks this behavior.

## Expired request

A real Pending task whose on-chain deadline had passed returned HTTP `410`:

```json
{
  "deadline_unix": 1790841743,
  "error": "task deadline has passed; on-chain refund is available",
  "now": 1790841792
}
```

The boundary is `now >= deadline_unix`, matching `refund_task`. Role C treats this as terminal for execution and enters the timeout-refund path; it does not retry execution, settle, or call `cancel_task`.

## Other observed mappings

- `400`: permanent request error, including privacy mismatch
- `409`: task already settled/refunded or not pending
- `404` from `GET /tasks/:task_id/result`: result unavailable
- `5xx`/network failure: bounded retry
- `/verifier/nullify`: Redis cache endpoint only; on-chain `NullifierRecord` remains settlement authority
