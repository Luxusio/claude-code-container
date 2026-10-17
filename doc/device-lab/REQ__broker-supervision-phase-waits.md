# MCP broker supervision phase waits

Health readiness, owner resolution and process-exit confirmation each consume
their own existing allowance from one monotonic deadline. Wall-clock changes
must not extend or shorten those allowances. No aggregate startup timer is added.

Health retains its 250 ms request cap and 50 ms polling interval. Owner resolution
retains its current timeout normalization, 1000 ms request cap, 100 ms interval,
eight retained attempts and genuine HTTP-error/selected-attempt precedence.
Process-exit confirmation retains its 1500 ms default and callers' separate limits.

An observation starts only with positive time remaining. Success also requires
positive remaining time after observation; late positive facts remain evidence,
not readiness or confirmed exit. Recompute the remainder before sleeping, clip
the sleep to it, and perform no final observation after expiry. Keep existing
failure envelopes, runtime retention, identity checks and successor/CAS policy.

These rules bound dispatch and acceptance. Scheduler delays and noncooperating
I/O do not imply hard real-time completion or cancellation. Deterministic tests
must reach the actual native composition functions through existing ports;
portable fixtures do not establish native Windows or macOS acceptance.
