<!-- harness:managed v1 — do not edit between the begin/end markers.
     Changes inside the managed block will be overwritten on harness upgrade.
     Project-specific contracts (C-100+) belong in CONTRACTS.local.md,
     which is imported below and never touched by the harness. -->

# CONTRACTS

<!-- harness:managed-begin v1 -->

## 0. Design invariants

Two pressures govern this harness — in this order:

1. **Protocol compliance is non-negotiable.** Contracts listed below MUST be
   followed exactly. A "lighter" solution that violates a contract is not
   lighter — it is broken. Skipping the canonical loop, writing a protected
   artifact without its owner, closing with stale PASS, or bypassing the
   prewrite gate are hard failures regardless of task size.
2. **Within that constraint, pick the lightest path.** Fewer phases, shorter
   SKILL files, fewer parallel agents, fewer hooks — all preferred when they
   don't break (1). Complexity requires justification; simplicity is default.

Resolving the tension:
- If a rule feels too heavy, **fix the rule** (edit this file, the SKILL, the
  gate) — never silently skip it.
- Prefer machine-enforced gates over prose. A prose-only rule is commentary.
- Every rule has exactly ONE authoritative location. Duplicates rot.

## 1. Contract matrix — 상황 → 규약

Lookup table. Find your current situation, apply the listed contracts.

