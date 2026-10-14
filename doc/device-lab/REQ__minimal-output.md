# Minimal Device Lab output

## Reduced public workflow

Use focused management groups: snapshot (list/create/restore/delete), record_video
(start/stop/status), permission (grant/revoke), clipboard (read without text,
write with text, including empty text), and ui (device-selected UI hierarchy).
Resolve the exact operation before policy, routing and output handling. Flow
permissions remain per operation; grouping must not broaden them. Removed tool
names are rejected, not retained as hidden aliases.

Status incorporates automation and QEMU readiness information; devices with view:backends includes
broker diagnostics. Status must not start Appium or provision a guest. Running
QEMU readiness refreshes use the existing owner operation lock; stopped devices
are reported without probing their guests.

QEMU start prepares its disk automatically without replacing an existing disk.
For new configurations, a supplied guest-agent provisioning command enables
automatic preparation unless explicitly disabled. Stored opt-outs remain valid.
Dry runs perform no preparation. Failed provisioning reports failure while
retaining the running VM identity; repeated start retries preparation without
spawning a second VM, and skips preparation that already succeeded.
Metadata-only session opening is not a public prerequisite for commands or files.

## Action-first public interface

Public names have no device/mobile/display prefix. Common actions are
`screenshot`, `click` (including count:2), `type`, `key`, `scroll`, `move` and
`cursor_position`. Mobile taps use `click`; the current X11 display is another
explicit deviceId. The owner-scoped device determines the implementation.
There is no remembered selection. Unsupported gestures, buttons and cursor
operations fail explicitly rather than silently becoming different actions.
`move` requires x and y; `cursor_position` only queries position.

Successful simple actions return literal MCP text `ok`. Queries return useful
data or native images, without repeating success or request arguments. Errors
set MCP isError and retain the cause and necessary recovery evidence. Warnings,
partial failures, lifecycle deviceIds and artifact paths must survive. Private VM
generation metadata is available only through opt-in diagnostic evidence. Detailed diagnostic output remains available with detail:true.
Flows use the same public names, preserve step identity and native images, and
classify failed waits before simplifying output. Old prefixed calls are rejected.
These rules supersede historical prefixed names in the sections below.

## Canonical inputs

Existing-device tools accept `deviceId`, never `backend`. The server resolves
the owned device’s provider internally. `run_flow` inherits only `deviceId`
within that request. Public VM operations do not accept `incarnationId`. Explicit backend input is rejected
before dispatch. Creation and discovery may still select a kind because no
existing device is targeted.
Unknown or ambiguous device IDs fail without choosing a provider or sending an
action. No ID-prefix guessing or remembered target is permitted.

The advertised tool catalog is the callable public contract. Removed mobile
aliases and unadvertised broker/image operations are rejected before provider
execution. Internal broker APIs remain available to the host implementation.
Backward compatibility is not a requirement for this interface.

Each individual device operation explicitly supplies its deviceId. The server
does not remember a selected device across requests or MCP clients: subagents may
share a connection. Only a single run_flow request may share its target
between steps; one request cannot change another request's target.

Pass inputs directly, without an `options` wrapper. Single-backend tools select
their backend internally and reject an explicit `backend`. Flow steps use
`tool`, `arguments`, and optional `label`; `name` is not an alternative to `tool`.
Rejected legacy inputs must not silently execute with defaults. Canonical calls
retain ownership checks, destructive confirmation, and useful failure results.

## Inputs with one supported backend

Discovery omits `backend` for container-QEMU image list/import, target list,
readiness probe, session open, workspace sync, artifact export, guest-agent
status/provision, and macOS base-image create/clone. The server supplies their
sole backend after checking raw inputs. Explicit backend arguments are rejected
before provider execution, including values matching the internal default. These QEMU operations do not select host Hyper-V guests.
Defaults are applied after flow target inheritance and do not broaden ownership.

Creation advertises typed inputs instead of a generic `options` wrapper. Wrappers are rejected before execution. Descriptions identify
platform-specific alternatives without implying unsupported defaults or key syntax.
The real-provider test runner validates the same effective arguments as the server.

Default MCP responses contain actionable state and operation results, without
repeated transport traces, owner storage paths, protocol capability versions or
duplicate status representations. Discovery returns one authoritative backend
list. Normal discovery retains public capabilities and action-specific supportedActions,
along with backend/provider, availability and missing prerequisites. Public deviceIds, unknown/unavailable state, lease
problems, operation outcomes and returned artifact paths remain usable.

