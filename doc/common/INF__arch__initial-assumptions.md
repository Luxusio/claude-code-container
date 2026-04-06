---
type: INF
status: active
created: 2026-04-01
verify_by: read src/index.ts entry point and trace the main flow
---

# Initial Architecture Assumptions

1. **Single entry point** — `src/index.ts` is the CLI entry, compiled to `dist/index.js`
   - verify_by: `head -50 src/index.ts`

2. **Docker lifecycle in docker.ts** — container create/start/stop/remove logic
   - verify_by: `grep -n 'function\|export' src/docker.ts | head -20`

3. **Session tracking via lock files** — `src/session.ts` manages `~/.ccc/locks/` lock files
   - verify_by: `grep -n 'lock' src/session.ts | head -10`

4. **No runtime dependencies** — package.json has zero `dependencies`, only `devDependencies`
   - verify_by: `node -e "console.log(Object.keys(require('./package.json').dependencies || {}).length)"`
