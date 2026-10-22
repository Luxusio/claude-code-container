---
type: REQ
status: active
created: 2026-09-26
source: user report ("테스트 하면서 도커에 쓰레기 볼륨이 어마어마하게 생긴다"), investigated in the ccc containers on a Docker Desktop (WSL2) host
---

# Container init and container-manager socket access

A ccc container must reap orphaned processes, and its default user must be able
to use the mounted container-manager socket without `sudo`.

## Intent

ccc containers ran `tail -f /dev/null` as PID 1. `tail` never reaps children, so
every process whose parent exited stayed a zombie: clipboard shims, killed test
JVMs, and background helpers. One container had 173 zombies and another had 613.

The container-manager socket is mounted at `/var/run/docker.sock`. On Docker
Desktop it is `root:root 660` inside the container. The image adds `ccc` to its own
`docker` group, which does not match that gid. So the Docker CLI documented as
working inside the container failed with "permission denied", and agents fell back
to `sudo`.

## Observable behaviors

1. Every ccc container is created with `--init`. PID 1 is the runtime's init:
   `docker-init` (tini) on Docker, catatonit on Podman. It reaps orphaned
   children, so zombies do not accumulate. `docker stop` now ends the container
   promptly instead of waiting for the stop timeout.
2. The run contract requires `HostConfig.Init` to be `true`. An existing
   container created before this change is recreated once, using the same rules as
   earlier contract changes:
   - a stopped container is recreated on its next start;
   - a running container is preserved and replacement deferred until it stops,
     including when no active session claims are observed. Finish
     its CCC sessions, then run `ccc stop` from that workspace using the same
     profile and runtime to apply the change sooner.

   If replacement is blocked and the running container's mount contract cannot
   be safely reused, startup prints concise restart guidance with the workspace,
   profile and runtime. It exits without joining, stopping or replacing that
   container. Detailed lock claims and the expected error stack are shown only
   with `DEBUG`; unexpected failures retain their normal diagnostics.

   Recreating a container discards changes made inside it outside mounted paths.
3. On every ccc start, before the session command runs, ccc runs one bounded probe
   as the container's default exec user. When the socket is missing, or that user
   can already read and write it, nothing else happens. Only when the user lacks
   access does ccc make one bounded root exec that adds the user to the group
   owning the socket:
   - When a group already has the socket's gid, ccc uses it. On Docker Desktop
     that group is `root` (gid 0).
   - Otherwise ccc creates `ccc-host-socket` with that gid, or corrects the gid of
     an existing `ccc-host-socket` group.

   The socket's mode and owner are never changed. Joining gid 0 grants no new
   privilege, because the image already gives `ccc` passwordless `sudo`.
4. The new group applies to new sessions and execs. A process that was already
   running when the group was added, such as an open agent session, keeps its old
   groups until it is restarted.
5. Returned probe/root-exec failure or timeout statuses, or malformed probe
   output, trigger at most one warning per module lifetime and allow the session
   to continue. Exceptions thrown by dispatch, result getters, output coercion,
   or the warning itself propagate unchanged; they are not converted to warnings.
6. When container creation fails, the runtime's own error stays live on the
   terminal (image pull progress is not buffered), and ccc adds a hint: if that
   error mentions docker-init, tini or catatonit, install the runtime's init binary.

## Testcontainers in ccc

Testcontainers' Ryuk reaper works in ccc containers. It was probed from inside two
ccc containers on Docker Desktop: `localhost`, `172.17.0.1` and
`host.docker.internal` all reached a Ryuk container and got its label
acknowledgement. Do not set `TESTCONTAINERS_RYUK_DISABLED=true`.

Without Ryuk, a test run that is killed leaves its containers behind. Images that
declare a `VOLUME` (for example `postgres` and `minio`) also leave one anonymous
volume per container. `.withReuse(true)` has no effect unless
`testcontainers.reuse.enable=true` is set in `~/.testcontainers.properties`.

To remove volumes that are already orphaned, run `docker volume prune`. On Docker
23 and later it removes only unused **anonymous** volumes, so ccc's named volumes
(`ccc-mise-cache`, `ccc-codex-packages`, and any `ccc-*-lab-state`) are kept unless `-a` is
passed. Confirm
first: `docker volume prune --help` lists `-a, --all` only on versions with that
behavior. On older versions, remove the anonymous volumes by name instead.

## Known ceiling

- Known ceiling: a running pre-init container that has active sessions is joined
  as-is and keeps `tail` as PID 1 until it stops; the deferral is announced once.
  Run `ccc stop` to recreate it.
- Known ceiling: setup is bound through the container-exec application and
  composition. Core/facade/type and Docker behavioral tests cover calls and
  outcomes; they do not certify every host through end-to-end execution.

- Known ceiling: `ccc remote` starts its container with `sleep infinity` and no
  init, so remote containers can still accumulate zombies.

## Verification cues

- `docker inspect <container> --format '{{.HostConfig.Init}}'` prints `true`.
- `docker exec <container> ps -o pid,args -p 1` shows `docker-init` or
  `catatonit`.
- `docker exec <container> ps -eo stat | grep -c ^Z` stays at 0 after orphaned
  processes exit.
- `docker exec <container> docker ps` works without `sudo`.

## Interactive terminal capabilities

TTY launches preserve TERM, COLORTERM, TERM_PROGRAM, TERM_PROGRAM_VERSION and
COLORFGBG through literal runtime environment arguments. Explicit Linux container
overrides are case-sensitive and remain authoritative. Recognized modern Windows
terminals may supply xterm-256color/truecolor defaults when no explicit TERM
exists. Non-TTY commands receive no extra terminal flags. Capability identifiers
are bounded to 1024 UTF-16 code units and exclude C0/DEL controls; this keeps the
small argument set bounded without forwarding unrelated host environment values.
