# CLI direct-entry startup

CLI startup follows the canonical Node entry file instead of a test-runner
environment marker. Importing the CLI leaves execution to the caller; direct
execution still runs when `VITEST` is inherited as `0` or `1`.

The existing `main` and `runCli` exports, startup-error handling and claim cleanup
remain available. Canonical file URLs preserve installed and symlink launches;
missing or unresolvable entry paths do not start the CLI.

Contract: [CLI dispatch and workspace recovery](../common/REQ__cli-dispatch-and-workspace-recovery.md#cli-module-startup-boundary).
