# iOS simulator and macOS VM broker lifecycle

Authenticated broker applications keep iOS simulator and macOS VM variants separate from direct providers. Each owns create/start/stop/delete policy and returns semantic outcomes. Domains construct records; required ports expose individual native effects. Executable paths, argument arrays and input framing belong to broker composition. Prepared capabilities remain opaque to the applications.

The outward broker retains validation, authenticated owner selection, operation locks, public preview, dry-run and idempotent responses. It renders HTTP responses and redacts semantic records. Publication compares the observed current record under the native mutation lock; an uncommitted successor is never adopted.

iOS commands verify owner-prefixed names and exact UDIDs through bounded simctl inventory. Create parses the successful UDID before claiming state. Claim failure compensates newly provisioned resources while preserving resources referenced by existing records. Broker boot semantics remain distinct from direct bootstatus waiting.

iOS stop keeps its successful shutdown receipt separate from native completion.
The existing command allowance covers shutdown, identity-checked inventory
readback, polling pauses and final publication admission. A unique, timely
`Shutdown` observation permits the existing full-record comparison; unresolved
or invalid observations fail without claiming stopped state. Polling never
reissues shutdown. See [shutdown confirmation](REQ__ios-broker-shutdown.md).

macOS retains Tart/VZ/UTM selection and command planning. Explicit Tart boot waits use bounded IP observation. Failed boot observation reports the launched VM truthfully. Stop/delete settle auxiliary runtimes before provider commands and retain expected records for conditional publication; partial effects and cleanup failures stay visible.

Current authenticated HTTP broker, application/fake-port, native regression and required-port tests verify these routes. Genuine build and ordinary npm/Unix smoke verify distribution/startup. No frozen original implementation or per-operation shipping consumer is required. Source integration and native host/guest acceptance are separate.