Projection happens only at the public MCP response boundary. Internal provider
and broker contracts are unchanged. Opaque command output, UI trees, arbitrary
RPC values, images and resources are not filtered by metadata-like key names.
Flows retain per-step outcomes and apply the same presentation to known tool
results. Failures retain their cause, actionable recovery information and
partial cleanup/containment outcomes. Unknown shapes are preserved.

MCP callers can request `detail: true` for the diagnostic response; capability
names still describe callable public tools rather than private provider operations.
Default JSON text is serialized without indentation. Broker CLI status shows
verified readiness and endpoint; `--verbose` retains the original diagnostic
fields for attestation and troubleshooting. Unverified status never claims ready.
Status retains its existing broker repair behavior and does not start devices.

Diagnostic provider/routing tests explicitly request detailed output. Public
presentation tests must request compact output or use a client with no diagnostic
defaults, so compatibility coverage cannot hide a broken default response.

## Final VM and flow presentation

Known QEMU responses omit generated storage wiring and repeated successful
history from default output. Current readiness, target/session identity, usable
artifact paths and unique failure or recovery evidence remain. Sandbox and
macOS inventory retain prerequisites, provider identities and singleton/lock
evidence while removing executable wiring and exact discovery duplicates.
Detailed output retains provider diagnostics; public identities and condition outcomes are normalized in both modes. Presentation never changes state.

Flows return requested images and other native content after their leading JSON
summary, in step order, with a zero-based `contentIndex` and `contentCount` range into the outer content
array for each step containing native blocks. Index 0 is the JSON summary. Each returned
occurrence remains present, including repeated images and observations preceding
a failure. Failed flows set MCP `isError:true`. The 64 KiB failed-flow limit
applies to JSON text, not native attachments; bounding preserves their references.
General JSON replies mark explicit outer `ok:false` as an MCP error, without
inferring failure from arbitrary error fields or nested command/RPC data.

## Known ceiling

Known ceiling: Unknown envelopes remain unfiltered — add explicit projections when new provider response shapes require compaction.

Known ceiling: Semantic readiness-history deduplication recognizes process-only diagnostics; guest/custom diagnostics remain intact — upgrade when their producer-specific diagnostic preservation rules are explicitly covered.

Verification covers default and detailed responses, nested failures, fenced
action identifiers, opaque data preservation, flow results, unavailable brokers,
CLI exit status, and fresh source and bundled MCP server responses.

## Broker call flow

A tool operation reuses successful broker preparation and owner resolution
within that operation. Reuse is private, scoped to the same route, launch
options and owner context, and discarded on failure. Each public invocation,
including concurrent calls, and each flow step gets a fresh scope.

Each authenticated RPC still checks the live broker generation and reads its
owner credential. Device inventory and backend mismatch checks remain current;
no device result, credential or authorization is cached across operations.
Caller-supplied arguments cannot provide trusted preparation evidence.

## Every tool and provider

The compact contract applies to every advertised tool, including current-display
and VM management tools. Known successful helper envelopes must not repeat UI
hierarchies, input text, parsed response JSON or empty command diagnostics.
Opaque command output, image data, semantic UI content, public deviceIds,
artifact paths and unique failure/containment evidence remain available.
`detail: true` preserves diagnostics while retaining canonical public identities and condition outcomes.

Advertised inputs describe the requested action and target. Internal mobile
connection settings are retained for internal routing and test machinery rather
than advertised as user choices. Destructive confirmation and input constraints remain.

Provider discovery and status formatting may share a fresh snapshot within one
list operation. They must not share snapshots across requests or replace fresh
mutation-time identity, generation and lease checks. State mutation may skip a
byte-identical write only after locking, reading and validating the result.

The exhaustive audit records every advertised tool and implementation function,
its disposition and supporting evidence. Static review and fixture tests are
reported separately from actual platform/device execution.

## Mobile waits and compact recording status

Android text/app waits use one monotonic polling budget after prerequisite and
ownership checks. Every UI dump, read, fallback and process query uses only the
remaining budget (at most the normal command timeout), and sleep cannot exceed
it. Zero/negative numeric timeouts normalize to one millisecond; nonfinite or
nonnumeric values use the default; upper bounds follow the advertised schema.
Standalone UI dumps and lifecycle boot waits keep their own existing behavior.

A failed final observation is an MCP error, not proof that the text/app is absent.
A later successful observation clears an earlier error. An empty, clean pidof
exit 1 means the app is absent. Successful no-match responses remain ordinary
results. Physical Android clipboard reads return the same exact `text` contract
as emulator clipboard reads, including empty strings and newlines.

