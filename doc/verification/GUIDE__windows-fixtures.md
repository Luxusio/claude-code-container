# Windows fixture portability and isolation

Use the existing test-home environment helper when native or child code calls `os.homedir()`. Changing `HOME` alone does not isolate Windows; keep `USERPROFILE`, `HOMEDRIVE` and `HOMEPATH` consistent and restore the caller's environment. A fixture must never use the developer's `.ccc`, Git config or credentials as test data.

Use native path operations for host receipts, locks, mounts and filesystem names. Git porcelain and container paths have their own POSIX spelling; compare those formats explicitly without changing production identity checks. Fixture Git configuration must be local to a temporary environment and control newline conversion without editing the host's global settings. When replacing hidden Git metadata, preserve the inode if the scenario is an in-place modification.

Keep portable contracts enabled on Windows. Capability-scope only execution that actually needs the Linux container's POSIX shell, GNU tools, permissions or an unavailable native filesystem feature. A dedicated file-symlink case may use the existing permission-aware helper; split independent hardlink, oversized-file and directory assertions first. Expected failures must not pass merely because the executable is absent.

Subprocess fixtures must model current native launch and process identity APIs, including Windows PID reuse and asynchronous exit witnessing. Do not replace positive process settlement with PID absence, arbitrary delays or weaker cleanup checks. A timeout regression involving native identity probes needs evidence at the deadline and owned process exit boundaries.

For saved-run repairs, account for every failed file and case. Linux regressions and simulated Windows paths support portability checks but do not establish native Windows acceptance. Retain that distinction in the final result.

Record the native Node and libuv versions and match the reported runtime before attributing new failures to the candidate. Older Windows libuv releases can disagree between descriptor and path device identities; do not remove identity checks to accommodate a different QA runtime. A native socket fixture should use available system facilities: Windows PowerShell and .NET can retain an allocated TCP socket without listening, without requiring a Python installation.
