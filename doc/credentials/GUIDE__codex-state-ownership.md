# Codex retained-state ownership migration

`prepareCodexStateOwnership` remains the synchronous public compatibility entry.
Its application factory owns the whole retained-state migration decision: selected
profile root, host mapping gates, previous managed bind provenance, immutable old
image account observation, complete ancestor trust, active bind overlap refusal,
second root identity validation, and final fixed native helper dispatch.

The domain contains structural facts and receipts. Ports expose synchronous
observations and one fixed ownership effect; they have no Docker argv, filesystem
API, runtime defaults, or asynchronous effects. Production binds those primitives
in `src/codex-state-ownership.ts`. Raw prior mounts, identity, proof callback, and
native directory objects keep their references and lazy getter behavior.

`startProjectContainer` continues to own `codex-state.lock` with its existing
600000 ms wait and no stale-holder reclaim, through preparation and container
start. This extraction acquires no additional lock and changes no caller.
`assertCodexStateAccessible`, used before Codex startup, remains native readiness
support and is not an additional migrated operation.

Both Python programs and the checked native runner remain in the facade. The old
image probe has no mounts and uses root with networking disabled. The final helper
uses the normalized current immutable image, root, networking disabled, and one
managed bind to `/state`. Commands retain the 300000 ms timeout, 4 MiB output cap,
UTF-8 options and original error/status/trim behavior.

The Python helper pins descriptors and validates membership and metadata before
and after selective ownership writes. It rejects symlinked roots, filesystem
boundaries, hardlinks, set-ID objects and unsupported entries. It changes only
numeric owners matching the established old image principal. It has no journal,
rollback or automatic retry; a failure after a write can retain partial migration.

Verification anchors are `codex-state-ownership-core.test.ts`,
`codex-state-ownership-facade.test.ts`, and `codex-state-ownership-types.test.ts`
under `src/__tests__/architecture/`, plus the existing actual-facade and private
Python fixtures in `src/__tests__/codex-state-ownership.test.ts`. Core traces cover
short circuits, source proof, account validation, trust and overlap refusal,
replacement and raw failures; facade tests pin actual argv/options and the public
entry. Strict contract tests reject missing, noncallable and asynchronous ports.
The recursive architecture boundary guard covers all three inward files.

The portable candidate checks on 2026-10-08 completed one full build and fresh
assembly, 139 tests across those three suites, retained-state fixtures and the
boundary guard, and 474 existing Docker/startup/identity caller tests. Actual npm
tar extraction and `materializeUnixInstallPayload` consumers each compared 47
compiled baseline/current cases, including successful single-helper dispatch,
two full ancestor traversals, refusal, getter failures and exact argv/options.
Both consumed declarations with `skipLibCheck: false`; the original public
facade declaration is byte-identical. Their runner is fenced and no live runtime
or user credential store is accessed. Source checks are not an independent
review, QA attestation or full migration completion claim.

## Known ceiling

Portable tests and private Python fixtures do not prove live Docker or Podman
ownership transfer, daemon bind alias behavior, host ACL or SELinux handling,
macOS or Windows mapping, external writers, termination or crash recovery. Existing
Python access fixtures skip non-root-only checks when executed as root. No complete
architecture, native-provider or reliability certification follows from this lane.
