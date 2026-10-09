# Workspace content repair admission

`createWorkspaceContentRepairAdmission` owns the complete operator decision sequence for one broken worktree: attempt confirmed repair, report an ordinary failure or explain native content conflicts, await confirmation, preserve conflicting content, and retry once. Application code owns conflict mapping, exact messages, answer checks and catch boundaries.

`WorkspaceContentRepairAdmissionPorts` requires native repair, fixed-class conflict recognition, prompt, and selected log, relative-path and set-aside capabilities. The `src/index.ts` composition uses the actual `WorktreeContentConflictError`, `fixBrokenWorktree`, `relative`, `prompt`, `setAsideConflictingContent` and console. Structural resemblance to the native error does not authorize preservation or retry.

## Evaluation and failure boundaries

Select the native log and its console receiver before evaluating each message, including ordinary and retry error message getters. Select the native relative-path callee before reading the conflict root for each mapped path. Select set-aside before reading its arguments. Composition invokes captured console methods with a captured invocation intrinsic; native path and set-aside callees retain their bare receiver.

The application keeps the original conflict error and array references. It reads the root and conflicts again after the prompt, rather than using the earlier display values. Only literal `y` and `yes` authorize set-aside; native prompt normalization remains native.

The initial repair and result notice share the initial try block. Retry repair and its result notice share the retry try block. Conflict explanation, prompt, set-aside and the saved-path notice are outside the retry catch. A set-aside or saved-path notice failure propagates without retry or cleanup. The operation performs its initial effects synchronously before its first await.

## Caller and verification

The actual CLI continues through `main` → `prepareWorktree` → caller-held project-family lifecycle lock → `prepareWorktreeUnlocked` → `repairBrokenWorktree`. The outer repair prompt, serial broken-entry processing and downstream command dispatch stay in that caller. The guard remains held during interactive suspension.

The durable controls live in:

- `src/__tests__/architecture/workspace-content-repair-admission-core.test.ts`
- `src/__tests__/architecture/workspace-content-repair-admission-facade.test.ts`
- `src/__tests__/architecture/workspace-content-repair-admission-types.test.ts`

Run the three files through `node scripts/run-vitest.mjs run`, followed by `npm run typecheck:architecture` and `npm run typecheck:tests`, under the task's verification authorization. Genuine full emitted CLI and real guarded-caller controls complement the source oracle. Immutable originals belong inside the tests; ignored captures and mutable build output are not durable oracle dependencies.

## Evidence limits

Original controls establish the frozen source and genuine emitted caller behavior, actual native conflict-class recognition, and the allocated native family guard across both prompts with an owned contender. Lower repair, Git and quarantine fixtures and process boot-id/liveness controls establish their stated fixture observations only. They do not establish real host-content preservation, unrelated PID protection, provider behavior or platform coverage. Independent review, current candidate QA, shipping and full integration remain separate gates.
