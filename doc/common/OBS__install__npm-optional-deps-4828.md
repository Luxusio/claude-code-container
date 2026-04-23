---
type: OBS
status: active
created: 2026-04-10
updated: 2026-04-11
tags: [npm, windows, optional-deps, tauri, install]
evidence: |
  TASK__tauri-cli-win32-optional-deps — 22/22 tests pass, npm run build exit 0 (CRITIC__runtime.md verdict PASS);
  TASK__tauri-cli-optional-deps-fallback — 38/38 tests pass (4 files), npm run build exit 0, AC-001–AC-006 PASS (CRITIC__runtime.md verdict PASS); AC-007 PENDING_USER (Windows manual verification);
  TASK__npm-optional-deps-env-override — 45/45 tests pass (5 files), npm run build exit 0, AC-001–AC-005 PASS (CRITIC__runtime.md verdict PASS); AC-006 PENDING_USER (Windows manual verification with os=linux in .npmrc)
---

# npm/cli#4828 — Platform-Specific Optional Deps Skipped When Lockfile Is Cross-Platform

## The bug

[npm/cli#4828](https://github.com/npm/cli/issues/4828): npm's optional-dependency
resolver skips installing platform-specific native-binding packages when the committed
`package-lock.json` was generated on a different host platform.

Packages like `@tauri-apps/cli` ship platform-specific native bindings as optional
dependencies (e.g. `@tauri-apps/cli-win32-x64-msvc`, `@tauri-apps/cli-darwin-arm64`,
etc.). Their `index.js` calls `requireNative()`, which `require`s the correct `.node`
binding at runtime. If the binding for the current platform is absent from
`node_modules/`, this throws at load time.

## Symptoms

Running `npm install` in a directory where `package-lock.json` was generated on a
different platform (e.g. Linux-committed lockfile, Windows install host) leaves the
current-platform optional-dep missing from `node_modules/`. At runtime:

```
Cannot find module '@tauri-apps/cli-win32-x64-msvc'
```

The error message itself includes the authoritative workaround:
> "Please try `npm i` again after removing both package-lock.json and node_modules directory."

## Why the lockfile looks correct

The lockfile DOES list all platform variants under `optionalDependencies` and as
`node_modules/` entries with `os`/`cpu` constraints. The lockfile is not corrupt.
The bug is in npm's dependency resolver, which misreads the cross-platform lockfile
and skips the current-platform native package during install. Auditing the lockfile
with `grep` or `cat` gives a false sense of correctness.

Example: `ui/package-lock.json` in this project has entries for
`@tauri-apps/cli-win32-x64-msvc` at lines 1151 and 1324 — yet `npm install` on
Windows does not install it.

## Authoritative workaround

Remove **both** `package-lock.json` AND `node_modules/` before running `npm install`.
This forces a full cold-cache, platform-specific resolution pass. Do not use
`npm install --force` or `npm ci`; these do not reliably fix the issue.

## Project-specific implementation

### Phase 6a helper — `cleanUiDepsForFreshInstall`

`cleanUiDepsForFreshInstall(uiDir, opts = {})` in `scripts/ui-toolchain.js`
(lines 267-307) handles variant 1 (cross-platform lockfile mismatch):

- Accepts the `ui/` directory path and an optional mockable `fs` injection.
- Uses `existsSync` pre-check before each `rmSync` call — idempotent.
- `rmSync(nodeModulesPath, { recursive: true, force: true })` for the directory.
- `rmSync(lockfilePath, { force: true })` for the lockfile.
- Returns `{ removedNodeModules: boolean, removedLockfile: boolean }` for logging.

Invoked from `scripts/install.js` Phase 6a (`"Pre-clean ui deps (npm/cli#4828)"`) at
lines 204-211, immediately before Phase 6's `npm install` spawnPhase. Logs which
paths were removed (or "skipped" when neither existed).

### Phase 6b helper — `ensureTauriCliPlatformBinding`

`ensureTauriCliPlatformBinding(uiDir, opts = {})` in `scripts/ui-toolchain.js`
(lines 355-416) handles variant 2 (global optional-dep suppression). It is a companion
to `cleanUiDepsForFreshInstall`, not a replacement. See the
"Second variant: optional deps suppressed globally" section above for full details and
algorithm. Invoked from `scripts/install.js` Phase 6b (lines 227-229) after Phase 6's
`npm install --include=optional`.

### Phase 6 / 6b --os and --cpu CLI flags

`--os=${process.platform}` and `--cpu=${process.arch}` are passed in the Phase 6
`spawnPhase` argv in `scripts/install.js` at lines 221-222, appended after
`--include=optional`. These flags override any `os` / `cpu` entries in the user's
`~/.npmrc` at the CLI config layer (highest precedence: CLI > env > .npmrc), forcing
the npm resolver to treat the host as the correct platform and architecture for
optional-dep resolution. This is the systemic fix for variant 3 and covers ALL
platform-specific native-binding optional dependencies (tauri-cli, rollup, esbuild,
and any future additions) in one shot.

The same flags appear in the `ensureTauriCliPlatformBinding` fallback spawn in
`scripts/ui-toolchain.js` at lines 397-398, using the helper's already-resolved
`platform` / `arch` locals (from `opts.platform ?? process.platform` and
`opts.arch ?? process.arch`) for testability. The `--os` / `--cpu` flags are no-ops
on healthy systems where the user's `.npmrc` does not contain conflicting `os` / `cpu`
settings.

## When to apply this pattern

Apply when ALL of the following are true:

1. The install pathway runs `npm install` against a committed `package-lock.json`.
2. The lockfile was (or may have been) generated on a different host platform.
3. A native-binding JS wrapper is loaded at runtime (loads a `.node` binary via
   `require`).

Do NOT apply to developer workflows where lockfile reproducibility matters. Developers
who run `npm install` inside a fresh clone on their own platform should generate a new
lockfile naturally; deleting it in that context would break lock-based reproducibility
guarantees.

## Tradeoff

Phase 6 now performs a cold-cache install on every global install invocation. This
adds ~10-30s to total install time. This is an acceptable cost for reliable Windows
support.

## Second variant: optional deps suppressed globally

### Observed symptom

Even after Phase 6a deletes `node_modules/` and `package-lock.json`, a subsequent
`npm install` on a cold cache can still leave the current-platform binding missing.
Concretely: Windows user on 2026-04-11, Node v22.22.0, npm reported "added 76
packages" after Phase 6a ran successfully — yet `@tauri-apps/cli-win32-x64-msvc` was
absent from `ui/node_modules/`. Phase 7 then failed with `Cannot find module
'@tauri-apps/cli-win32-x64-msvc'`.

This is distinct from variant 1 (cross-platform lockfile mismatch): in variant 2, the
lockfile has already been regenerated from scratch, so the lockfile itself is not the
cause.

### Root cause

The user environment globally suppresses optional dependencies. Known triggers:

- `omit=optional` set in a project or user-level `.npmrc`.
- `NPM_CONFIG_OMIT=optional` in the shell environment.
- `NODE_ENV=production` in some npm version combinations (npm omits optional deps in
  production mode).
- A resolver bug in certain npm versions that causes optional deps to be dropped
  silently even without an explicit `omit` directive.

### Detection

```bash
# Check npm config
npm config get omit

# Check environment (PowerShell on Windows)
$env:NPM_CONFIG_OMIT
$env:NODE_ENV

# Check environment (POSIX shell)
echo $NPM_CONFIG_OMIT
echo $NODE_ENV
```

If `npm config get omit` returns `optional` (or a list containing `optional`), this is
the direct cause.

### Mitigation in this project

Two-layer defense wired into `scripts/install.js`:

**Layer 1 — Phase 6 `--include=optional` flag** (`scripts/install.js` line ~216):

```js
spawnPhase("Install UI frontend dependencies (npm install)", "npm",
    ["install", "--include=optional"], { cwd: uiDir, ... });
```

`--include=optional` overrides `omit=optional` npm config and `NPM_CONFIG_OMIT` env
for the duration of that `npm install` call. This is sufficient in most cases.

**Layer 2 — Phase 6b probe + fallback** (`scripts/install.js` lines ~227-229):

```js
runPhase("Verify @tauri-apps/cli platform binding (npm/cli#4828)", () => {
    ensureTauriCliPlatformBinding(uiDir);
});
```

`ensureTauriCliPlatformBinding(uiDir)` is exported from `scripts/ui-toolchain.js`
(lines 355-416). Its algorithm:

1. Calls `getTauriCliBindingName(process.platform, process.arch)` (lines 322-334) to
   resolve the expected binding name (e.g. `@tauri-apps/cli-win32-x64-msvc`). Returns
   `{ status: "skipped" }` if the platform/arch combo is unknown.
2. Calls `fs.existsSync` on `ui/node_modules/<binding>`. Returns
   `{ status: "present", name }` if found — no spawn, O(1) cost.
3. Reads `ui/node_modules/@tauri-apps/cli/package.json` to get the installed version.
   Throws if `@tauri-apps/cli` is not installed.
4. Spawns `npm install <name>@<version> --no-save --include=optional` with
   `cwd: uiDir`.
5. Re-probes `existsSync`. If still missing, throws a descriptive error:
   > "Fallback install did not place `<name>` in node_modules. Your npm is suppressing
   > platform-specific optional dependencies. Check: `npm config get omit`,
   > NPM_CONFIG_OMIT env, NODE_ENV."
6. Returns `{ status: "installed", name, version }`.

If Phase 6b throws, the install surfaces as `[UI] FAILED:` (same pattern as other
phases) and halts. The error message names the missing binding and directs the user to
check `npm config get omit`.

### When Phase 6a is still needed vs. when Phase 6b takes over

Phase 6a (`cleanUiDepsForFreshInstall`) handles **variant 1**: the committed
`package-lock.json` was generated on a different platform, so npm's resolver skips the
current-platform binding. Deleting both `node_modules/` and `package-lock.json` forces
a clean resolution pass. Phase 6a must remain in place — do not remove it.

Phase 6b (`ensureTauriCliPlatformBinding`) handles **variant 2**: even a fresh install
(no lockfile, no `node_modules`) leaves the binding missing because `omit=optional` or
an env var suppresses optional deps globally. Phase 6b acts as a safety net after Phase
6's `--include=optional` attempt.

Both phases are needed; neither subsumes the other.

### Helper contracts

**`getTauriCliBindingName(platform, arch)`** (`scripts/ui-toolchain.js` line 322)

- Pure function. Returns `string | null` (never `undefined`).
- Lookup of `process.platform` + `process.arch` to the correct `@tauri-apps/cli-*`
  package name. Returns `null` for unknown combinations.

**`ensureTauriCliPlatformBinding(uiDir, opts = {})`** (`scripts/ui-toolchain.js` line 355)

- Injectable opts: `fs` (needs `existsSync` + `readFileSync`), `spawnSync`, `platform`,
  `arch`, `log`. All default to Node.js builtins / `process` fields.
- Returns `{ status: "skipped" }` | `{ status: "present", name: string }` |
  `{ status: "installed", name: string, version: string }`.
- Throws on fallback failure or if `@tauri-apps/cli` is not installed.

## Variant 3: user .npmrc os= config forces wrong-platform resolution

### Observed symptom

Windows user, 2026-04-11, npm 10.9.4, Node v22.22.0.

- **First run**: `@tauri-apps/cli-win32-x64-msvc` was absent after Phase 6 completed.
  Phase 6b fallback detected the missing binding and installed it directly; Phase 7
  then failed on `@rollup/rollup-win32-x64-msvc`, confirming the issue is not
  tauri-cli-specific — any platform-specific optional native binding is affected.
- A second missing optional binding (`@rollup/rollup-win32-x64-msvc`) confirms the
  root cause operates at the resolver level, not at the per-package level.

### Root cause

The user's `~/.npmrc` contained:

```
os = "linux"
```

The npm `os` config (documented in npm 10+) forces the dependency resolver to treat
the host as Linux during optional-dep resolution. Win32 bindings (with `"os":
["win32"]` in their `package.json`) do not match the resolver's forced `os` value and
are silently skipped.

`--include=optional` (variant 2 mitigation) operates on a different config layer
(omit/include set) and cannot override the `os` config. The two settings are
orthogonal: `--include=optional` controls whether optional deps are attempted at all;
`os` controls which platform the resolver assumes when filtering `os`-constrained
packages.

### Why Phase 6b fallback still worked for tauri-cli but rollup still failed

When a package is requested by explicit name (e.g.
`npm install @tauri-apps/cli-win32-x64-msvc@2.10.1`), npm installs it directly by
name without running the full optional-dep resolver os-filter. That is why Phase 6b's
single-binding fallback could succeed for tauri-cli while the primary Phase 6 install
still missed rollup's binding (which has no equivalent Phase 6b fallback).

### Detection

```powershell
# PowerShell / Windows
npm config get os
npm config list
type $env:USERPROFILE\.npmrc
```

```bash
# POSIX
npm config get os
npm config list
cat ~/.npmrc
```

If `npm config get os` returns anything other than the host platform (or `undefined`),
this variant is active.

### Authoritative fix

Pass `--os=${process.platform}` and `--cpu=${process.arch}` CLI flags to every
`npm install` invocation inside the installer. CLI flags have the highest config
precedence (CLI > env > .npmrc), so they override the user's `os=linux` setting at
the resolver level. This fixes ALL platform-specific optional native bindings (tauri-cli,
rollup, esbuild, and any future additions) in one shot — it is the systemic
root-cause fix, not a per-package patch.

Requirement: npm 10+. The project toolchain pins Node 22+ / npm 10+; older npm is
not supported.

The installer must not edit the user's `~/.npmrc`. CLI flags override without side
effects and are no-ops on healthy systems.

### Project-specific implementation

See "Phase 6 / 6b --os and --cpu CLI flags" subsection under "Project-specific
implementation" above.

- `scripts/install.js` Phase 6 `spawnPhase` argv: `--os=${process.platform}` at
  line 221, `--cpu=${process.arch}` at line 222.
- `scripts/ui-toolchain.js` `ensureTauriCliPlatformBinding` fallback `spawnFn` argv:
  `--os=${platform}` at line 397, `--cpu=${arch}` at line 398, using the helper's
  resolved `platform` / `arch` locals for testability.

### When to apply

Apply whenever an installer runs `npm install` against a package tree with
platform-specific native-binding optional dependencies, on hosts where the user's
`~/.npmrc` may contain an `os` or `cpu` override. The flags are no-ops on healthy
systems.

## Prompted by

Task `TASK__tauri-cli-win32-optional-deps` (2026-04-10). Predecessor task
`TASK__ui-sidecar-windows-exe` fixed the Phase 5 `.exe` suffix bug that masked this
issue — once Phase 5 succeeded, Phase 7 revealed the missing native binding.

## Related note

`doc/common/OBS__install__windows-rust-exe-suffix.md` — sibling Windows install bug:
Rust `.exe` suffix handling and Tauri `externalBin` extensionless convention.
