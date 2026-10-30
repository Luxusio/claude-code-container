# Container launch argument policy

`createContainerLaunchArguments(...).buildPlan` creates a finite plan of ordered
semantic operations. Its domain contracts describe launch options, operations
and the plan; caller identity remains opaque. Construction does not read ports.
Each `buildPlan` first obtains host facts through `observeHostFacts`, then uses
the supplied metadata and identity-label ports while building the operations.

`docker.ts` supplies those observations, including the owner-directory path and
clipboard-file existence. Its public `buildDockerRunArgs` compiles the plan into
native arguments through `bindMountArgs`, `containerManagerSocketMountArgs` and
`runtimeExtraRunArgs`. Runtime discovery, caches, mount inspection, SELinux
observation and path joining remain in the existing runtime facade and native
bindings. These operations retain captured runtime authority and the existing
bind-source, lifecycle, session, credential and device ownership checks.

Argument order and lazy reads are compatibility requirements. Mounts remain
project, credential, Git identity, Claude JSON, isolated Device Lab state/auth,
tool caches, optional ready Lab state, manager socket, SSH, extras and clipboard,
followed by labels and image. Unsupported Lab state creates no state mount or
device exposure; KVM group zero differs from undefined. No privileged flag,
additional validation, retry or resource effect is added.

Daemon socket sources bypass caller-container translation. Ordinary absolute
caller paths translate only in nested Docker, regardless of test-runner markers,
using the first longest destination match with its path boundary. Windows Desktop source
normalization precedes native path joining. Readonly suffix precedes SELinux Z;
named volumes do not relabel. Relabel off/force short circuits remain distinct
from auto Podman observation. Runtime extra arguments observe facts before the
unconditional cgroups override and the conditional nested-container marker.

Verification uses `container-launch-arguments-core.test.ts` for ordered plan
behavior, `container-launch-arguments-facade.test.ts` and `docker-args.test.ts`
for native argument compilation, and the runtime and endpoint tests for captured
authority and mount translation. Strict declaration checks and lifecycle,
bind-source and identity regressions remain required. Compiled and extracted
shipping forms must execute the applications and public facades; source unit
tests alone do not establish distribution parity.

Real Docker/Podman, remote/Colima,
rootless, SELinux and native Windows/macOS acceptance remain separate obligations.
This operation does not certify the full architecture migration.

For local Claude container execution, CCC merges
`permissions.defaultMode: "bypassPermissions"` into the selected CCC-managed
profile's `claude/settings.json`, creating it when absent and preserving other
settings. Invalid or unsafe existing settings are preserved and reported as a
failure. The automatic `--dangerously-skip-permissions` argument is removed;
explicit user arguments remain intact. This is a user-level default, not an
override of project settings, command-line choices or managed policy.
The separate `ccc remote` transport retains its previous launch arguments; it
does not synchronize this local profile setting to the receiving host.

CCC supplies `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1` in the process
launch environment.
Explicit session `--env` values take precedence. The setting applies to Claude
commands; it is not written to a Claude settings file or applied to other tools.
Claude Code 2.1.311 and later read this variable only at launch. In
`bypassPermissions` mode it removes the additional critical-path Bash deletion
confirmation; managed rules and hooks may still require approval. See the
[official variable reference](https://code.claude.com/docs/en/env-vars) and
[permission-mode behavior](https://code.claude.com/docs/en/permission-modes#turn-off-the-critical-path-removal-prompt-in-bypasspermissions-mode).
