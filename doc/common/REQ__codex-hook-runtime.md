# Codex hook runtime across container recreation

Existing Harness hooks and MCP registrations can pin a Python patch release in
the persistent Mise cache. A recreated CCC container may select a cache where
that release is absent. On 2026-10-13 all four registered hooks exited 127 and
Harness MCP failed with ENOENT because Python 3.12.14 was missing, while 3.12.15
was installed. No automatic pruning or particular cache transition was proven.

CCC restores the exact missing release only after verifying the installed
payloads and every existing hook trust digest. Only the registered MCP
interpreter's exact in-home Mise Python path is eligible; missing hook
interpreters must match it. Custom paths, mismatched versions, disabled hooks,
missing payloads and untrusted definitions are preserved without downloading.
Restoration runs inside the existing 120-second process-group deadline and
rechecks readiness. It never rewrites registrations, trust hashes or existing
Python releases, and never aliases one patch release to another.

New Harness installation uses the image's `/usr/bin/python3`, explicitly
installed in all image recipes. The pinned installer resolves its interpreter
when generating hook and MCP commands, so invoking a Mise minor-version alias
would still produce a patch-version path. The system interpreter avoids that
coupling to the replaceable tool cache.

The live recovery installed actual Python 3.12.14 side by side. Four unchanged
hook commands then returned 0 in an isolated directory; the unchanged MCP
command initialized and listed its 11 tools. This does not prove project task
write permissions or review receipt collection. Those are separate boundaries:
the recreated container uses UID 1000, while some retained Harness task files
belong to UID 1001 and have mode 600. Repository-wide ownership changes and
automatic hook trust changes are not authorized by interpreter recovery.

Regression checks execute the assembled Python bootstrap and cover restoration,
reuse, failed installation, unchanged registration bytes, and rejection before
network effects for invalid trust, payloads and runtime paths.
