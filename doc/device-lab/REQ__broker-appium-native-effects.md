# Broker Appium native effects

The authenticated broker Appium workflows use finite semantic effects at the application boundary.
Public RPC names, inputs, CCC envelopes, ownership rules, stored metadata, and budgets remain unchanged.

## Required effects

The native port requires exactly five Appium protocol operations:

- `status(endpoint, timeoutMs)` returns `ok`, `ready`, and an opaque `receipt`.
- `inspectSession(endpoint, sessionId, timeoutMs)` returns `ok` and an opaque `receipt`.
- `createSession(endpoint, capabilities, timeoutMs)` returns `ok`, `sessionId`, `instrumentationInitializationFailed`, and an opaque `receipt`.
- `deleteSession(endpoint, sessionId, timeoutMs)` returns `ok` and an opaque `receipt`.
- `sessionCommand(endpoint, sessionId, request, timeoutMs)` returns `ok` and an opaque `receipt`; the request has the validated method, path, and body.

Every observation carries semantic facts only. The application cannot read HTTP status, response bodies, or receipt contents.
A missing session ID is represented by `null`; choosing an empty string still produces the existing missing-ID refusal.

## Native framing and interpretation

The native adapter owns `/status`, `/session`, session-ID encoding, HTTP methods, and the W3C `capabilities.alwaysMatch` envelope.
It omits bodies on GET and uses the existing verified, bounded transport, including URL, redirect, stream, and response-body guards.
It derives readiness by rejecting only an upstream literal `false`; absent or null readiness retains compatibility.
A nested string `value.sessionId` takes precedence over a top-level string `sessionId`, including when the nested string is empty.
Instrumentation-initialization errors are interpreted natively and exposed as the creation flag.
Listener, provenance, process-generation, and endpoint verification remain prerequisites for dispatch.

## Application decisions

The application owns validation, owner/device locking, lease heartbeat, deadlines, polling, retry, publication, and compensation.
Reuse requires successful status and session inspection; an existing session may be reused even when `ready` is false.
New-session readiness polling remains bounded, and retains the latest observation when readiness fails.
Instrumentation recovery retains the five fixed steps and permits the existing single creation retry.
A failed session deletion preserves metadata. Publication compares the captured generation and leaves a successor intact.
Compensation deletes the exact newly created session; process termination and session deletion remain distinct effects.
Request deadlines start after RPC queue admission and cover lock waiting, lease heartbeat, and Appium work.

## Outward evidence and qualification

Opaque native receipts preserve genuine upstream HTTP status and body for the broker converter.
The converter independently unwraps response, readiness, rollback, status, session, deletion, and request evidence into existing wire envelopes.
Termination evidence is decoded separately from HTTP evidence; the application never imports native receipt classes.
Type checks prove the finite signatures and reject native evidence access; application, native, and authenticated MCP fixtures qualify behavior.
Fresh compilation and Linux/native Windows QA are coordinated on the combined current source; archived checks are not current qualification.
