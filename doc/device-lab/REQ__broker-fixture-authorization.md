# Explicit broker fixture authorization

This is a derived repair of the [existing broker authentication boundary](REQ__container-broker-discovery.md#known-limits) and the architecture SPEC's [context and ownership](../common/SPEC__ccc-architecture-contracts.md#context-and-ownership) and [test-construction](../common/SPEC__ccc-architecture-contracts.md#build-and-test-construction) contracts. It separates deliberately unverified fixtures from ordinary broker requests; it introduces no new user requirement or authentication protocol.

An authenticated broker request may use the existing unverified-fixture exemption only when both `NODE_ENV=test` and `CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER=1` are explicitly present. `autolaunch:false` controls launching and does not authorize skipping generation attestation. With the flag absent or different from `1`, requests still verify the answering broker's current generation and reject a mismatch before sending authenticated RPC traffic.

Legacy `x-ccc-device-token` headers require that same explicit test authorization and a runtime marked `testOnly:true`. Every other runtime uses the existing HMAC headers, including a `testOnly` runtime without explicit authorization, an ordinary runtime with the flag, and production mode with the flag. Existing owner admission, process verification, forwarded-container rules, request body/nonce binding and operation deadlines retain their contracts.

Tests using fake HTTP brokers that cannot attest a real process must opt in within their private parent or child fixture environment and restore parent environment changes. These fixtures prove their stated transport or credential-provisioning behavior; they do not prove HMAC or real generation verification. Shared test-runner state and launch policy are not substitutes for that fixture construction.

## Verification

- `device-lab-mcp.broker-container-boundary.test.ts` uses an allocated status server to check matching and mismatched generations without the exemption, including `autolaunch:false` and production mode with the flag.
- `device-lab-mcp.broker.test.ts` checks the legacy/HMAC header matrix and preserves real Source/built broker launch cases with the exemption disabled.
- `device-lab-broker-call-flow.test.ts` checks actual Linux process identity and HMAC under test and production modes without the exemption, fresh attestation for every request, and no RPC after a generation change.
- `device-lab-broker.test.ts` retains concurrent private credential provisioning with explicitly authorized fixture clients and no lock residue. That case does not certify HMAC.

Source, bundled MCP and extracted-payload checks must exercise authenticated requests and generation refusal. Portable fixtures and declared platform skips do not certify actual macOS, Windows host providers or full lifecycle reliability.
