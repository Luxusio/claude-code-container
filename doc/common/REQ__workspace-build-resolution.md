# Runtime workspace resolution during source builds

Source build and global installation must compile Hyper-V before Device Lab and
resolve both runtime packages from the current checkout. Moving a checkout must
not leave its generated npm workspace links pointing at an old machine's path.

The full `npm run build` entrypoint and the `build` and `assemble` modes of
`scripts/workspace-build.mjs` must share one project-local mutation guard for
the same physical checkout. A full build holds it across package compilation,
bootstrap assembly, CLI compilation, checks, bundles and final assembly;
`npm run build:packages` and `npm run assemble:packages` wait for that same guard.
Use the existing qualified shared-mutation implementation, including its stale
owner recovery and release rules, with a bounded five-minute acquisition wait.
Do not add a separate PID lock protocol or infer ownership from timestamps.
Private stage bodies allow the full build to keep one guard without recursively
acquiring a lock that deliberately rejects local reentry. Other checkouts have
independent guards. Direct compiler calls and standalone bundle scripts remain
outside this entrypoint contract.

The guard must load before any generated package output or workspace-link repair
is available. Source builds load its raw provider module; source-less payloads
load the embedded copy only when the raw file is absent. Permission and module
initialization errors must propagate. Reading process identity must not eagerly
load compiled process-exit code; the asynchronous native exit fallback loads it
inside the already captured allowance and charges that loading time to the same
deadline.

Concurrent assembly on Windows has reproduced missing exports and copy/remove
sharing failures. Sequential copies and a complete native build also passed;
that evidence does not establish that the original reported invocation had a
second producer. Regression checks must exercise concurrent entrants, complete
imports, failure/retry cleanup, and cold and warm full builds without requiring
the developer to repair partial generated files by hand.

Before removing any package build output, validate the two literal workspace
packages and their manifests, dependency parents and link entries. Repair only
missing or incorrectly targeted symbolic links for `@ccc/hyper-v` and
`@ccc/device-lab`. Use relative links on POSIX and directory junctions on Windows.
Keep correct relative or absolute links unchanged.

Never delete a link's target. Preserve physical package directories/files and
refuse redirected dependency parents with an actionable dependency-install
diagnostic. Permission errors must not be mistaken for absent paths. Do not run
network installation, alter package versions, or suppress compiler errors as
automatic repair.

On Windows, an unreadable literal workspace entry (EACCES or EPERM) may be a
WSL/Linux symbolic link with reparse tag `0xa000001d`. Query that exact entry
using the system fsutil executable. Only a successful query with that exact tag
authorizes repair; other tags, malformed responses and query errors must preserve
the original permission error. Ordinary permission failures remain failures.

Validate both dependency entries before repairing either. Before removing an
LX entry, query its tag again. Remove only its reparse metadata, then remove the
remaining empty directory nonrecursively and create the existing Windows junction.
Never delete the link target or remove directory contents. A changed tag, failed
native command, nonempty directory or junction creation error stops the build
before any package output cleanup. Native calls must be bounded, hidden and use
argument arrays without a shell or automatic elevation.

Verify the new branch through isolated native-boundary simulations and the
existing real compiler/import regressions. Native Windows acceptance additionally
requires rebuilding a checkout containing a genuine LX link on Windows.

Both Dockerfile and Containerfile mcp-builder stages must copy the workspace
build script and all its local module dependencies before execution. Verify the
local import closure from both recipes, independently of the npm files allowlist.

Verify with real NodeNext compilation and Node imports in isolated workspaces:
missing, dangling and foreign links; correct links across repeated builds;
exported index/lifecycle/low-level imports; preserved external sentinels; and
rejected physical entries or parent redirections without losing existing output.
Portable tests do not certify native macOS global installation or Windows
junction permissions; those require their respective hosts.
