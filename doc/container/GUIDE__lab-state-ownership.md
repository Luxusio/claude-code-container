# Retained Lab volume ownership

`createLabStateOwnershipPreparation` owns the retained Lab volume policy under
`src/application/container/`. Its required ports and structural facts live in
the corresponding `ports/container/` and `domain/container/` modules.
`src/lab-state-ownership.ts` retains the public synchronous
`prepareLabStateOwnership(volume, imageId, identity, previousImage?): void`
and composes the existing native bindings.

The application validates the volume name and immutable images, observes exact
volume existence and running users, establishes a previous numeric principal
when provenance exists, and chooses verification or selective migration. It
reads native observations in their original error/status/output order and owns
the existing refusal messages. An absent volume returns without creating it.
Listing retains exact newline/name matching; it does not normalize whitespace
or CRLF. Running or unavailable user observations refuse before helpers.

The six ports are immutable-image normalization, volume-name listing, volume-user
observation, helper-context capture, previous-account observation and ownership
application. The helper context is opaque to the application: trusted native
composition captures `runtimeExtraRunArgs()` once after user observation and
before initial principal reads. Both helper commands reuse that capture. Native
argv, process specs and arbitrary commands are absent from the core contract.
Final ownership application returns raw error/status facts rather than a success
classification or an ignored return. All primitives and preparation are
synchronous; an asynchronous implementation does not satisfy their contracts.

The original identity object remains shared with native rendering. Its UID/GID
getters retain their original initial and repeated template read positions.
No eager snapshot or extra account validation changes trusted JavaScript caller
behavior. Domain/application use no real environment, home, filesystem,
subprocess, lock or default runtime. The factory checks required port callability
without invoking native effects.

`docker.ts:prepareRetainedState` retains exact previous container ID/Image/Mounts
before replacement, calls Codex ownership migration before this operation, and
sets its once flag only after both succeed. `startProjectContainer` holds the
existing host-wide `~/.ccc/codex-state.lock` with a 600-second wait and
`reclaimStale:false` through preparation and container start. The extraction
adds no lock, stale-owner reclaim, broader cleanup or public authority input.

The previous account probe uses the immutable old image, runs as `ccc`, and has
no state mount. The current image helper runs as root with one exact named-volume
mount at `/state`, network disabled, and the captured runtime extras. Every
native command keeps UTF-8 output and its existing 300-second timeout. With
provenance, the unchanged shell selects entries matching the old UID/GID using
`find -P -xdev`, `chown -h` and `chgrp -h`, then sets the root principal. Without
provenance, it only checks the root numeric owner using the original `stat`
comparison. It never guesses the previous owner from that root.

Failed observation, invalid account or failed helper throws the existing error.
No new retry, volume deletion, transaction journal or rollback is introduced.
The native helper can fail after earlier ownership writes, so retained data may
be partially migrated. A timeout is not proof of helper termination. Reverting
this code does not undo native ownership writes.

The architecture core/facade/type suites cover admission, exact observations,
short-circuit and throwing getters, reference/context relay, repeated principal
reads, native command/options/shell bytes, original errors and synchronous
contracts. The existing `lab-state-ownership.test.ts` calls the actual facade.
Docker tests mock this helper and establish caller sequencing only. Strict
declaration and compiled facade/application consumers must also run against
actual extracted npm and materialized Unix installation payloads outside the
checkout, with native execution fenced and private fixture roots.

This is the single `OP-lab-state-ownership-migration` source boundary. Portable
tests and packaging do not certify actual Docker/Podman volume mounts, image
accounts, runtime extras, rootless UID/SELinux, native Windows/macOS, concurrent
writers outside the startup lock, partial-write crashes or native timeout
termination. Those native/reliability gates and the remaining M10/M13/M14
architecture work remain separate.
