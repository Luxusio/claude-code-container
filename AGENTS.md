# AGENTS.md

Codex instructions for this repository.

## Project Context

This repository is `claude-code-container` (`ccc`), a TypeScript CLI that runs coding tools in isolated Docker/Podman containers. The product already supports Claude, Codex, Gemini, and OpenCode credential/config mounts; avoid regressing any supported tool while changing one tool path.

## Harness

- This repository includes a harness under `doc/harness/`.
- For repo-mutating tasks, use the `$harness` skill before editing source, tests, docs, or config.
- Read `CONTRACTS.md`, `CONTRACTS.local.md`, and `doc/harness/manifest.yaml` when the task changes harness behavior or workflow rules.
- Follow the canonical loop for repo-mutating work: plan -> implement -> verify -> close.
- Keep task evidence concrete. Prefer command output summaries from `npm run build`, `npm run lint`, `npm test`, and focused smoke checks.
- Do not hand-edit generated or harness-managed blocks between `harness:managed-begin` and `harness:managed-end` markers.

## Codex Harness Routing

- Full repo-mutating task: use `$harness`, then continue through plan -> implement -> verify -> close in the conversation.
- Plan only: use `$harness` and stop after the plan.
- Continue an approved Claude harness artifact: read the artifact first, treat it as the active scope contract, and do not rewrite `CHECKS.yaml` by hand.
- Harness maintenance: keep Claude-specific instructions in `CLAUDE.md`, Codex-specific instructions in `AGENTS.md`, and shared policy in `CONTRACTS.md` or `CONTRACTS.local.md`.

## Development Commands

- Install dependencies: `mise run setup`
- Build: `mise run build`
- Lint: `mise run lint`
- Test: `mise run test`
- Full local check: `mise run check`

## Editing Rules

- Use the existing TypeScript/ESM style.
- Keep changes scoped to the requested behavior.
- Preserve user or pre-existing dirty worktree changes.
- Prefer focused tests near the changed behavior.
- For CLI behavior changes, include at least one smoke check such as `node dist/index.js --help` when practical.
