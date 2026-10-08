# Docker Desktop memory pressure and CCC update recovery

The copied Docker Desktop logs show VM memory pressure before engine API errors:

| UTC, 2026-10-08 | Evidence |
| --- | --- |
| 12:06:34 | `init.log.20261008-214403.709:1965`: page allocation failure; lines 2033–2045 show anonymous-memory pressure, memory below the low watermark and zero free swap out of 8 GiB. |
| 12:13:11 | `electron-2026-10-08.log:1237`: `/containers/json` returned HTTP 500. |
| 12:38:43 | `init.log.20261008-214403.709:2086`: Node PID 4242 was an OOM victim. Its reported `total-vm` is virtual memory, not resident usage. |
| 12:44:07–22 | Docker backend records WSL bootstrap failure, engine shutdown and automatic recovery. |

Rust compilation may have contributed, but these logs do not identify Rust as
the culprit or map the killed Node process to a retained container. The earlier
container identified in the page-allocation event no longer exists. Actual
Docker CLI 29.8.1 and Desktop 4.94.0 / Engine 29.8.2 both support API 1.56;
the generic API-version error text is not evidence of a version mismatch.

CCC now stops known engine transport failures during mount verification and
Codex preparation instead of escalating a failed SSH challenge as root or
continuing another tool exec. Relevant mount/identity inspection calls have
five-second deadlines. Unknown inspection never authorizes container replacement.
Ordinary SSH permission and unsupported-Codex-feature behavior is preserved.

The source installer accepts:

```powershell
npm run install:global -- --skip-image
```

This still builds CCC and installs its CLI, but performs no Docker/Podman probe
or image build. Default installation bounds image inspections and image builds,
and reports CLI and container-image outcomes separately. Image failure remains
nonfatal to CLI installation, matching the existing runtime-optional intent.

The operator subsequently requested removal of the newly added container
memory limits and Cargo parallel-job default. Both policies and their dedicated
tests were removed. CCC no longer adds memory/swap flags, queries VM RAM for
this policy, reads `CCC_CONTAINER_MEMORY`, or supplies `CARGO_BUILD_JOBS=2`.
Existing user environment forwarding and explicit Cargo preferences retain
their original behavior. Existing containers were never modified.

Docker transport diagnosis, bounded inspections and the `--skip-image` update
path remain. These changes improve failure handling and CLI update reliability;
they do not impose workload resource policy or guarantee prevention of OOM.
No API version override, Docker reset, volume deletion, hosted CI or remote push
is part of this repair. The architecture migration remains paused.
