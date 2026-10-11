# QEMU guest execution

`guestExec(args, options)` in the native Linux VM facade delegates to the existing `createQemuGuestAccessApplication`. Guest execution is a synchronous bounded SSH operation, alongside the application’s existing session and readiness policies. It does not open an interactive shell, provision a guest or add a readiness check, retry or session requirement.

Admission reads the owned lab first, requires its running state, then validates the command. A command must be a nonempty string, at most 4096 characters, without the rejected control characters. Missing SSH configuration and a missing native SSH executable produce their distinct availability failures before execution. This order retains the native lab-read and running-state errors rather than replacing them with command validation errors.

The application builds SSH arguments from the accepted lifecycle domain helpers and passes the command unchanged as the final argument. It bounds the requested timeout with the existing command-timeout policy, using 30000 ms as the default. The required `executeSsh` leaf performs one native runner invocation with the selected lab directory, environment and timeout. Native state reads, owner/path/key guards, executable discovery and the actual runner remain outside the application; command planning grants no new host authority.

The result reports success only when the native outcome has `ok: true`, retaining the owner, lab identifier and selected timeout. Existing `publicGuestExecResult` policy projects and redacts the provider result and private paths. Native exceptions keep their existing propagation; there is no added retry, cleanup or success fallback.

Raw `guestExec` callers and the public MCP `device_exec` path reach the same application. MCP retains its native ownership admission and result presentation, and gives `helperTimeoutMs` precedence over `timeoutMs`. The accepted file-listing path builds its bounded listing command, calls `guestExec` with a 30000 ms budget and interprets that result through its existing listing peer. Transfer, provisioning, readiness and session workflows remain in their existing seams.
