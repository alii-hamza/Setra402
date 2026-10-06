# Setra402 Scripts

This directory contains utility scripts for Setra402 development and maintenance.

## Baseline Verification Script

### Purpose

`verify-baseline.ts` establishes and verifies the protocol behavior baseline for productization work. This baseline (commit `72e665a`, 727 tests passing) represents the certified protocol behavior that must be preserved throughout all productization changes.

### Usage

```bash
# Run the verification script
npm run verify:baseline
```

### What It Checks

The script performs the following verifications:

1. **Git Branch** - Verifies you're on the `agent-validator` branch
2. **Git Commit** - Verifies HEAD is at commit `72e665a`
3. **Working Tree** - Verifies the working tree is clean (no uncommitted changes)
4. **Test Suite** - Runs the full test suite and verifies 727 tests pass with 0 failures

### Expected Output

When the baseline is correctly established, you'll see:

```
🔍 Setra402 Baseline Verification

Checking protocol behavior baseline for productization work...

Checking git branch...
✅ Branch: agent-validator
Checking git commit...
✅ Commit: 72e665a
Checking working tree...
✅ Working tree is clean

Running full test suite (this may take several minutes)...

✅ All tests passed
   Total: 727
   Passed: 727
   Failed: 0

============================================================
BASELINE VERIFICATION SUMMARY
============================================================

✅ BASELINE VERIFIED

The protocol behavior baseline is confirmed:
  • Branch: agent-validator
  • Commit: 72e665a
  • Working tree: clean
  • Tests: 727 passing, 0 failures

You may proceed with productization work.

============================================================
```

### When to Run

- **Before starting productization work** - Establish the baseline
- **After each meaningful change** - Verify protocol behavior is preserved
- **When tests fail** - Determine if failure indicates protocol break
- **Before committing refactors** - Ensure changes don't break protocol

### Exit Codes

- `0` - Baseline verified successfully
- `1` - Baseline verification failed (see error output)

### Requirements

- Git repository must be initialized
- npm must be installed
- All project dependencies must be installed (`npm install`)
- Solana validator must be running (for test execution)
- Redis must be running (for test execution)

### Notes

- The script will skip tests if git checks fail (branch, commit, or working tree)
- Test execution may take several minutes
- The script inherits environment variables from the npm execution context