Compact recording results keep active/finalizing state, recording/session IDs,
artifact paths, start/stop times and unique warnings or recovery data. Generated
host process identity and ownership metadata remain internal or in detail mode.
Only exact helper echoes are deduplicated. Session status keeps availability,
missing prerequisites and session identity while hiding executable discovery and
process metadata. No provider state is changed by presentation.

## Catalog, input and flow efficiency

Direct and detailed local backend catalogs share executable discovery only within
that catalog call. Emulator/simulator and physical-device prerequisites keep their
existing meanings. Default broker discovery remains lazy; later calls observe
new executable availability.

Missing or invalid mobile key/text-wait arguments fail before target or broker
preparation, including inside flows. Zero key codes and whitespace text remain
valid. Advertised schemas require an action value, and nested options are rejected before validation.

Default flow output is projected before failed-response size limits, so a large
successful observation cannot erase a later failure's identity and cause.
Detailed flow output remains original while it fits. Oversized failed flows keep
step identities and outcomes, explicitly mark omitted successful content and
bounded failure diagnostics, and retain actionable failure/recovery evidence.
The final serialized UTF-8 failed-flow JSON text stays within 64 KiB. This does not
change standalone opaque command/UI results or other diagnostic size limits.

## Intuitive tool selection and verification flows

The devices tool distinguishes owned-device listing, backend prerequisites, and
single-backend inventory through its view selector; recorded status does not promise universal live
readiness. Creation, startup and physical attachment remain separate actions.
Boot-wait guidance must match boolean polarity and platform-dependent defaults.
Flow arguments remain fixed, with no previous-result interpolation. Requested
screenshots are native image blocks in the same response, so inspection requires
no follow-up screenshot call. The canonical catalog contract below defines the
consolidated tool identities.

Within a flow, an explicit unmet condition from wait_for_text
(found:false) or wait_for_app (found:false or running:false) is a failed
step with error wait-condition-not-met. Default stopOnError prevents subsequent
actions; false continues while the flow remains unsuccessful. Original wait
observations and provider errors remain available. Successful waits, standalone
observational responses and unrelated tools' false fields retain their semantics.

## iOS Simulator app observation failures

An app wait distinguishes clean absence from inability to query the simulator.
A positive pgrep/launchctl observation retains success. Each polling sweep starts
with fresh observation trust: a clean observation in the final sweep permits
running:false, even if another fallback is unavailable. A clean pgrep exit 1
requires empty stdout/stderr; exit 0 without an error or signal is a valid query.
If the final sweep has no trustworthy observation, the public tool returns a
bounded MCP error retaining the command failure cause, not running:false. Earlier
clean observations cannot hide later total query failure. Existing fallback order,
ownership checks, and clean-absence response shape remain unchanged.

## Device lookup diagnostics

When no provider handles a registered tool requiring deviceId, the terminal
diagnostic distinguishes omitted IDs (missing-device-id), absent owner-local
devices (device-not-found), and unsupported operations on known targets
(device-tool-unsupported). Missing/absent targets give a short devices hint.
Truly unknown tool names retain Unknown tool. Invalid IDs, provider/broker
errors, backend mismatch, policy refusals and successful results keep precedence.
Diagnostic lookup must not query providers or other owners, mutate state, mask
corrupt state as absence, or add lookup work to successful calls. Local QEMU
targets and the current display remain recognizable; ambiguous IDs are not guessed.

## Image and inventory metadata

Successful Linux VM image list/import responses omit owner IDs and generated
image timestamps. Recognized container-qemu image records retain identity, format,
size, copied state, artifact/source paths and unique diagnostic fields. Unknown or
failed image records and failed envelopes remain intact, including in mixed lists.
Empty lists still omit envelope ownership. Inventory applies the same compact
provider-plan presentation as list/status, both directly and within backend
entries. Failed plans, unavailable reasons and unique warnings remain; creation
and dry-run plans stay reviewable. Detailed responses remain original.

## Canonical tools and shared flow target

Advertise unprefixed install_app/launch_app/screenshot, set_orientation,
and one run_flow. All old device_, mobile_ and display_ prefixed names are
not callable. Discovery and
public dispatch use the same catalog; internal provider contracts may use private operation names. Both public
verbosity modes expose canonical tool names and supportedActions.
The canonical catalog must shrink from its 57,211-byte starting size.

The canonical flow schema enumerates supported visible step tools, including
mobile app/system actions and canonical app install/launch. Only canonical
step names are accepted. Device lifecycle, arbitrary
commands, broker management and nested flows remain disallowed. Every destructive
step requires its own confirmation. Empty flows and malformed step arguments fail.
Flow steps require tool; name is rejected even when tool is also present.

