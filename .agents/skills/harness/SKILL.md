---
name: harness
description: Repository harness workflow for claude-code-container. Use when Codex is asked to mutate this repo, implement code, edit tests or docs, change harness rules, run the full plan/develop/verify/close cycle, prepare or follow a plan, repair harness drift, or produce completion evidence compatible with the existing Claude Code harness.
---

# Harness

Use this skill to apply the repository harness from Codex. The original harness was installed for Claude Code, but the authoritative project rules live in repository files and must be followed here too.

## Required Reads

Before repo-mutating work, read:

1. `CONTRACTS.md`
2. `CONTRACTS.local.md`
3. `doc/harness/manifest.yaml`

For review or verification details, read only the relevant playbook:

- Planning: `doc/harness/critics/plan.md`
- Runtime verification: `doc/harness/critics/runtime.md`
- Documentation sync: `doc/harness/critics/document.md`

## Workflow

For any repo mutation, run this loop:

1. Plan
   - Define scope in/out, files or roots likely touched, verification commands, docs affected, risks, rollback, and blockers.
   - If the user only asked for a plan, stop after the plan.
   - If the user asked to implement, continue after the plan unless clarification is required.

2. Implement
   - Keep edits scoped.
   - Preserve existing user changes in the worktree.
   - Do not edit `harness:managed` blocks directly unless the task is explicitly harness maintenance and the change is additive, deliberate, and explained.

3. Verify
   - Prefer commands from `doc/harness/manifest.yaml`.
   - Default verification for this repo is:
     - `mise run build`
     - `mise run lint`
     - `mise run test`
   - For CLI behavior changes, add a smoke check such as `node dist/index.js --help` when practical.
   - If a command cannot run, record the exact blocker and the residual risk.

4. Close
   - Report files changed, verification performed, and any failures or skipped checks.
   - Include concrete evidence, not just "passed".
   - Mention docs/harness impacts when relevant.

## Artifact Compatibility

The Claude harness refers to protected artifacts such as `PLAN.md`, `CHECKS.yaml`, `DOC_SYNC.md`, `HANDOFF.md`, and `CRITIC__runtime.md`. In Codex sessions, do not create or rewrite those artifacts unless the user explicitly asks for artifact files. Prefer keeping the plan, verification evidence, and close summary in the conversation.

When artifact files already exist and the user asks to continue an approved plan:

1. Read the artifact first.
2. Treat it as the active scope contract.
3. Update only the files required to satisfy that plan.
4. Do not rewrite `CHECKS.yaml` by hand.

## Maintenance Mode

Use maintenance mode when the user asks to repair or extend the harness itself.

- Keep `CLAUDE.md` and `AGENTS.md` aligned at the routing level, but do not make them byte-for-byte duplicates.
- Put Codex-specific durable instructions in `AGENTS.md`.
- Put Claude-specific durable instructions in `CLAUDE.md`.
- Keep shared policy in `CONTRACTS.md` or `CONTRACTS.local.md`.
- Do not overwrite `CONTRACTS.local.md`.

## Completion Bar

A task is ready to close only when:

- The requested behavior is implemented or the blocker is concrete.
- Relevant checks were run and summarized.
- Any test changes are intentional and near the changed behavior.
- No unrelated dirty worktree changes were reverted or absorbed.
