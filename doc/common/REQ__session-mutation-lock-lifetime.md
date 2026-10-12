# Session mutation lock lifetime

An exclusively created mutation claim must be released through its own token on every successful or failed acquisition and callback exit. A complete record followed by a write, close or admission failure must not strand a guard owned by the still-running CCC process. Cleanup must preserve a replacement token and the original failure; when both operation and cleanup fail, both errors must remain observable.

A synchronous call must refuse a guard already held by this process instead of blocking the event loop that its asynchronous owner needs to release it. Refusal grants no reentrancy and does not run the contender. Independent asynchronous callers and other host processes still serialize through the native guard. A successful operation cannot report success if qualified release fails and its exact token remains.

Elapsed time alone does not authorize reclamation of a live or unobservable owner. Boot identity can prove staleness only on the same host. Proven owner exit or a recorded process-identity mismatch may authorize token-qualified recovery. Malformed-record recovery remains conservative and directory identity fences remain required.

SIGINT, SIGTERM and SIGHUP received during session ownership acquisition request cancellation. Before existing-container acknowledgement, cancellation rolls back only the captured new reservation under the already-held lifecycle guard. After acknowledgement, cancellation retains the captured receipt and exact container ID, releases the acquisition guard and uses normal qualified cleanup. Capturing an existing container never enables shutdown by itself; failed joins and foreign claims retain their existing veto.

Signal cleanup waits for acquisition to settle before exiting. Repeated signals share one completion path. Cleanup failure is reported as failure without an unhandled promise rejection or broader deletion authority.

Verification uses the existing shared-mutation-lock, session-acquisition, session-cleanup-facade and emitted session-ownership integration suites. Native Windows evidence must be identified separately. These repairs do not establish the liveness or exact cause of an independently observed host guard whose process identity is unavailable.
