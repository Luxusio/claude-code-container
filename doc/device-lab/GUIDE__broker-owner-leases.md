# Broker owner registration and physical leases

`createBrokerOwnerApplication` owns registration eligibility, equivalent locked reuse, canonical mount/profile resolution, and secret reuse or repair. Public registration/secret exports and the bounded HTTP resolve route use this same application. Canonical identity derivation remains shared with the existing owner identity module.

Required native capabilities retain guarded descriptor reads, directory checks and modes, scoped mutation locks, bounded randomness, and atomic file publication. Invalid auth material is quarantined before replacement. Successful publication permits identity- and ownership-checked cleanup of a non-directory quarantine entry; failed publication retains that evidence and propagates the primary publication error. A cleanup refusal does not prove the entry disappeared. This is not automatic restoration of invalid credentials.

`createBrokerPhysicalLeasesApplication` owns claim conflict and expiry decisions, locked rereads, heartbeat refresh, exact owner/device/claim admission, release, and incremental prune. It reuses the existing lease date and bounded scan/list applications. Native file guards and per-hardware mutation locks remain at the boundary. Shared cleanup callers use the same release and existing lease-restoration policy; restoration refuses an occupied destination.

Heartbeat reports `pruned: false` if expired-record removal fails. Prune returns only successful removals, preserving partial progress. Release cancels the owned heartbeat only after removal succeeds. Locking and guarded reads retain their existing guarantees; the extraction adds no claim that failed removal means absence, and no stronger generation or atomic compare-and-delete guarantee.

Ordinary factory/type tests and real authenticated HTTP/native-filesystem tests cover these boundaries. Static source readiness is not runtime acceptance, and portable test evidence does not certify native Windows filesystems or installed physical devices. Independent review and the shared genuine QA lane establish acceptance.
