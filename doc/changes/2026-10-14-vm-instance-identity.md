# VM instance identity

Managed Windows, Linux and macOS VM creation now returns a fresh opaque device ID; the display name is a label, and all subsequent public operations use that single ID. Caller-selected VM IDs and force replacement are rejected before effects. Existing definitions keep their IDs, while provider ownership, journal, process and generation checks remain internal. Clients and brokers use protocol5. CLI and real-test consumers retain the returned ID for selection and cleanup. Independent code/security reviews and Linux/nativeWindows controlled-provider QA passed, including the fresh53-case Hyper-V launcher suite on both platforms; unchanged suites remain separately qualified. This does not certify actual provider hardware, GUI behavior or the complete architecture migration.

## Known ceiling

Unrecorded historical test fixtures remain outside automatic cleanup. Recover them only when their exact fixture IDs are established; display names and generic backend prefixes do not establish fixture ownership.

If a VM creation transport fails after submission, its outcome may be unknown. Do not automatically retry name-only creation because a second request creates a second instance. Inspect owner inventory to recover the generated ID; an explicitly new create request is a new birth.