| 상황 | 적용 규약 | 수준 |
|------|---------|------|
| Repo-mutating 태스크 시작 | [C-01](#c-01), [C-02](#c-02), [C-09](#c-09) | hard |
| 보호 아티팩트 쓰기 (PLAN/CHECKS/HANDOFF/DOC_SYNC/CRITIC__runtime) | [C-03](#c-03), [C-05](#c-05) | hard |
| `task_close` 시점 | [C-01](#c-01), [C-04](#c-04), [C-14](#c-14) | hard |
| 짧은 승인 (`ㅇㅇ`, `ㄱ`) 수신 | [C-07](#c-07) | soft |
| 답변 레인 → mutation 레인 전환 | [C-07](#c-07), [C-08](#c-08) | hard |
| develop Phase 4.5 병렬 에이전트 | [C-13](#c-13) | soft |
| 신규 훅 추가 | [C-12](#c-12) | hard |
| `doc/` 노트 파일 변경 | [C-06](#c-06) | auto |
| `CLAUDE.md` 편집 필요 | [C-10](#c-10), [C-11](#c-11), [C-15](#c-15) | hard |
| Maintenance 태스크 (MAINTENANCE 마커) | C-01 완화, [C-05](#c-05) 유지 | — |

Levels:
- **hard** — gate blocks or MCP refuses. Violation is impossible by default.
- **soft** — warning/log. Agent must self-correct.
- **auto** — runs in background (hook), advisory.

## 2. Contracts

Every contract below has exactly four fields: **When**, **Enforced by**,
**On violation**, **Why**. If you cannot fill all four, it is not a
contract — move it to design notes.

### C-01

**Title:** Canonical loop — plan → develop → verify → close.
**When:** Any task that mutates repo state (non-maintenance).
**Enforced by:** `plugin/scripts/prewrite_gate.py` (source write blocked
without PLAN.md), MCP `task_close` (rejects pending `runtime_verdict`).
**On violation:** hard-block.
**Why:** Skipping steps loses evidence and provenance — stale verdicts,
missing regression tests, orphan artifacts.

### C-02

**Title:** Plan-first — no source write before PLAN.md exists.
**When:** Any `Write` or `Edit` to a source file on an active task.
**Enforced by:** `plugin/scripts/prewrite_gate.py`.
**On violation:** hard-block with message pointing to plan skill.
**Why:** Implementation without a plan drifts scope and produces unreviewable
diffs.

### C-03

**Title:** CHECKS.yaml updates go through `update_checks.py` only.
**When:** Any AC status transition after plan close (develop, verify).
**Enforced by:** `plugin/scripts/prewrite_gate.py` (direct Write/Edit of
`CHECKS.yaml` is blocked); the CLI bypasses the gate via atomic rename.
**On violation:** hard-block.
**Why:** `reopen_count`, `last_updated`, `evidence` stay consistent.
Hand-edits break audit trail and close-gate accounting.

### C-04

**Title:** `task_close` requires fresh `runtime_verdict: PASS`.
**When:** Task is about to be marked closed.
**Enforced by:** MCP `task_close` — re-syncs touched paths, rejects stale
PASS after any file change post-verify.
**On violation:** hard-block.
**Why:** A PASS issued before the last edit proves nothing about the current
state of the repo.

### C-05

**Title:** Protected artifact ownership.
**When:** Any `Write`/`Edit` to PLAN.md, CHECKS.yaml, HANDOFF.md,
DOC_SYNC.md, or CRITIC__runtime.md.
**Enforced by:** `plugin/scripts/prewrite_gate.py` `PROTECTED_ARTIFACTS`.
**On violation:** hard-block. Agent must route through the owning skill or CLI.
**Why:** Provenance is derived from artifact existence. Wrong writer = wrong
provenance = broken audit chain.

### C-06

**Title:** Note freshness — `invalidated_by_paths` flips `current → suspect`.
**When:** Any SessionStart after files changed in the last commit.
**Enforced by:** `plugin/scripts/note_freshness.py` (SessionStart hook).
**On violation:** auto — stale notes keep `freshness: current` until the
next hook run. Writer-role agents must verify `freshness: current` before
citing a note as authoritative.
**Why:** Notes referencing changed source become dangerous if trusted.

### C-07

**Title:** Short approvals authorize only the last proposed transition.
**When:** User replies with a bare affirmation (`ㅇㅇ`, `ㄱ`, `yes`, `ok`).
**Enforced by:** Harness agent system prompt + invariant § 0.
**On violation:** soft-warn. Agent re-asks explicitly instead of expanding
scope.
**Why:** Silent scope expansion is the single most common source of
unwanted changes.

### C-08

**Title:** Lane switch (answer → mutation) must be explicit.
**When:** A conversation in answer-lane turns into a repo-mutation request.
**Enforced by:** Harness agent prompt — must open planning before writing.
**On violation:** soft-warn + force plan skill before any Write/Edit.
**Why:** Skipping lane switch produces unreviewed, unplanned source changes.

### C-09

**Title:** One repo-mutating task holds write focus at a time.
**When:** A second mutating request arrives while a task is open.
**Enforced by:** Harness agent + MCP `task_start` (queues new task).
**On violation:** soft-warn. New task is queued, not merged into current.
**Why:** Parallel mutations corrupt touched-path tracking and verdicts.

### C-10

**Title:** CLAUDE.md is self-managed via the `maintain` skill.
**When:** Structural changes to rules, contracts, or the operating mode.
**Enforced by:** `plugin/skills/maintain/SKILL.md` — the only skill that
edits CLAUDE.md's harness-managed section.
**On violation:** soft-warn from `contract_lint.py`.
**Why:** Ad-hoc edits to CLAUDE.md drift away from enforcement points.

### C-11

**Title:** `CONTRACTS.md` managed block is not hand-edited.
**When:** Any change to rules between the `harness:managed-begin/end` markers.
**Enforced by:** `plugin/scripts/contract_lint.py` (SessionStart hook) —
detects marker tampering; `maintain` skill regenerates from template.
**On violation:** soft-warn. User can move content to `CONTRACTS.local.md`.
**Why:** The managed block is upgraded atomically on harness release; manual
edits are lost.

### C-12

**Title:** Hooks must fail-safe.
**When:** Any hook command in `plugin/hooks/hooks.json`.
**Enforced by:** Convention: every hook ends with `|| true` and has
`timeout ≤ 10`.
**On violation:** hard-block at review — a new hook without fail-safe is
rejected.
**Why:** A flaky hook that blocks the main session is worse than a missing
hook. The harness must degrade gracefully.

### C-13

**Title:** Weight budget — skills and agent spawns bounded.
**When:** Adding or editing a SKILL.md; spawning parallel agents in a phase.
**Enforced by:** `plugin/scripts/contract_lint.py --check-weight` —
scans `plugin/skills/*/SKILL.md`, soft-warns any file >500 lines.
Limits: SKILL.md ≤ 500 lines; sub-files read once per phase; parallel
agents = 1 by default, more only with explicit manifest/diff trigger.
**On violation:** soft-warn.
**Why:** Harness instability grows super-linearly with loop size. Every
extra phase is a new failure point.

### C-14

**Title:** PASS verdicts require structured evidence.
**When:** `runtime_verdict` transitions to `PASS`.
**Enforced by:** `CRITIC__runtime.md` schema — must contain specific
test/screenshot/log references, not a bare verdict.
**On violation:** soft-warn. `task_close` additionally demands the file
exists and is fresh (C-04).
**Why:** A PASS without evidence is indistinguishable from hallucination.

### C-15

**Title:** Setup must not overwrite user-owned files.
**When:** `setup` or `maintain` skill installs/updates harness files.
**Enforced by:** Skill procedure — `CLAUDE.md` gets at most a 1-line
`@CONTRACTS.md` import; `CONTRACTS.md` respects managed-block markers;
`CONTRACTS.local.md` is never touched once created.
**On violation:** hard-block. Any rewrite of user-authored content must
present a diff via `AskUserQuestion` first.
**Why:** User trust is the most load-bearing contract. Surprise overwrites
break it immediately.

<!-- harness:managed-end -->

@CONTRACTS.local.md
