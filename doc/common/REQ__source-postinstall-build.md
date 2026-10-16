# Source installation must report build failure

Installing dependencies in the source repository must build the CLI successfully
before npm reports success. A failed build must propagate its error and give the
postinstall process a nonzero exit status. A warning followed by success leaves
old compiled code available and must not be used as proof that fixes are installed.

Postinstall from an npm package still skips the build because that package ships
its compiled artifacts. Successful source postinstall performs only the source
build; it does not build a container image, install a global launcher, or edit PATH.
Failure handling must not delete a previously usable CLI or alter runtime/session
lock ownership. Dependency installation with explicit `--ignore-scripts` remains
an opt-out; callers must complete `npm run build` before using source artifacts.

Verify these behaviors through the real installer subprocess tests in
`src/__tests__/install-global.test.ts`, with source and packaged fixtures.

## Legacy sudo build outputs

On POSIX sudo installation, validate the invoking numeric UID/GID before any
recovery. Recover only root-owned physical directories and regular files under
the generated roots `dist`, `packages/hyper-v/dist` and `packages/device-lab/dist`
before running the build as that user. The physical `node_modules/@ccc` directory
may be recovered nonrecursively because the build creates workspace links there;
neither its children nor `node_modules` itself are ownership-repair targets.

Preflight all selected roots before changing ownership. Missing outputs are
harmless. Reject redirected fixed ancestors/output roots, root-owned hardlinked
regular files, set-ID entries and unsupported file types. Never follow or modify
interior symlinks. Preserve nonroot owners, contents and ordinary permission
modes; do not repair source files, dependency trees or credentials.

A recovery error must prevent build and installation publication. Some native
ownership operations may already have succeeded when a later one fails; retain
those actual effects without inverse chown or a root build fallback. The previous
installed CLI remains usable. Ordinary-user, Windows, direct-root-without-sudo,
import-only and packaged postinstall paths retain their existing behavior.
