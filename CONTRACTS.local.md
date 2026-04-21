# Project-specific contracts

This file is yours. The harness never touches it after setup creates the stub.
Add contracts numbered C-100 and above to keep clear of the managed block in
`CONTRACTS.md`.

Use the same four-field structure so `contract_lint.py` can validate them:

### C-100

**Title:** (one-line rule)
**When:** (exact trigger — lane, operation, or condition)
**Enforced by:** (hook, script, skill phase, or "convention")
**On violation:** (hard-block | soft-warn | auto)
**Why:** (the failure mode this prevents)
