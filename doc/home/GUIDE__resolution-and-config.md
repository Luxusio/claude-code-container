# Home path and configuration policy

The application owns complete path/default-account/marker and config read/update
operations. Native home-layout keeps live os/path/fs/process bindings, historical
named wrappers and the original shared default-entry array. Initialize factories
after native constants/array without reading home or filesystem at construction.

Preserve every repeated home/join lookup and lazy existence check. Named profiles
bypass default provenance. An unmarked home with any legacy credential entry uses
legacy default paths even for absent requested entries; marked homes resolve each
entry independently. Keep lstat-with-catch-all existence separate from config
existsSync. Clipboard port inode discovery remains independent of active locks.
Default marker creation retains mkdir0700 then empty marker0600, no rewrite.

Config read resolves path/existence outside its catch; only read/parse/schema
failures yield an empty object. Update creates home first, rejects malformed or
unreadable config without overwriting it, mutates the same parsed object once,
then observes PID and writes pretty JSON without newline to the original PID temp
name before rename. Callback results remain ignored, including async callbacks
accepted by the legacy void contract. Serialization yielding undefined reaches
native write rejection. Failures retain original propagation and partial temp
state, with no added cleanup/retries/locks.

Test fresh/nested lookup order, getters/receivers, default provenance, native
link/error distinctions, mutation/serialization/publication failures and emitted
types. Both shipped payloads exercise actual factories and native public facade.
The real-daemon clipboard fixture compiles both new application imports while
retaining all assertions, timeouts and fences. Use private synthetic home/config.

## Known ceiling

This parity cutover changes no migration schema or native authority. Concurrent
PID temp collisions, filesystem/ACL races, real native platforms and mounted or
remote/rootless credential paths remain existing separate acceptance obligations.
Remaining M11 operations and M12-M14 are not completed by this family.
