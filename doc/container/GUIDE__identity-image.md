# Container identity image preparation

The public `src/container-identity.ts` facade composes the complete
`prepareIdentityImage` application in `src/application/container/identity-image.ts`.
This is the single policy owner for OP-container-identity-image: validate identity
and base digest, hash ordered identity/base labels, acquire the keyed lock, validate
the cache, tag/build on a miss, revalidate, and remove an invalid derived tag.
Identity helpers are support for this operation, not additional migrated operations.

`src/domain/container/identity-image.ts` owns numeric UID/GID validation, runtime
mapping, labels and cache names. Runtime facts determine rootless Docker refusal,
Podman keep-id and desktop/host selection. The facade retains default
effective UID/GID and platform capture and its existing public exports/signatures.

`src/ports/container/identity-image.ts` requires synchronous semantic digest, lock,
inspection, account probe, tag, build and derived-removal effects. Tag/build/removal
return `undefined`, rather than `void`, so an async function cannot silently satisfy
the effect contract. The lock and its callback return a synchronous image ID.
The account probe receives the inspected image. The application has no
Node/runtime/native imports, and the existing facade supplies the small concrete
composition.

## Cache and mutation authority

Labels retain insertion order: version, uid, gid, mapping, base. SHA256 hashes the
exact `JSON.stringify` output to derive `ccc-identity:<hash>` and
`identity-<hash>.lock`. The lock remains the existing shared mutation lock under
`locksDir()`, waits 1,260,000 ms, and never reclaims stale locks. Cache inspection and
all mutation/revalidation occur inside this lock.
The application passes the serialized labels to the synchronous
`labelsDigest(serializedLabels: string): string` port. The native facade supplies
an ordinary function that hashes those bytes with SHA256 and returns hexadecimal
output.

Cache acceptance normalizes the inspected immutable ID for validation, checks
`Config.User` is `ccc`, checks expected labels in order, and probes the actual named
account. The successful original `image.Id` is returned unchanged, including Podman
bare digests. The base label/tag uses a canonical digest; native tagging receives
the caller's original base argument.

Inspection spawn throws propagate outside the validation catch. Nonzero/error
inspect results, malformed JSON/fields and failed/incompatible account probes
become cache misses. A tag/build failure propagates without cleanup.
An invalid completed build removes only `ccc-identity:<hash>`, then throws validation
failure; removal failure takes precedence. The base tag is never removed here.

## Native isolation and deadlines

The facade keeps the original account and reconcile shell scripts, Dockerfile
encoding and CLI argument order. Builds use `--pull=false`; account probes use
`--rm --network none`, existing runtime extra arguments, `--user ccc` and a shell
entrypoint, with no project or credential mounts. Account reconciliation retains
the existing unrelated-account collision refusal and the limited `/home/ccc`,
`/opt/ccc`, `/host-stage` ownership traversal.

Inspect timeout is 30,000 ms. Build timeout is 1,200,000 ms; other checked commands
use 600,000 ms and a 16 MiB buffer. Checked failures retain native-error precedence
over exit status and include only the last 4,096 characters of trimmed stderr.

## Compatibility evidence

The public identity regression suite exercises native facade composition. Domain
and application architecture suites cover validation/mapping and fake-port lifecycle
order, lock enclosure and failure boundaries. The architecture types fixture checks
facade/core compatibility, required ports and async rejection; it is included by
`typecheck:architecture`. The selected Hyper-V-only `typecheck:tests` configuration
does not typecheck identity tests.

Portable tests check ordered serialized labels, fixed native hash/tag/lock names,
original base arguments, cache account validation, rebuild/revalidation and
failure propagation using ordinary observations. Native facade tests cover CLI
arguments, deadlines and script/Dockerfile content. These portable mocked witnesses
and source/type checks do not establish real Docker/Podman execution. Native
acceptance remains a separate root-owned verification boundary; no live engine is
needed for core tests.
