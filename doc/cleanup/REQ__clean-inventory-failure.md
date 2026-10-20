# Clean inventory failure admission

`cleanContainers(options): Promise<void>` must obtain complete successful inventory before publishing a cleanup plan, asking for confirmation, acquiring cleanup lifecycle guards, querying claims, deleting any container/image/volume, reporting completion or exiting successfully. Empty or partial failed inventory must never admit cleanup.

The native facade in `src/clean.ts` checks each command's `error` first, then requires `status === 0`. A truthy error or any other status, including null or missing status, becomes `{ kind: "unavailable" }` without reading failed stdout/stderr. Successful commands become `{ kind: "observed", items }`. Native thrown errors propagate. The application returns a failed outcome for unavailable inventory immediately, without continuing remaining inventory; the native facade projects that fact to a rejected call. Failure of the second image-repository command discards the partially accumulated first-repository plan.

Returned inventory failures reject with these fixed messages:

- `Failed to list containers; cleanup aborted.`
- `Failed to list images; cleanup aborted.`
- `Failed to list volumes; cleanup aborted.`

The facade owns native newline/tab decoding and the running-status interpretation; container facts include `running`, while `status` is display text. Nullish or empty successful output remains an empty inventory. The application retains container ID/name admission, first-ID image deduplication and selection policy. Volume inventory remains conditional on `options.volumes || options.all`. The complete-inventory requirement also applies to dry-run and automatic confirmation.

Public fields remain only `volumes`, `all`, `dryRun`, and `yes`. The CLI retains only the existing `--volumes`, `--all`, `--dry-run`, `--yes` and `-y` confirmation alias. Recorded inventory wording about all-projects/force does not authorize new flags, managed labels, claim bypass, leases, pruning or generation reinspection. That wording must be reconciled against actual bindings before whole-operation credit.

Existing ownership is CCC-name/prefix inventory with captured container IDs and raw session-claim veto under the existing 180-second local lifecycle guard, including `--all`. Images/volumes retain their existing scope without an added claim guard. Default cleanup excludes running containers; all mode stops each eligible running container before removing its captured ID. Containers, images and volumes remain sequential. The facade returns `{ ok: boolean }` for mutations; the first failure aborts later work and preserves earlier successful mutations. Existing messages, prompt behavior, synchronous guard callbacks and successful CLI exit/count behavior remain unchanged.

The following are **derived technical requirements** grounded in the architecture
guide's [Finite native boundaries](../common/GUIDE__architecture-migration.md#finite-native-boundaries):
retain authority for the whole operation and return semantic completion to a
reusable caller, while the native CLI owns error rendering and process exit.

## One runtime authority for one cleanup

Capture the native runtime invocation once per operation, before readiness or
the first inventory command. Readiness, all inventories and all mutations must
use that same executable and Docker endpoint or Podman connection/store. Awaiting
confirmation must not allow changed ambient selection, environment or working
directory to retarget the plan. A later cleanup invocation may capture a new
authority. Capture/readiness failure must prevent inventory and deletion.
Reuse the existing captured-invocation adapter; runtime CLI names alone are not
sufficient authority. This corrects the prior implementation that observed each
inventory with ambient selection and selected mutation runtime after confirmation.

## Reusable completion and CLI projection

The application returns a finite `CleanOutcome`: `nothing-to-clean`, `dry-run`,
`aborted`, `completed` with its removal count, or `failed` with a `CleanFailure`
and the number of already removed items. It must not terminate a process or
construct native errors through a port. Expected inventory and mutation failures
return `failed`; no later effects run after such a failure. The count describes
completed removals, not successful stop commands or attempted removals. Unexpected
thrown native effects remain exceptions and must not become successful outcomes.

The existing native `cleanContainers(options): Promise<void>` facade renders
failed facts with the messages above and existing mutation-failure messages. It
owns the successful CLI exit after a completed cleanup. Nothing-to-clean, dry-run
and declined confirmation return normally without that exit. This keeps Node/UI
callers of the application independent of CLI process lifetime.

Verify the real facade with the existing focused suite: inventory failures deny plan/prompt/guard/claim/mutation, captured-ID claims veto effects, default mode excludes running IDs, all mode stops before removal, and failed stop denies downstream work. Change runtime/endpoint selection during confirmation and verify that observed IDs are mutated only through the captured authority. Verify reusable outcomes without any exit/error-construction capability and preserve counts on partial failure. Strict source/emitted declarations and finite actual emitted/npm/Unix CLI consumers verify the boundary and packaging. Native lock/claim/runtime acceptance, full integration and reliability remain separate gates; portable fixtures do not authorize or prove real native deletion.
