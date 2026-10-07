# Monotonic wait callback correction

Shared observation pauses now capture one absolute wake target and recheck
monotonic time after each timer callback. A callback arriving early sleeps only
the remaining time instead of allowing another provider observation early.
The original deadline, normalized intervals, request allowances and provider
error handling are preserved.

Deterministic tests cover ordinary and fractional final pauses, repeated early
callbacks, on-time callbacks, overshoot and exhausted budgets. The new early
callback regressions fail against the previous implementation. The Hyper-V
network-mismatch fixture now uses its existing clock/sleep ports and verifies
exactly one probe, detach and ISO deletion; production readiness is unchanged.

## Known ceiling

The early-wake defect was reproduced independently, but the exact historical
Podman CI timeout timeline was not captured. This correction alone does not
prove those full-suite failures resolved. Real Mac Colima and native Windows
acceptance remain separate requirements; portable fixtures do not certify them.
