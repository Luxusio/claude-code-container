# Windows Sandbox helper connection reuse

A missing helper-ready marker does not prove that the desktop connection is
missing. CCC must reuse a previously accepted connection launch while retrying
bootstrap and helper requests for the same running Sandbox.

When recovery actually launches `wsb connect`, CCC records the successful launch
before attempting bootstrap. Publication uses the existing owner-device operation
lock and complete-record conditional update. A conflicting or replaced record
is preserved and reported; recovery must not stop a runtime to undo that conflict.
A failed connection launch remains retryable and is never stored as successful.

Connection launch acknowledgment does not establish login, helper readiness or
command success. ExistingLogin failures and helper deadlines remain observable.
A successful broker runtime start must discard the previous connection launch
record, even when the same Sandbox ID is reused; starting a runtime alone must
not be recorded as an interactive connection. Stop also discards this evidence.

Normal teardown retains the existing ownership-qualified `wsb stop --id` path.
CCC must not terminate every Sandbox process or close unrelated windows. Native
acceptance checks the owned test's connection windows after repeated requests
and after stop; portable fixtures alone do not prove reconnect dialogs are gone.
