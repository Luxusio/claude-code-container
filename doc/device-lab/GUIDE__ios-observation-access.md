# iOS observation and access

Simulator app waits first query `launchctl list` in the default bootstrap
namespace. A complete valid table proves a match only for the exact requested
UIKit application label with a positive safe integer PID; registered but stopped
entries do not count. A clean no-match pauses within the existing budget.
Failed or malformed lists retain the legacy process/service fallback probes.
Clean list results omit raw service inventory. See the
[app observation deadline contract](REQ__ios-app-observation-deadline.md).

Simulator and physical-device adapters compose one `createIosObservationAccess` application through required variant-specific ports. Its `request`, `ensureSession`, `stopOwnedAppium`, `deleteSession` and `waitForApp` methods own observation dispatch, Appium readiness/reuse, stale-session reconciliation, startup, publication and bounded wait decisions. Existing app-management and control/transfer wrappers reuse this session acquisition; lifecycle creation, attachment and pairing are not new capabilities of this factory.

Status and session-status requests observe current state without starting a session. Simulator access retains verified-target simctl execution, staged screenshots, guarded app-container listing, explicit simulator erase and app waiting. Physical devices retain Appium screenshots/UI and app/text waits; shell execution is refused, while list/reset requests fall through to existing adapter handling. Unsupported navigation actions retain their existing refusal. Simulator screenshots use native staging with cleanup in `finally`; file listing retains native container/path/read guards. Command, screenshot and wait budgets remain those of the existing native operations.

Session acquisition first checks the current device and physical lease, discovers prerequisites and qualifies the simulator target. A ready existing session is reused. Stale owned servers require verified cleanup; a ready server not owned by this provider can be reused without claiming its process. Clearing stale Appium metadata uses generation-qualified publication. If the resulting device record has vanished, acquisition returns unknown before any new startup or session creation, while retaining effects of earlier stale cleanup.

New startup establishes process identity, waits for readiness and creates the XCUITest session before conditional publication. Failed startup or publication compensates the session and owned runtime using existing cleanup semantics. Native exit callbacks clear only their matching generation; the post-publication alive check refuses a child that exited before becoming usable. Session deletion is best effort. Missing process ownership does not authorize killing a server, and unavailable or mismatched owned-process identity refuses termination rather than proving absence. These paths retain partial effects and add no atomicity or rollback guarantee.

Native adapters retain exact UDID/target and lease authority, device-operation locks, generation publication, process identity and termination, HTTP execution, guarded file reads/writes and screenshot disposal. Observation guards recheck current session/device authority during waits. The application interprets finite outcomes; it does not replace native guards with policy assertions or acquire a broad native context.

Ordinary provider and application/type tests cover supported outcomes, faults and required capabilities. Current independent reviews, strict compilation, runtime tests, genuine build/package checks and local delivery remain acceptance work. Source authoring does not certify Apple hosts, real devices, Xcode/Appium execution, formal close or nine global operation credits.
