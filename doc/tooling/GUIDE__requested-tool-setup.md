# Requested tool setup

`createRequestedToolSetup` owns supported Claude and Codex setup order. `ensure(target, activeTool)` first ensures the Claude launcher for Claude or installs the selected npm tool for Codex. It then probes the launcher and, only after successful Codex readiness, ensures the Codex sandbox. Container installation remains in the accepted container-tool installation application and its native bindings.

The Claude probe uses the domain launcher path. Codex uses `/home/ccc/.local/bin/` plus the configured binary, falling back to the tool name. The native `ensureTools` composition executes the launcher check through the selected container runtime with a 15000 ms timeout. Timeout produces a specific readiness error; any other probe error or nonzero status reports that the requested tool is unavailable after setup. Failed readiness prevents sandbox preparation.

Three required effect ports—`ensureClaudeLauncher`, `ensureNpmTool` and `ensureCodexSandbox`—return `undefined`, so ordinary asynchronous implementations cannot satisfy their synchronous completion contract. Native wrappers call the existing installation or sandbox function and then return `undefined`. `probeLauncher` returns the actual finite status/error observation. The application receives the canonical tool descriptor directly; this change does not snapshot or freeze its existing mutable behavior.

Container loss, restart and readiness recovery belong to the separate index/container-exec workflow. Requested-tool setup does not take over that recovery or add another container lifecycle. The retained conditional OpenCode prelude is outside the supported Claude/Codex scope and remains untouched; this contract correction does not establish unrestricted whole-tool completion.
