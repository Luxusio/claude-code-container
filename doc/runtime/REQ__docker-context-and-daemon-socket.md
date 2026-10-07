# Docker context and daemon-side socket compatibility

CCC uses the existing Docker adapter for Docker-compatible contexts, including
Colima's Docker runtime. Runtime selection remains explicit `--runtime docker`,
then `CCC_RUNTIME`, then existing executable discovery; a Colima executable is
not a third container engine and CCC does not manage its VM or configuration.

## Required behavior

- A nonempty `DOCKER_CONTEXT` takes precedence over `DOCKER_HOST`. Preserve the
  exact context name, including whitespace, when inspecting it. A failed or empty
  selected-context inspection remains unknown and never falls back to the
  shadowed host or grants Desktop capabilities.
- Without a context override, retain the configured host endpoint's existing
  trimming and short circuit. Otherwise inspect the current Docker context.
  Use argument arrays and protect a named context from option interpretation.
- Endpoint selection policy uses required synchronous ports; native environment
  reads and Docker inspection belong to composition. Preserve process caching,
  public runtime types and actual Docker Desktop evidence gates.
- `CCC_RUNTIME_SOCKET` is the bind source on the Docker daemon host or VM.
  Consume the same configured source in run arguments and mount verification;
  absent configuration retains `/var/run/docker.sock`. The source need not
  exist in the CLI client's filesystem. Never automatically substitute a macOS
  `~/.colima/<profile>/docker.sock` client endpoint for a daemon bind source.
  A noncanonical configured Docker daemon source bypasses caller-container path
  translation during nested CCC execution. Ordinary filesystem paths retain
  their translation; canonical-default and Podman rendering stay compatible.
- Malformed configured sources must not silently select another Docker socket
  or weaken existing mount/source/daemon identity checks. Preserve the existing
  refusal and owned-cleanup behavior when native execution or proofs fail.
  Docker Desktop's `.raw` socket equivalence applies only to the canonical
  `/var/run/docker.sock` expectation; a custom source does not inherit that alias.
  For a noncanonical Docker socket, the exact configured source and the live
  mounted daemon identity must both match. Safe deferral cannot substitute a
  different source; unknown identity is retryable and a foreign identity fails.
  This proof is required on initial creation as well as join/restart before
  setup or ready publication. Failed creation compensates only its captured
  newly created container; existing or foreign containers remain untouched.
- Podman socket existence fallback, rootless mapping and permission behavior
  remain unchanged.
- On macOS, the `/run/host-services/ssh-auth.sock` bridge is selected only for
  verified Docker Desktop. Other Darwin engines omit this unproven agent mount
  and its container environment variable. Existing SSH-key mounts are retained;
  this does not certify key readability or agent forwarding on Colima.

## Acceptance and evidence

Portable acceptance exercises conflicting context/host inputs, failed and empty
inspection, exact native arguments, cache lifetime, Docker socket override in
run and expected contract, foreign-daemon/source refusal, and Desktop-only agent
mounts. Both shipping payloads execute real compiled facades and declaration
consumers. No Colima profile name or local Unix path alone grants capabilities.

Full Colima acceptance requires a real Mac: build/start/exec, daemon-ID equality
through the mounted socket, default-user access without sudo, project writes
and host ownership, cache writes, join/restart, preserved mount safety, SSH and
host networking/proxy behavior. VM sharing outside configured paths is not
assumed. These native checks remain a dependent Goal task while unavailable.

Sources: [Docker CLI precedence](https://docs.docker.com/reference/cli/docker/),
[daemon-side bind mounts](https://docs.docker.com/engine/storage/bind-mounts/),
[Colima runtimes](https://colima.run/docs/runtimes/),
[Colima VM sharing](https://colima.run/docs/faq/).
