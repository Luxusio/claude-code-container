# Real-provider run admission

Derived from the existing Level 3/durability mutual-exclusion contract and the
reported Windows startup refusal with unavailable owner metadata.

Only one real-provider test run may enter its operation for a host user.
Acquisition includes native process-identity initialization and ownership
checks; its default finite allowance must accommodate cold Windows inspection.
Explicit caller wait settings retain the shared lock's existing semantics.
The acquisition allowance does not limit the admitted test's duration.

An acquisition timeout means exclusivity could not be established. It does not
prove a competing process is running, including when no claim was created.
Report an acquisition diagnostic with the original cause and lock path.
Nested runner diagnostics must retain this code and the existing legacy code.
Once the protected operation has entered, propagate its errors unchanged,
including errors that themselves use a shared-lock timeout code.

Keep shared identity checks, live/unknown-owner protection, token-qualified
release and proven-dead-owner recovery. Missing diagnostic metadata does not
authorize lock deletion. Actual provider operations must not begin on refusal.

Verify cold sync/async admission beyond 100ms, explicit short/zero waits,
separate live owners, dead-owner recovery, unobservable ownership, callback
error identity and nested error reporting. Native Windows qualification must
exercise the actual process probe without launching destructive providers.
