# Unknown remote session peers veto stop

Derived technical requirement: this specializes the existing
[SessionStore and RemoteSession contracts](../common/SPEC__ccc-architecture-contracts.md#required-ports).
Unknown claimants remain active; cleanup acts only on its exact lease and target.

Under the existing remote lifecycle guard, stopping a session first verifies
its own token and pinned container ID/name, then retires only that token. If
another session is live or cannot be determined safely, preserve its record,
return the existing `ccc-remote-sessions-active` diagnostic/status 42 and do not
stop the container. Application busy handling continues to preserve sync.

Only an owned regular nonsymlink peer with a successfully read decimal expiry
that compares as strictly expired may be retired. Empty, malformed, incomplete,
unreadable or numerically out-of-range expiry records remain protected, as do
symbolic links, nonregular files and records owned by another user. A missing
unmatched shell glob is not a peer. Expiry-only legacy records remain supported;
a live record does not need a recognizable container ID to veto stop.

Verify by executing the actual generated shell in a private temporary home
with an instrumented Docker executable. Valid expired peers allow exact-ID
stop; live and indeterminate peers survive, the own token retires, and no stop
occurs. FIFO and symbolic-link cases must not block or follow their targets.

## Known ceiling

The lifecycle guard serializes participating CCC writers. This requirement
does not add atomic protection against arbitrary same-user filesystem changes,
change sync naming/authority, or certify live SSH and remote-host behavior.
