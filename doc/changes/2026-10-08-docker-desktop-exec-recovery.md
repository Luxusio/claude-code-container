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

New Docker Desktop containers use one quarter of the engine VM's reported RAM,
up to 8 GiB, rounded down to MiB. A 32 GiB VM therefore gives each new CCC
container an 8 GiB memory cap; an 8 GiB VM gives 2 GiB. The equal memory/swap
cap prevents container workloads from exhausting shared VM swap. An unavailable
or invalid memory observation refuses unlimited creation. Explicit positive
`CCC_CONTAINER_MEMORY` values, such as `4g`, override the default. Native Docker
and Podman retain existing defaults unless that override is provided.

CCC sessions default `CARGO_BUILD_JOBS` to `2`, including reused containers.
Forwarded host values and explicit `--env CARGO_BUILD_JOBS=...` retain precedence.
The per-session change works with an existing image; no project Cargo config
is edited. A container reaching its own cap may still fail a build or lose a
process; the cap reduces the risk of VM-wide failure, not every possible OOM.

Existing containers retain their old memory settings. Updating the CLI does not
retroactively rewrite Docker HostConfig. Apply an explicit resource update to
the intended owned container, or create a new one, to obtain the memory cap.
No running container is silently stopped or recreated for this repair.
Final build, package and independent review/QA remain required.
No API version override, Docker reset, volume deletion, hosted CI or remote push
is part of this repair. The architecture migration remains paused.
