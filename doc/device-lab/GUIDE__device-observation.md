# Direct device observation

`createDeviceObservation` owns backend descriptions, owned-list projections and
focused inventory composition through eight concrete backend configurations.
Native adapters bind executable lookup, parsed SDK results, owner records,
validated lab entries, helper paths and fenced publication. Windows VM retains
its existing backend/list routing and has no direct inventory handler.

Shared target projection owns kind, runtime/readiness, session presentation and
owner lease selection/expiry. The public status helpers remain native bindings
to owner identity, clock and physical lease reads. Display lists reuse one lease
snapshot per backend; those snapshots never authorize mutation. Nonphysical,
missing-identity and explicit lease-state paths avoid lease reads.

Empty and identity-only iOS/macOS owned lists avoid SDK/provider discovery.
iOS observations retain the native updatedAt/status/UDID/simulatorName publication
guard, so a successor replaces neither its state nor identity. macOS recovery
admission still runs before dispatch; inventory checks executable availability,
not provider VM listings. Linux ordinary lists omit invalid labs while strict
lists throw, with individual native lab validation retained.

Mobile inventory ports provide normalized host AVD/device facts. The shared
`adapters/mobile-inventory.mjs` owns ADB/AVD output decoding; the iOS physical
binding reuses its existing native inventory helper. Failed inventory is distinct
from a successful empty list. `HostDevices<T>` belongs to the ports module, with
an application type-only re-export for existing callers.

Simulator owned lists use one finite devices observation per operation;
inventory uses one captured catalog observation for reconciliation and outward
catalog presentation. Only the backend resolves native SDK targets and decodes
state/name. The application consumes matched/status/name facts and retains the
publication decision. The next operation refreshes discovery and inventory;
there is no cross-operation SDK cache. Catalog evidence stays opaque inward and
is projected to the existing hostSimulators shape at the backend.

Current public MCP and owner-isolation fixtures verify these contracts alongside
required-port checks. Host broker discovery and existing request/aggregation/admin
applications remain separate peers. Portable fixtures and package startup smoke
do not certify real SDK, physical-device or VM hosts.
