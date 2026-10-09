# Clean inventory failure admission

`cleanContainers(options): Promise<void>` must obtain complete successful inventory before publishing a cleanup plan, asking for confirmation, acquiring cleanup lifecycle guards, querying claims, deleting any container/image/volume, reporting completion or exiting successfully. Previously inventory status/error were ignored, so empty or partial failed inventory could permit unrelated deletions.

After each container inventory, each of the two image-repository commands, and optional volume inventory, check the original result's `error` first, then require `status === 0`. A truthy error or any other status, including null or missing status, rejects immediately. Do not read failed stdout/stderr or continue remaining inventory. The second image-command failure discards the partially accumulated first-repository plan. Native thrown errors and property-getter exceptions propagate unchanged; there is no catch or error coercion.

Returned inventory failures reject with these fixed messages:

- `Failed to list containers; cleanup aborted.`
- `Failed to list images; cleanup aborted.`
- `Failed to list volumes; cleanup aborted.`

Successful status zero with falsy error uses the existing stdout parsers. Nullish or empty successful output remains an empty inventory. Volume inventory is still conditional on `options.volumes || options.all`. This admission also applies to dry-run and automatic confirmation.

Public fields remain only `volumes`, `all`, `dryRun`, and `yes`. The CLI retains only the existing `--volumes`, `--all`, `--dry-run`, `--yes` and `-y` confirmation alias. Recorded inventory wording about all-projects/force does not authorize new flags, managed labels, claim bypass, leases, pruning or generation reinspection. Root must reconcile that wording against actual bindings before whole-operation credit.

Existing ownership is CCC-name/prefix inventory with captured container IDs and raw session-claim veto under the existing 180-second local lifecycle guard, including `--all`. Images/volumes retain their existing scope without an added claim guard. Inventory runtime is selected per command; mutation runtime is captured once after confirmation. Container stop/remove, images and volumes remain sequential; the first mutation failure aborts remaining work and preserves earlier successful mutations. Existing messages, option/property reads, prompt behavior, native callee/receiver order, synchronous guard callbacks, and successful exit/count behavior remain unchanged apart from the explicit inventory admission reads.

Verification must preserve immutable actual original successful traces and original failed-inventory controls, then separately prove the intentional failure correction. Assert exact captured-ID argv and downstream denial for claims, default-running exclusion, failed stop and first failure. Strict source/emitted declarations and actual CLI bindings, both shipping forms, main integration and native reliability remain separate required gates. No real native deletion is authorized by mock evidence.
