# Container socket access policy extraction

The original M10l extraction put socket-access decisions and warning state in
`src/application/container-socket-access.ts`. The 2026-10-15 boundary correction
moves the remaining native result decoding into the existing Docker binding.

`ContainerSocketAccessPorts.probe` returns `usable`, `requires-group` with user
and GID, or `unavailable`. `grant` returns `{ok:boolean}`. The application decides
whether to grant and owns warn-once/reset state; it reads no status or output.
Construction validates required synchronous capabilities without running them.

The native binding owns status0/status10 classification and whitespace/user/GID
validation. The existing status-only success policy, leading-zero GIDs and ignored
surplus tokens remain. Dispatch failures propagate; returned failures warn and
continue. Warning state advances before publishing the warning, suppressing
later warnings until reset. Instances keep independent state; Docker composes
one instance for the existing module lifetime and public reset hook.

The binding retains the exported fixed scripts, default-user probe, root grant,
selected runtime, exact argv/stdio and final selected target. Both commands keep
10-second bounds; grant keeps its inner8-second timeout and2-second kill grace.
No permission, retry or socket-owner/mode policy changes.

Existing socket core/type/facade suites cover semantic decisions, native
normalization and bounded native calls. Getter/coercion evaluation traces are
not a compatibility requirement. The ordinary workspace package checker checks
shipping generally; it does not contain a dedicated socket verifier. Actual
compiled socket consumers and strict declarations must be qualified separately
when that binding changes. This note does not claim that qualification ran.

Portable fixtures do not certify real socket permissions, native Windows/macOS,
rootless UID/SELinux or remote providers. Whole migration, native-platform,
reliability and formal completion remain separate acceptance conditions.
