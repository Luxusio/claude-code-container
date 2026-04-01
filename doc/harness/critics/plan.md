# plan critic project playbook
summary: CLI tool that runs Claude Code in isolated Docker containers
updated: 2026-04-01

# Mandatory PLAN.md fields

A plan must contain all of the following to be eligible for PASS:

| Field | Required content |
|-------|-----------------|
| Scope in | What this task will do |
| Scope out | What this task will NOT do |
| User-visible outcomes | What changes from the user's perspective |
| Touched files / roots | Which files and directory roots are affected |
| QA mode | `tests`, `smoke`, or `browser-first` |
| Verification contract | Executable commands, routes, persistence checks, expected outputs |
| Required doc sync | Which doc surfaces need updating, or "none" |
| Hard fail conditions | Explicit conditions that constitute failure |
| Risks / rollback | At least one rollback path for repo-mutating work |
| Open blockers | Known blockers or "none" |

# Evaluation criteria

Evaluate PLAN.md as a contract, not a narrative. Check:

1. **Scope** — Are scope-in and scope-out defined?
2. **Acceptance criteria** — Specific and testable? ("works correctly" = FAIL)
3. **Verification contract** — Executable commands, endpoints, or persistence checks? (prose without runnable commands = FAIL)
4. **Risk / rollback** — Mentioned for repo-mutating work?
5. **Hard fail conditions** — Explicitly stated?
6. **Persistence + doc sync strategy** — Stated for repo-mutating work?
7. **Browser-first QA** — N/A (CLI project, browser QA disabled)

# FAIL conditions

- Acceptance criteria are vague or missing
- No verification contract (no commands, no endpoints, no test names)
- Scope is undefined
- Risk/rollback not mentioned for repo-mutating work
- Required PLAN.md fields are missing

# Project-specific rules

- Verification must include `npm run build` (TypeScript compilation) and `npm test` (vitest)
- CLI behavior changes should include smoke test: `node dist/index.js --help` or equivalent
- Docker-related changes should note whether image rebuild is required
