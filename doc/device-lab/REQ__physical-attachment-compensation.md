# Physical attachment compensation

Derived from the architecture contract's existing [recovery and resource
claims](../common/SPEC__ccc-architecture-contracts.md#operation-transitions-and-recovery):
failed attachment must preserve its primary failure and any failure releasing
the exact physical lease acquired by that attempt.

Broker and direct Android/iOS attachment attempt compensation at most once for
each existing failed-publication or returned provider-refusal branch. Keep
publication inside its own narrow catch so a release exception is not mistaken
for another publication failure and released again. Do not add compensation for
unexpected thrown connect/inventory errors; their existing propagation remains.

If release throws, throw an ordinary `AggregateError`: its first member and
`cause` retain the exact primary thrown value or primary returned refusal, and
its second member retains the actual cleanup error. Returned refusals retain
their existing opaque command receipt and other primary facts. Use a fixed
aggregate message without credentials or lease nonce. Successful compensation
keeps the existing returned outcome or rethrows the same primary error object.

Use only the captured owner, backend, hardware/device identity, claim ID and
nonce. A successor lease remains authoritative. A false or refused release is
not successful compensation. Do not retry release, restore a predecessor,
publish a device or start its heartbeat after a failed publication. Preserve
existing release-refusal semantics and ordinary successful attach/detach.

Implement within the two existing attachment applications and their behavior
test owners; no new lease mechanism, framework, journal, port or wire error
schema. The broker's existing outer HTTP error rendering is unchanged.

Verify actual Android/iOS conflict/publication and cleanup failures, one exact
release call, primary/cleanup object identity, successor refusal and absent
heartbeat. Keep existing unexpected provider-exception and successful-path
tests. Portable built/extracted application checks do not certify physical
hardware or native adb/xcrun operation.
