# Local desktop integration for container tools

User request, 2026-10-30: container sessions should feel like local sessions.
The reported cases are image/text paste with Command+V, Codex drag-selection
copy back to the host, and ordinary link clicks opening the host browser.
Requested terminals are VS Code, IntelliJ, Ghostty, iTerm2 and Zed on macOS.

The user subsequently confirmed that the clients' default image shortcut
Control+V should remain unchanged. Do not add terminal-specific Command+V
bindings, extensions or host preference changes. Record Command+V differences
as terminal diagnostics; they are not a requirement to normalize native
terminal shortcuts. Current-image attachment and text/image freshness still
require verification through the supported default shortcut.

Verify both clipboard directions with generated content and actual terminal
actions. A raw key event, successful HTTP response or native-only application
does not establish container TUI acceptance. Preserve text/image transitions;
never convert an ordinary text paste into a previous clipboard image.

Distinguish terminal selection, TUI-managed selection, OSC 52, X11 PRIMARY and
CLIPBOARD. Repair the demonstrated missing path without changing interrupt
keys or all user terminal preferences. Test drag-copy using visible generated
text and inspect the actual host clipboard result.

Browser opening must reach the host's browser instead of a nonexistent
container browser. Treat URLs as data with explicit protocol restrictions and
authenticated cross-boundary requests; never interpolate them into shell
commands. A command-click terminal link and a TUI-handled ordinary click are
different paths and need separate evidence. Preserve the user's browser choice.

CCC Claude profiles should merge `permissions.defaultMode: bypassPermissions`
without erasing other settings and stop adding the equivalent automatic CLI
flag. This user setting alone does not universally override project settings.
The separately requested `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1`
must be supplied in the process launch environment: Claude ignores it inside
the settings `env` block. Keep explicit launch overrides and managed policy
behavior visible; do not claim that every permission constraint is removed.
