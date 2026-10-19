# Workspace content repair admission

`createWorkspaceContentRepairAdmission` owns the operator decision sequence for
one broken worktree: attempt confirmed repair, report an ordinary failure or
native content conflict, await confirmation, preserve conflicting content, and
retry once. Application code owns the semantic report events and catch
boundaries. The `src/index.ts` composition owns message wording, path display,
console calls and parsing the prompt answer.

`WorkspaceContentRepairAdmissionPorts` requires `repairConfirmed`,
`isContentConflict`, `report`, `confirmConflictRepair` and `setAsideConflicts`.
The CLI composes them with the actual `fixBrokenWorktree`,
`WorktreeContentConflictError`, `relative`, `prompt`,
`setAsideConflictingContent` and console. Structural resemblance to the native
error does not authorize preservation or retry.

## Evaluation and failure boundaries

The application passes the original conflict error in its report and reads that
error's root and conflict array again after confirmation. It does not replace
native error references with a copied conflict description. The CLI displays
relative paths and returns confirmation only for literal `y` and `yes` after
the native prompt's normalization.

The initial repair and result notice share the initial try block. Retry repair and its result notice share the retry try block. Conflict explanation, prompt, set-aside and the saved-path notice are outside the retry catch. A set-aside or saved-path notice failure propagates without retry or cleanup. The operation performs its initial effects synchronously before its first await.

Generic failure and retry-failure notices do not claim that content is unchanged.
The lower repair may have retained original content in quarantine or completed a
replacement before late cleanup failed. Only a fully restored native content
conflict reaches the set-aside prompt; a refused restoration or successor remains
an ordinary recovery failure. The lower error supplies actual recovery locations.

## Caller and verification

The actual CLI calls `main` → `prepareWorktree` → `workspaceOpen.open`.
The open application enters the `family` port's project-family lifecycle lock,
runs its workspace-opening attempt and invokes the `repairContent` port for
each confirmed broken entry. The CLI composes that port with
`repairBrokenWorktree`. The open application owns the outer confirmation and
serial processing; the CLI dispatches the requested command after opening. The
family guard remains held while the opening and content-repair prompts await
input.

The durable controls live in:

- `src/__tests__/architecture/workspace-content-repair-admission.test.ts`
- `src/__tests__/architecture/workspace-content-repair-admission-contracts.ts`
- `src/__tests__/architecture/workspace-repair-broken-core.test.ts`
- `src/__tests__/index-command-dispatch.test.ts`

Run the executable owners through `node scripts/run-vitest.mjs run`, followed by
the architecture/test type checks under the task's verification authorization.
The contracts file supplies compile-time cases. Assert actual command selection,
reported state and preserved private-Git data; historical source snapshots do not
define the deliberately corrected behavior. Genuine emitted CLI and guarded-caller
controls complement those tests.

## Evidence limits

Original controls establish the frozen source and genuine emitted caller behavior, actual native conflict-class recognition, and the allocated native family guard across both prompts with an owned contender. Lower repair, Git and quarantine fixtures and process boot-id/liveness controls establish their stated fixture observations only. They do not establish real host-content preservation, unrelated PID protection, provider behavior or platform coverage. Independent review, current candidate QA, shipping and full integration remain separate gates.
