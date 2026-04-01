# runtime critic project playbook
summary: CLI tool that runs Claude Code in isolated Docker containers
updated: 2026-04-01

# Primary rule

Verify through execution, not through code reading. Do not give PASS from static analysis alone when runtime verification is feasible.

# Verification approach

## For this CLI project

1. **Build** — `npm run build` must succeed (TypeScript compiles cleanly)
2. **Tests** — `npm test` must pass (vitest suite)
3. **Smoke** — `node dist/index.js --help` exits 0 and prints usage
4. **Lint** — `npm run lint` if applicable to changed files

# Project-specific settings

- preferred_order: [build, test, smoke]
- must_verify: [build, test]
- prefer_commands: ["npm run build", "npm test"]

# Rules

- Every PASS needs at least one concrete evidence item
- BLOCKED_ENV requires exact blocker description
- A FAIL verdict must list specific unmet acceptance criteria
- Evidence is natural language summaries of command output — no metadata schemas needed
