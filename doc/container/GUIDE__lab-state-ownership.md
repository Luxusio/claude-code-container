# Retained Lab volume ownership

`createLabStateOwnershipPreparation` owns the retained Lab volume policy under
`src/application/container/`. Its required ports and structural facts live in
the corresponding `ports/container/` and `domain/container/` modules.
`src/lab-state-ownership.ts` retains the public synchronous
`prepareLabStateOwnership(volume, imageId, identity, previousImage?): void`
and composes the existing native bindings.

The application validates the volume name and immutable images, admits only an
idle existing volume, establishes a previous numeric principal when provenance
exists, and chooses verification or selective migration. An absent volume returns
without creating it. Its six required synchronous ports provide image
normalization, volume presence (`present`/`absent`/`unavailable`), volume use
(`idle`/`in-use`/`unavailable`), opaque helper-scope capture, decoded previous
principal and ownership application (`applied`/`unconfirmed`). The application
owns refusal policy and messages; it does not parse subprocess receipts.

`src/adapters/lab-state-ownership.ts` owns the existing native commands and
codecs. Volume names retain exact newline matching without whitespace or CRLF
normalization. Failed/nonzero listings and user observations are unavailable;
prior accounts require successful receipts and two decimal IDs strictly between
zero and 0xffffffff. Runtime extras are captured once after the idle observation
and reused by both helper commands. Native argv, scripts and helper scope remain
outside the core. Unconfirmed application can have partial effects and is never
replayed automatically.

Domain/application use no real environment, home, filesystem, subprocess, lock
or default runtime. The factory checks required port callability without
invoking native effects. The public facade composes the lazy native adapter and
keeps its synchronous four-argument entrypoint.

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

The architecture core/type suites exercise finite admission, ordering, refusal
and synchronous contracts. Existing native/facade fixtures cover actual command
options, numeric decoding, shared helper scope and verify/migrate behavior.
Docker tests establish caller sequencing only. The current cutover still needs
combined independent review, strict compilation, emitted consumers and package
qualification; test authoring alone does not establish those results.

This is the single `OP-lab-state-ownership-migration` source boundary. Portable
tests and packaging do not certify actual Docker/Podman volume mounts, image
accounts, runtime extras, rootless UID/SELinux, native Windows/macOS, concurrent
writers outside the startup lock, partial-write crashes or native timeout
termination. Those native/reliability gates and the remaining M10/M13/M14
architecture work remain separate.
