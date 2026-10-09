# Native cleanup loading

Public session cleanup remains synchronous. Its native adapter imports the cohesive `device-lab-cleanup` module instead of the larger administrative CLI module. The administrative facade imports shared helpers and reexports its existing owner identity, backend table and cleanup function; those exports retain the same objects and function identities.

The cleanup module keeps native owner reads, mutation and operation locks, current-record comparison, physical leases, Windows singleton generation checks, process identity, provider stop commands and bounded process waiting together. Device failure reporting, container shutdown failure and retryable ownership receipts retain their existing order and authority. This extraction adds no cleanup channel, asynchronous workflow, runtime selection rule or timeout.

```mermaid
flowchart LR
    Session[Public session and captured ownership] --> Composition[Existing cleanup composition]
    Composition --> Adapter[Existing native cleanup adapter]
    Adapter --> Native[Cohesive native cleanup]
    Admin[Administrative facade] --> Native
    Admin --> Broker[Administrative broker and setup graph]
    Native --> Authority[Original owner, state, lease and process helpers]
```

The guardian already sends its readiness acknowledgement before dynamically importing terminal cleanup composition. The public session import boundary and guardian terminal cleanup boundary are separate. This change does not make the whole CLI informational import graph lightweight.

Before extraction, the original source and native modules, function bodies, complete administrative declarations and emitted payload were frozen against the original Git revision. Instrumented launches of the same byte-identical original payload differed between the owned v9fs location and an owned `/tmp` copy. Those observations identify stages and location sensitivity; they do not establish the cause of historical test failures or promise a timeout improvement. Existing readiness and cleanup budgets remain unchanged.

Review and QA must verify original versus extracted native behavior, retained administrative exports and declarations, real public session/captured-ownership callers, and both actual shipping payloads. Controlled low-level probes prove wiring and authority preservation; they do not establish acceptance on real native providers, operating systems or container engines. No additional architecture operation is credited for moving these helpers.