Optional flow-level deviceId applies only to device-targeted
steps. Step arguments are flat. An explicit step deviceId selects that exact
device; otherwise eligible steps inherit the flow deviceId. Public flows do not
accept or inherit incarnationId. Explicit invalid values still fail
validation. Never inherit confirmation, credentials, force or routing controls.
Target-neutral devices steps receive no defaults. Each step retains
fresh broker/ownership checks, stopping semantics and compact/detail output.

## Mobile observation deadlines

Mobile text/app waits use one observation allowance after device discovery and
initial Appium session setup. The default is 10 seconds; finite numeric timeouts
are clamped to 1–600000 ms and poll intervals to 1–60000 ms (default 500). Each
subprocess, HTTP phase and controllable observation lock consumes the remaining
allowance; pauses cannot extend it or start another observation afterward.
Timeouts and incomplete output cannot supply a match or evidence of absence.
A completed clean non-match may establish absence, including a valid simulator
observation in the latest fallback sweep; without such evidence, failed
observation remains an error. Lost ownership always fails. Physical attachment
and broker identity checks remain.

This bounds observation work, not installation/session bootstrap or exact wall
clock completion: bounded process inspection, filesystem work, termination and
scheduling can add overhead. Matching client and host broker builds are required
for the underlying host request cancellation guarantee; older hosts retain their
previous internal request limits. Ordinary non-wait Appium requests retain their
existing timeout defaults.

## AX contract consistency

The public tool identities remain stable during this repair; the subsequent desktop-control extension adds only focus_window (59 tools total). Advertised input
requirements must match runtime preflight, including destructive confirmation,
exclusive selectors, integer inputs and provider/action-specific requirements.
The runtime destructive policy remains authoritative.

Default discovery retains backend/provider identity and concise supported public
operations, including supported actions for grouped tools. Suggested next calls
must name advertised tools and use their canonical arguments. Physical start/stop
must not imply that MCP powers a physical handset on or off.

Public waits expose a consistent condition outcome and canonical appId where
applicable. An unmet condition is distinct from an observation/transport failure;
flows stop at unmet conditions by default. Diagnostic verbosity must not change
failure classification. Oversized errors retain bounded cause, recovery and
cleanup/containment evidence while remaining valid JSON within the response cap.
Opaque exec output, UI content, images and caller data are never interpreted as
provider metadata. Response tests validate usable identities, outcomes and typed
observations rather than accepting an arbitrary object.

### Follow-up contract requirements

A completed app observation that finds no app returns `matched:false` without an MCP error. Native command failures still return errors; compact waits use only `matched` for the condition while detail may retain provider booleans and native exit diagnostics. Android console ports accept only even integers from 5554 through 5682. Attach requires the backend-specific physical identifier or Wi-Fi endpoint before dispatch. Explicit recording duration must be an integer from 1 to 1800 seconds; Android further limits it to 180 seconds. iOS Simulator ignores the duration and requires stop; macOS and Windows Sandbox use the supplied limit. Battery level is an integer percentage from 0 to 100 and status is an integer from 1 to 5. Android available inventory exposes installed image and device-profile IDs suitable for creation, with explicit unavailable, incomplete or truncated discovery diagnostics; discovery never downloads SDK content.

## Stable public execution contracts

Public boolean options reject nonboolean values before dispatch, including destructive flags; the string `"false"` never enables an action. Public numeric timing arguments obey their advertised bounds, and `exec` passes its accepted timeout through without silently reducing it.

`create_macos_vm` with an image provisions a managed Tart VM before returning a device. A source device selects the existing owned clone path. Missing source information and unsupported image providers fail before saving a device definition. Failed provisioning retains the existing rollback and ownership guarantees.

Compact simple-action failures retain nonempty command stdout diagnostics, including failures signalled by the MCP error flag. Battery-setting command warnings remain visible instead of becoming plain `ok`. Diagnostics remain bounded; arbitrary exec and UI payloads are not interpreted as operation diagnostics. Tool names and per-operation device selection remain unchanged.

Managed Windows, Linux and macOS VM creation issues a fresh opaque deviceId; names are display labels and duplicate names create independent instances. VM creation rejects caller-selected deviceId (and QEMU labId) before provider effects. Later operations select the exact owned deviceId alone; deleted IDs cannot select a new definition. VM CLI create positional text is the display name and its output supplies the generated ID. Broker clients require the shared version5 compatibility contract.

