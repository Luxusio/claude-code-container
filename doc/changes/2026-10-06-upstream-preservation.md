# Preserve fork fixes on upstream 1.1.90

This integration adopts upstream's package layout, container lifecycle, profiles,
native tool installation and Codex daemon/resume handling while retaining the
fork's host UID/GID alignment, scoped caches, verified retained-state migration,
config access, clipboard continuity, SSH preparation and remembered mise refusal.
Running containers remain intact; updates wait for a stopped container. Failed
tool probes return their original error without deleting working installations.
Running-container checks recognize Docker's separate tmpfs metadata and allow
the normal five-second exec probe timeout, avoiding unnecessary refusal on a
healthy but slower Docker host. Failed readiness checks preserve running work.
Cold identity image generation has a separate 20-minute build budget and retains
recent build diagnostics on failure. This covers filesystem copying and image
export when the requested UID/GID differs from the base; validated images are
cached for subsequent starts.
Harness engine changes remain separate from CCC's bootstrap and path integration.

## Known ceiling

SSH refresh preserves container-learned host keys only while private provenance
matches the authoritative host file. Missing provenance or any authority change
resets learned trust, including hashed or wildcard entries; those additional
hosts require verification again. An authoritative regular `known_hosts` file
larger than 16 MiB fails preparation and invalidates the incomplete snapshot.
Oversized previous provenance or learned `known_hosts` discards learned trust
and continues; other copied SSH files do not have this size limit.

The [preservation contract](../runtime/REQ__upstream-fork-preservation.md) maps the
fork changes to their current implementations. The
[ownership contract](../runtime/REQ__host-project-ownership.md) specifies supported
identity mappings and the conditions that refuse migration rather than alter
unproven state.
