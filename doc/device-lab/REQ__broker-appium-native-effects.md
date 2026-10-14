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

## Command observations

The existing launchServer, synchronous installRuntime and synchronous resetInstrumentation ports return required semantic ok, optional pid and processIdentity, and an opaque receipt. The native composition derives command success from exit status zero with no truthy error; missing/null/nonzero status and a truthy error are unsuccessful. Empty error retains the existing success behavior. The application cannot read command status/error or receipt contents. Launch failure does not publish a server; install failure does not publish a marker or launch. Successful installation still validates the runtime directory, node_modules and entry before publishing its marker.

Each fixed instrumentation cleanup step may return an unsuccessful observation without stopping the remaining five-step recovery or its existing single session-creation retry. A thrown effect retains existing propagation. Outward launch, failed-install and recovery executions retain the original native evidence; semantic ok is not inserted into native wire receipts.

## Native framing and interpretation

The native adapter owns `/status`, `/session`, session-ID encoding, HTTP methods, and the W3C `capabilities.alwaysMatch` envelope.
It omits bodies on GET and uses the existing verified, bounded transport, including URL, redirect, stream, and response-body guards.
It derives readiness by rejecting only an upstream literal `false`; absent or null readiness retains compatibility.
A nested string `value.sessionId` takes precedence over a top-level string `sessionId`, including when the nested string is empty.
Instrumentation-initialization errors are interpreted natively for failed creations and exposed as the creation flag. Successful creation returns a false flag without serializing its response body before session publication or compensation.
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
Type checks prove the finite signatures and reject native evidence access. Authenticated broker HTTP/private-client fixtures pin creation, request, and deletion evidence. Existing public MCP mobile fixtures pin the detailed ui request receipt and source output across the actual stdio wire; session-management tools are not advertised.
Fresh compilation and Linux/native Windows QA are coordinated on the combined current source; archived checks are not current qualification.
