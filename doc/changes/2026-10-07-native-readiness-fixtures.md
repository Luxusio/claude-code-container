# Deterministic Hyper-V readiness fixtures

Podman-forced CI at `74a1c921` passed 9,931 tests but failed a mock-only ISO
deletion-failure test after 1,014ms of real elapsed time. Cleanup latches remained
true while a later retry changed the expected reason to deadline exhaustion.

Seven remaining mock-only readiness test bodies now use fresh instances of the
existing clock/sleep ports. Provider responses, timeout values, reasons, latches
and operation assertions are unchanged. Six specialized clock/no-progress cases,
three default-clock Date.now spies and the earlier deterministic network mismatch
case remain unchanged. Production readiness code and deadlines are untouched.

Initial related broker tests could not open the MCP connection before the private
compiled MCP artifacts were prepared. Acceptance uses matching built artifacts;
that setup failure is not classified as a provider or timeout regression.

## Known ceiling

The exact delivered CI lanes must pass again before declaring the latest failure
resolved. These fixture changes do not certify Windows VM or Mac host execution.
