# Container image preparation outcomes

These requirements are derived from the existing [architecture outcome contract](../common/SPEC__ccc-architecture-contracts.md#common-outcomes), applied to the current `ensureImage` startup operation. They do not define a new runtime service or change project storage.

The reusable application reports completion, failure or an indeterminate result. Completion distinguishes a development image, matching local version, acknowledged pull-and-tag, and the retained local fallback after a failed pull. Native command receipts and console presentation remain outside the application.

After a successful pull, startup proceeds only when tagging returns a clean exit zero without a native error or signal. A definite nonzero exit reports `image-tag-failed`. Missing or malformed receipt/status, a transport error or a signal reports `image-tag-unconfirmed`; error/signal takes precedence over a status value. Neither case permits downstream image-ID lookup, identity-image preparation or container startup. Private stdout, stderr and native error messages are not included in these outcomes or their tag diagnostics.

Failed pull with an existing local image retains its warning and local fallback. Failed pull without one retains an actionable local-build hint and aborts startup. Existing development and matching labels do not cause a pull or tag. The public `ensureImage(): void` entry point returns on accepted preparation or throws a bounded startup error; it does not terminate the caller process.

There is no automatic retry, compensating retag or deletion. An uncertain tag may already have changed the mutable target, so the operation does not promise rollback or preservation of its previous binding. A subsequent explicit invocation reobserves the image and may accept a matching version if that earlier tag succeeded. Command acknowledgement does not establish digest equality or eliminate concurrent mutable-tag races.

Verification uses the existing core, native facade, type and Docker regression owners. Native failure/uncertainty witnesses must prove startup aborts before downstream effects. An emitted-module child fences native subprocess leaves before importing the shipped Docker facade. Portable fixtures do not establish real Docker/Podman or native Windows/macOS acceptance. Existing stdout-based existence, nullable inspection and boolean pull observations remain separate limitations.