Owned device records returned by public tools use `deviceId`, including detailed output. Normal VM metadata omits incarnationId; opt-in diagnostics may retain private native generation evidence. Native candidate serial/udid and snapshot/image IDs keep their domain names. Guest exec and UI payloads remain opaque.

## Argument and diagnostic integrity
Public tool schemas reject unknown argument names. Runtime validation rejects unknown names before provider dispatch, including flow steps; internal routing controls remain a separate unadvertised compatibility seam for broker transports and test isolation. A misspelled clipboard write must never become a read.
Compact errors retain the target and actionable recovery context. Owned-device summaries retain negative readiness and containment evidence rather than implying a running VM is usable. Normal action successes remain concise; meaningful provider diagnostics must not disappear during the final presentation pass.

Mock provider tests must isolate both HOME and USERPROFILE plus derived application-data directories and inherited provider state overrides. They must never reuse the developer's real Device Lab state. OS-specific executable and privileged-link fixtures must report an explicit unsupported-host condition; portable parsing and state-fencing tests remain active.

Windows fixture verification must not depend on POSIX shebang execution or `/` as the host path separator. Mock executables used for platform-independent lifecycle and ownership tests run as real Node subprocesses with bounded execution. Discovery fixtures cover both `where` and `command -v`; they resolve only fixture-owned tools. Tests requiring POSIX process-group signals are host-specific. Directory-link boundaries use Windows junctions; permission-dependent file-symlink cases are separate tests so ordinary validation and hard-link checks still run without elevation. Asynchronous filesystem tests await all operations before deleting their temporary directories and inject mutation at deterministic operation boundaries.

Physical-device identifiers stay unchanged on the wire; test fixture filenames derived from them must encode characters such as the colon in Wi-Fi ADB addresses. Fake provider subprocesses may model a specific transport platform explicitly (for example, the Sandbox `wsb` CLI rather than native `.wsb` association), but such coverage must never be reported as native host runtime verification.

Fixture MCP lifetimes are isolated per test where cases mutate shared leases or provider programs; a failed child must not invalidate later cases. Asynchronous provider spawn errors must return through normal failure/rollback handling without terminating the MCP server. Parameterized permission-dependent tests use a runner API that supplies an actual test context. Windows native process identity and termination checks remain enabled; synthetic POSIX signals and permission bits are identified explicitly. Large generated PowerShell test probes run from temporary script files to avoid Windows command-line limits. A passing Linux fixture suite is not native Windows validation.

Windows provider workers and their termination path must use the same handle-derived process start token. CIM timestamps are lower precision and may only be compared at their precision when discovering descendants; root identity checks retain the complete token and termination uses acquired process handles. Fake VM lifecycle tests must supply deterministic host capacity instead of depending on available developer RAM. Platform simulation must not change the OS used to verify real fixture child processes. Observation-budget tests isolate the budget clock rather than freezing native lock deadlines. Timers and MCP sessions belong to individual tests and are cleaned up even on assertion failure. Generated PowerShell probes must include complete helper definitions and avoid inheriting another PowerShell edition's module search path.


Fixture regressions must traverse the provider command wrapper, including injected Windows launch arguments. Native termination races and persistence failures are injected at the exact termination or atomic-write boundary, preserving identity and successor-state assertions. Startup-exit tests deliver the exit during the readiness window deterministically rather than relying on host subprocess startup speed. Generated diagnostic regexes are compiled in portable tests; PowerShell block probes initialize the variables required by those blocks. A no-provider-discovery assertion distinguishes the current process identity lookup used for state locks from actual provider discovery.

Routing-only tests use explicit provider wire fixtures for POSIX and Windows responses rather than invoking a host shell during setup. Lock-bypass tests retain the held-lock assertion while allowing native fixture startup within an ordinary observation budget; deadline-boundary behavior belongs to dedicated timing tests.

Recording fixtures keep local destinations inside their per-test home using native path joining, including retry and cleanup scenarios. Guest Android `/sdcard` paths remain POSIX paths; local file assertions must not assume the host uses `/tmp`.

Natural recorder exit fixtures wait for an explicit test release after public start succeeds, keeping real native identity capture enabled. Tests observe the inactive state with a bounded poll instead of assuming fixed startup/exit timing; fixture children have a bounded fallback lifetime and release on assertion failure.

Smoke CLI timeout parsing is asserted at the provider spawn boundary with deterministic responses. Success/readiness cases use a normal bounded budget for real fixture children; dedicated timeout cases continue to exercise actual timeout enforcement and classification.
