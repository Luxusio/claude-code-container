# Device admin inventory

`OP-device-admin-inventory` enters through compiled `index.main`, then
`devicesCliAsync` and `devicesCli`. The legacy snapshot and status/list exports
remain available from `device-lab-admin`; cleanup exports retain their original
binding identity. Backends and doctor share the same inventory snapshot.

The application owns owner selection, ordered backend/device/executable reads,
both current-owner and all-project snapshots, grouping and status/list text.
The domain classifies macOS availability when any provider exists; other
backends require every prerequisite. It also owns device labels and exact list
flag admission. Status retains its existing extra-argument acceptance.

The facade supplies individual native observations: canonical owner/profile
resolution, guarded project enumeration, device-record reads and executable
lookup. Construction performs no observation. Native owner, root, link,
generation and storage guards remain in their existing authorities. Project
enumeration errors retain the public CLI classification; other raw errors and
publisher failures propagate at the same boundary.

Verification must exercise immutable original expectations, actual facade and
compiled caller bindings, ordered reads and failures, strict port declarations,
and both distribution forms. Static extraction does not certify native OS or
real-provider behavior, and this guide makes no runtime acceptance claim.
