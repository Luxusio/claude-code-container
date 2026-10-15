# Clean inventory failure admission

`cleanContainers(options): Promise<void>` must obtain complete successful inventory before publishing a cleanup plan, asking for confirmation, acquiring cleanup lifecycle guards, querying claims, deleting any container/image/volume, reporting completion or exiting successfully. Empty or partial failed inventory must never admit cleanup.

The native facade in `src/clean.ts` checks each command's `error` first, then requires `status === 0`. A truthy error or any other status, including null or missing status, becomes `{ kind: "unavailable" }` without reading failed stdout/stderr. Successful commands become `{ kind: "observed", items }`. Native thrown errors propagate. The application receives these semantic observations and rejects unavailable inventory immediately, without continuing remaining inventory. Failure of the second image-repository command discards the partially accumulated first-repository plan.

Returned inventory failures reject with these fixed messages:

- `Failed to list containers; cleanup aborted.`
- `Failed to list images; cleanup aborted.`
- `Failed to list volumes; cleanup aborted.`

The facade owns native newline/tab decoding and the running-status interpretation; container facts include `running`, while `status` is display text. Nullish or empty successful output remains an empty inventory. The application retains container ID/name admission, first-ID image deduplication and selection policy. Volume inventory remains conditional on `options.volumes || options.all`. The complete-inventory requirement also applies to dry-run and automatic confirmation.

Public fields remain only `volumes`, `all`, `dryRun`, and `yes`. The CLI retains only the existing `--volumes`, `--all`, `--dry-run`, `--yes` and `-y` confirmation alias. Recorded inventory wording about all-projects/force does not authorize new flags, managed labels, claim bypass, leases, pruning or generation reinspection. That wording must be reconciled against actual bindings before whole-operation credit.

Existing ownership is CCC-name/prefix inventory with captured container IDs and raw session-claim veto under the existing 180-second local lifecycle guard, including `--all`. Images/volumes retain their existing scope without an added claim guard. Inventory runtime is selected per command; mutation runtime is captured once after confirmation. Default cleanup excludes running containers; all mode stops each eligible running container before removing its captured ID. Containers, images and volumes remain sequential. The facade returns `{ ok: boolean }` for mutations; the first failure aborts later work and preserves earlier successful mutations. Existing messages, prompt behavior, synchronous guard callbacks and successful exit/count behavior remain unchanged.

Verify the real facade with the existing focused suite: inventory failures deny plan/prompt/guard/claim/mutation, captured-ID claims veto effects, default mode excludes running IDs, all mode stops before removal, and failed stop denies downstream work. Strict source/emitted declarations and finite actual emitted/npm/Unix CLI consumers verify the boundary and packaging. Native lock/claim/runtime acceptance, full integration and reliability remain separate gates; portable fixtures do not authorize or prove real native deletion.
