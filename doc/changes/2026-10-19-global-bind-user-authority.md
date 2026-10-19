# Retained bind users and clipboard lifecycle

CCC retains captured native runtime authorities before creating or restarting
protected binds. Home migration and automatic clipboard replacement use the same
global guard as those creations, inspect retained running and stopped containers,
and preserve shared state when coverage or inventory is uncertain. Interrupted
creation retains a pending-effect veto; later success cannot erase that
uncertainty. Clipboard publication and retirement use explicit ownership, an
authenticated writer-settlement acknowledgement and a consistent port/token
selection. A UI or CLI connection does not authorize retiring another session's
bridge. Normal retirement marks the existing port inode terminal using its
original publication receipt; later admitted startup can publish an active token
without treating an unreachable peer as proof of death. The requirements are recorded in
[captured runtime](../runtime/REQ__captured-container-runtime.md) and
[home layout](../common/REQ__ccc-home-layout.md).

## Known ceiling

- Existing homes and mixed older/nonparticipating writers cannot acquire complete
  coverage merely because history is absent. Their uncertain automatic migration
  or bridge replacement remains deferred. External manual engine operations are
  not made participants by the retained-authority file.
- A forced crash, interrupted publication, legacy peer or failed terminal write may leave an uncertain
  port record. It is preserved rather than automatically promoted to retired.
  A failed flush does not establish persistence; a complete terminal record can
  still truthfully reflect the already sealed writer on a later guarded read.
- A captured invocation retains native selectors and references, not credential
  contents, DNS or the identity of a physical daemon later placed at the same
  endpoint. Stored proxy selectors and endpoint userinfo remain private.
- Receiving-host remote participation uses a conservative Node-free claim and a
  permanent incomplete-coverage marker. Missing exact `link`, compatible `stat`
  or repeatable descriptor reads refuses before effects; remote shell does not
  promise power-loss `fsync` durability. Expand this subset only after native
  interoperability is demonstrated on another supported receiving platform.
- Owned Linux processes and inert native executables establish concurrency and
  file-preservation behavior. They do not certify deployed macOS startup, native
  Windows ACL/directory durability or real device-provider acceptance.
