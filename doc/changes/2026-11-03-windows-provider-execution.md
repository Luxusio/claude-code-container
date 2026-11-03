# Windows provider execution

Windows Sandbox reuses a successful helper recovery connection within the same
running runtime. Its broker start commands, registration and minimization waits
yield to other HTTP requests. Opt-in native Vitest tests run serially and the
test runner holds the existing real-provider admission through child completion.
The Sandbox wrapper uses the shared startup allowance and awaits its cleanup;
session fixture directory removal retries transient filesystem failures.

## Known ceiling

Existing synchronous auxiliary stop/delete cleanup is outside this repair.
Portable checks do not establish native Windows reconnect-dialog or teardown
success; that acceptance remains pending until the reviewed native run completes.
