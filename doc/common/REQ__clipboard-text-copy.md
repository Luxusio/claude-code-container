# Host clipboard text copy

status: accepted

## Intent

Copying text inside a CCC container must update the host clipboard when the
application uses a clipboard command or the container X11 CLIPBOARD selection.
This includes direct X11 clients such as arboard-based TUIs. CCC does not change
the terminal's Ctrl+C key binding or intercept process interrupt signals.

## Observable behavior

- `POST /clipboard/text` requires the existing bearer token before reading the
  body or invoking host commands. Accept UTF-8 `text/plain` up to 1 MiB; reject
  unsupported content types, invalid UTF-8, NUL, incomplete and oversized uploads
  without changing the clipboard. Return success only after the native write
  succeeds. Upload and native command timeouts bound resource use.
- Preserve Korean, emoji, quotes, CRLF, spaces and trailing newlines. Empty text
  clears the clipboard. Clipboard data must travel as data through stdin, never
  as executable shell or PowerShell source. Native failures produce an error.
- Windows persistent clipboard reads transmit PowerShell source as ASCII base64
  of UTF-16LE and emit BOM-free UTF-8, independent of the host console codepage.
  The response decoder preserves characters split across pipe chunks.
- Support existing Windows/WSL, macOS, X11 and Wayland hosts. Successful writes
  invalidate old cached text/images, including reads already in flight.
- `wl-copy`, `xclip` clipboard input and `xsel` clipboard input send text to the
  host. Failed copying must exit nonzero. Unsupported binary/selection options
  must not silently discard input and claim success. Existing paste remains.
- Direct X11 text copies propagate to the host. Startup first adopts the host
  clipboard, preventing stale X11 content from overwriting it. Thereafter newly
  observed local text is sent before host polling. Successful uploads advance
  both baselines to prevent echoes; failed uploads retain local content for retry.
  Host text/image changes still propagate into X11.
- Clipboard contents use private temporary files and are not logged. Client
  HTTP and X11 operations are bounded. Every X11 synchronization cycle reads one
  validated mounted `port:token` record and refreshes the endpoint port and bearer
  token together, preserving the configured host (including bracketed IPv6).
  Missing, unreadable, malformed, multiline or retired records retain the paired
  session environment fallback; they never mix an old port with a new token.
  Endpoint refresh preserves initialization, pending local-copy retries and
  no-echo baselines. A bridge with no configured host endpoint cannot infer one
  from the port/token alone; failed provisioning is not repaired by this refresh.
- Installation includes the bridge script; existing-container synchronization
  refreshes it. A changed running bridge is replaced only after verifying process
  ownership, preserving singleton behavior and the existing X server.
- Container installation normalizes and replaces scripts under root-owned
  `/usr/local/bin` using fixed privileged installation commands, and provisions
  the bridge state directory for `ccc`. The bridge and X server run as `ccc`,
  not as root.

## Verification

Exercise the real HTTP handler, actual shell clients, isolated Xvfb selections,
failure paths, byte fidelity, cache invalidation and packaged/synced scripts.
Check fixed native command contracts on every platform and clearly distinguish
those checks from native OS clipboard testing.

## Non-goals

Reverse image/file transfer, Hyper-V guest clipboard integration, and terminal
keybinding changes are not part of this text-copy bridge.

## Known ceiling

Paired endpoint refresh requires an authenticated host connection to have been provisioned. It does not repair absent endpoint metadata or establish the cause of every host clipboard failure. Actual host acceptance remains separate from isolated X11/HTTP verification.
