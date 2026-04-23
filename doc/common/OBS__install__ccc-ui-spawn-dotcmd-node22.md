---
type: OBS
status: active
created: 2026-04-11
updated: 2026-04-11
tags: [nodejs, windows, spawn, cve-2024-27980, ccc-ui, install]
evidence: |
  TASK__ccc-ui-launch-path-collision — 63/63 tests pass, npm run build exit 0, CRITIC__runtime.md verdict PASS;
  AC-008 PENDING_USER (Windows manual verification of Tauri window launch)
---

# Node.js 22 spawnSync(.cmd) silent-fail — how ccc ui launcher was losing its exit status

## The bug

`ccc ui` on Windows produced zero output and a success exit code, hiding a spawn
failure entirely. The launcher (`src/ui-launcher.ts::launchUi`) was calling
`spawnSync("...ccc-ui.cmd", extraArgs, { stdio: "inherit" })` without `shell: true`.
On Node.js 22 that triggers the CVE-2024-27980 mitigation, which rejects `.cmd` / `.bat`
execution unless `shell: true` is explicitly set. The rejected spawn returns a result
shaped as `{ status: null, error: new Error(...) }`. The error code is
`ERR_INVALID_ARG_VALUE` (or a close variant depending on Node 22 patch level).

## Why it was silent

Two bugs compounded:

(a) Node 22 refuses the spawn and returns `null` status with a populated `error` field
on the result object.

(b) The caller did `process.exit(result.status ?? 0)`. The nullish coalescing operator
only falls back on `null` / `undefined`, so `null ?? 0` evaluates to `0`, and
`process.exit(0)` exits silently with a success code.

The `result.error` field was never inspected, so nothing was printed. PowerShell saw
exit code 0 and moved on as if `ccc ui` had launched normally.

## CVE-2024-27980 background (brief)

Node.js 22's `child_process` layer applies a security mitigation for the
CVE-2024-27980 "BatBadBut" command-injection vulnerability on Windows. The mitigation
refuses to spawn `.cmd` and `.bat` targets without `shell: true`, because shell
semantics are the only safe way to escape arguments for `cmd.exe`. The result is that
legacy code which spawns a `.cmd` shim directly stops working on Node 22+ without a
clear error path.

## Detection signals

`result.status === null` AND `result.error instanceof Error` AND `result.error.code`
containing `INVALID_ARG`. A caller inspecting only `result.status` sees a
plausible success-shaped return and propagates it silently.

## Project-specific fix

Two-part fix, both in this repo:

### 1. Split `spawnPath` from `binPath`

`scripts/ui-toolchain.js::installedUiBinPaths` (lines 440-460) and its duplicate
`src/ui-launcher.ts::_uiBinPaths` (lines 11-31) both now return a `spawnPath` field
alongside the existing `binPath`.

- `binPath` keeps its historical meaning as the addressable CLI shim (`.cmd` on
  Windows, shell wrapper on Linux) that `scripts/install.js` writes during Phase 8.
- `spawnPath` names the actual binary to hand to `spawnSync`: on Windows it is
  `ccc-ui.exe` (line 448 in `ui-toolchain.js`, line 19 in `ui-launcher.ts`); on Linux
  it is the same shell wrapper as `binPath` (Linux never had the silent-spawn problem
  because the shell wrapper is a regular exec target, not a Windows `.cmd`).

### 2. Surface spawn errors and default to exit 1

`src/ui-launcher.ts::launchUi` (lines 80-86) now:

```ts
const result = spawnSync(spawnPath, extraArgs, { stdio: "inherit" });
if (result.error) {
    console.error(`ccc ui: failed to spawn ${spawnPath}:`);
    console.error(`  ${result.error.message}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
```

The `result.error` guard prints both the path and the error message before
`process.exit(1)`. The final fallback is `?? 1` instead of `?? 0`, so any future
`null` status (child did not run to completion) also surfaces as a non-zero exit.

## When Phase 8 .cmd shim still matters

The `.cmd` shim at `paths.binPath` is still installed by `scripts/install.js` Phase 8
(line 262: `writeFileSync(paths.binPath, cmdContent)`) and removed by uninstall phases
(lines 502-509, 528-536). It remains a user-addressable entry point for users who want
to invoke the UI from a shell without going through `ccc ui`. The shim and `spawnPath`
are intentionally orthogonal; do not remove the shim when removing the silent-spawn bug.

## Why not `shell: true`

Keeping `binPath` pointing at `.cmd` and adding `shell: true` would also require
careful argument escaping to avoid re-introducing CVE-2024-27980 itself. Spawning the
native `.exe` directly is both safer and simpler. On Linux the question does not arise
because `binPath` is a real shell wrapper, not a Windows `.cmd`.

## Test harness

`src/__tests__/ui-command.test.ts` has a test case `'surfaces spawnSync error and exits 1'`
that mocks `spawnSync` to return
`{ status: null, error: new Error('EINVAL spawn ccc-ui.exe'), pid: 0, output: [], stdout: '', stderr: '', signal: null }`
and asserts both that `console.error` was called with a string containing
`'EINVAL spawn ccc-ui.exe'` AND that `process.exit(1)` was invoked. This is the
regression canary for the silent-spawn bug class.

`src/__tests__/install-paths.test.ts` asserts `spawnPath` ends in `.exe` on win32 and
equals the shell wrapper on linux; existing `binPath` assertions are preserved
unchanged.

## Prompted by

TASK__ccc-ui-launch-path-collision (2026-04-11). The task slug reflects the original
(wrong) hypothesis that a stale npm-global `ccc.cmd` earlier on PATH was being invoked.
Diagnostic showed the mise-node `ccc.cmd` was an `npm link` symlink back to the user's
local repo, so both PATH entries routed to the same `dist/index.js`. The PATH-collision
theory was a red herring; the real root cause was the `.cmd` spawn behavior documented
in this note.

## Related notes

Predecessor Windows bring-up chain (all closed PASS):

- `OBS__install__npm-optional-deps-4828.md`
- `OBS__install__tauri-windows-icon-ico.md`
- `OBS__install__windows-rust-exe-suffix.md`
