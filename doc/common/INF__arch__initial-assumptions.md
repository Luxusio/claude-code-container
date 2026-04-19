---
type: INF
status: active
created: 2026-04-01
verify_by: read src/index.ts entry point and trace the main flow
---

# Initial Architecture Assumptions

1. **Single entry point** — `src/index.ts` is the CLI entry, compiled to `dist/index.js`
   - verify_by: `head -50 src/index.ts`

2. **Runtime-agnostic container lifecycle** — `src/docker.ts` drives either Docker or Podman via the abstraction in `src/container-runtime.ts`. No `"docker"` string literal survives as a `spawnSync` first argument in production source.
   - verify_by: `rg -n 'spawnSync\(\s*"docker"' src/` → 0 hits

3. **Runtime selection deterministic and cached** — `getRuntimeInfo()` resolves once per process in this order: `--runtime` flag, `CCC_RUNTIME` env, podman on PATH, docker on PATH.
   - verify_by: `grep -n 'resolveRuntime\|getRuntimeInfo' src/container-runtime.ts`

4. **Podman rootless + SELinux handled automatically** — `--userns=keep-id` applied on rootless Podman; `:Z` appended to bind mounts when SELinux is enforcing (gated by `CCC_SELINUX_RELABEL`). Docker path is unchanged from before.
   - verify_by: read `bindMountArgs`, `runtimeExtraRunArgs` in `src/container-runtime.ts`

5. **Session tracking via lock files** — `src/session.ts` manages `~/.ccc/locks/` lock files
   - verify_by: `grep -n 'lock' src/session.ts | head -10`

6. **No runtime dependencies** — package.json has zero `dependencies`, only `devDependencies`
   - verify_by: `node -e "console.log(Object.keys(require('./package.json').dependencies || {}).length)"`
