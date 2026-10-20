# Restore the terminal after an interactive disconnect

CCC restores inherited interactive terminal state when a local runtime client
or remote SSH client ends, including abrupt failures and handled interruption.
This prevents enabled mouse reporting from spilling coordinates into the host
shell. Noninteractive output, command statuses and resource ownership remain
unchanged. See the [session exit contract](../common/REQ__session-exit-cleanup.md#interactive-terminal-restoration).

Known ceiling: cleanup cannot run after SIGKILL of CCC itself, and native
restoration failures remain best effort. This change does not diagnose or
prevent a container-engine crash.
