# Windows Sandbox helper connection reuse

## Provenance

User report, conversation of 2026-11-03: “Windows 샌드박스 환경에 대한 연결이
끊어졌습니다. 다시 연결할까요? 자꾸 이거 뜨는데 좀 고쳐줘.” The user clarified
that it recurs after CCC tests or Device Lab MCP actions and while idle afterward.
The requested outcome is to prevent CCC from causing these repeated dialogs.

The requirements below are derived repair obligations, rather than additional
user feature requests. They address the missing recovery-launch publication in
`providers/backends/windows-sandbox.mjs`, inherited connection evidence in
`src/device-lab/domain/lifecycle/windows-sandbox-lifecycle.ts`, and helper-calling
recording status in `providers/application/direct-recording.mjs`. Paths are
relative to `packages/device-lab/`. The existing lifecycle boundary is described
in [Windows Sandbox lifecycle](GUIDE__windows-sandbox-stop.md).

## Derived connection and failure requirements

A missing helper-ready marker does not prove that the desktop connection is
missing. CCC must reuse a previously accepted connection launch while retrying
bootstrap and helper requests for the same running Sandbox.

Missing-ready recovery requires running status and a valid Sandbox GUID;
otherwise it returns an error before launching connect or bootstrap. All helper
callers, including active-recording status, use the existing device operation
lock before capturing the device record and performing recovery.

When recovery actually launches `wsb connect`, CCC records the successful launch
before attempting bootstrap. Publication uses the existing owner-device operation
lock and complete-record conditional update. A conflicting or replaced record
is preserved and reported; recovery must not stop a runtime to undo that conflict.
A failed connection launch remains retryable and is never stored as successful.

Connection launch acknowledgment does not establish login, helper readiness or
command success. ExistingLogin failures and helper deadlines remain observable.
A successful broker runtime start must discard the previous connection launch
record, even when the same Sandbox ID is reused; starting a runtime alone must
not be recorded as an interactive connection. Successful broker stop also
discards this evidence. Direct stop may retain launch metadata while stopped;
direct start replaces it, and stopped records cannot trigger missing-ready
connection recovery.

Normal teardown retains the existing ownership-qualified `wsb stop --id` path.
CCC must not terminate every Sandbox process or close unrelated windows. Native
acceptance checks the owned test's connection windows after repeated requests
and after stop; portable fixtures alone do not prove reconnect dialogs are gone.
