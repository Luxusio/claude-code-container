# Unified display control

CCC exposes its container display through Device Lab, using
`deviceId: "x11-current-display"` with the same `screenshot`, `click`,
`move`, `type`, `key`, `scroll`, and `cursor_position` tools as
other devices. Use `click({count:2,...})` for double-click. Each action requires its deviceId and takes no backend selector.
No shared selected-device state is introduced.

The standalone X11 MCP package, build, published files, image copies, and bundle
synchronization are removed. Device Lab retains its X11 provider; CCC retains
Xvfb, xdotool, scrot, and the clipboard/display bridge. Removing the duplicate
server must preserve current-display discovery, screenshots and input behavior.
Incremental builds must remove obsolete generated `dist/x11-mcp` files, so
neither npm packages nor Unix installation payloads ship the deleted server.

Generated Claude and Codex configuration contains one managed Device Lab
display-control server. Legacy CCC-owned X11 entries, including Codex nested
environment tables, are removed. Unrelated custom MCP servers, their nested
tables and user settings are preserved; an arbitrary name containing `x11`
does not establish CCC ownership.

Verify with config preservation fixtures, a seeded obsolete output, extracted
distribution execution without node_modules, and actual Device Lab controls.
The provider uses display :99; changing DISPLAY alone does not isolate it.
Use an isolated display unless the user explicitly authorizes the current
screen, as authorized for this change. On the current screen, operate only an
owned temporary test window, restore the original focus and cursor even on
failure, and close only the test's own window and process. Windows Hyper-V
native acceptance is independent of this change.

## Window observation

`window_list({deviceId})` lists visible named desktop windows for the current
X11 display and owned Hyper-V Windows/Linux guests, as well as Sandbox/macOS.
It returns `windows` containing bounded titles, native string handles and
process IDs where available. A successful empty list means enumeration worked.
Unavailable displays, logged-out or switched Windows console sessions,
authentication failures, timeouts and malformed output are errors, not empty
lists. Results are limited to 128 windows with `truncated:true` when needed.
Serialized output is capped before transport: 24,000 bytes of X11 rows plus
the truncation marker, or 8,000 Windows JSON characters (leaving room for UTF-8
and the outer JSON envelope). Either budget may
return fewer than 128 windows. Titles are bounded to 4096 UTF-8 bytes on X11
and 512 characters on Windows.

Hyper-V Linux queries the existing `ccc-desktop` X11 session through verified
SSH. Windows runs a temporary interactive task for the credential user only
when that user owns the active console; it verifies the session again before
accepting output and cleans up its own task and files. Neither path starts a
desktop, changes focus, nor falls back to host windows. Container-QEMU and
mobile targets do not advertise this operation. Native Windows acceptance
requires a visible test window in that console; mocks verify transport and
failure contracts but cannot prove interactive-session behavior.

Windows enumeration requires a timeout of at least 30 seconds (the default),
reserving time for the bounded task and cleanup. Forced guest/transport shutdown
can interrupt cleanup; its 20-second task execution limit still bounds the
worker, but temporary files/task registration may need removal in that guest.

## Desktop control AX (implementation contract)

- `move` and left-button `drag` share screenshot-pixel coordinates on current X11,
  Windows Sandbox, macOS VM, and Hyper-V Windows/Linux desktops. Drag is bounded
  and releases the button on ordinary failure. Mobile drag retains its existing semantics.
- `focus_window({deviceId, handle})` activates an actual handle returned by
  `window_list` on X11, Sandbox, Hyper-V and eligible macOS windows. Unsupported
  platforms, stale handles and denied foreground activation fail explicitly.
  macOS support is limited to unique accessibility identifiers as described below.
- `screenshot` accepts optional `region:{x,y,width,height}` in the full returned
  screenshot's pixel coordinates. Crops are not resized or clamped. Responses
  identify the public deviceId and state region origin/full image dimensions;
  subsequent pointer coordinates still refer to the full image. Invalid regions
  or unsupported/oversized image encodings fail without returning a misleading image.
- Use `run_flow` to compose actions and an explicit final `screenshot`. No automatic
  screenshot is added to ordinary actions. Each step keeps target ownership checks.

### Limits and efficient flow example

The public catalog now contains 59 tools: `focus_window` is the only addition.
Dragging accepts integer endpoints and `durationMs` from 1 to 10000 (default 700).
A region supports noninterlaced PNG up to 32 MiB encoded bytes and 16 Mi pixels;
unsupported encodings return an error. Full-image capture remains unchanged.

```json
{"deviceId":"x11-current-display","steps":[
  {"tool":"focus_window","arguments":{"handle":"12345"}},
  {"tool":"drag","arguments":{"x1":100,"y1":100,"x2":250,"y2":150}},
  {"tool":"screenshot","arguments":{"region":{"x":80,"y":80,"width":300,"height":200}}}
]}
```

Replace the example handle with `window_list` output. Hyper-V flows select the
exact owned deviceId alone. The provider retains private generation and frame
fences; public screenshots do not introduce a second target selector. Focus depends on the desktop accepting
foreground activation; denial is an error, not a successful acknowledgment.
X11 focus requires a window manager implementing window activation.

Native Windows/macOS drag and focus have not been runtime-validated in the Linux
verification environment. Tests cover typed requests, generated native scripts,
provider routing and failure handling. Abrupt process/guest termination can bypass
ordinary finally cleanup; no guarantee of release or temporary-task cleanup is
made for forced termination.

The shared broker protocol advances to 4 for these desktop controls, so an older
daemon is replaced through the existing verified upgrade path before use.

macOS screenshots capture only the main display and normalize PNG dimensions to
its `CGDisplayBounds` coordinate dimensions. This makes returned screenshot
pixels match the existing Core Graphics pointer coordinates, including on scaled
displays. Capture verifies the normalized image dimensions and unchanged display
identity/geometry before returning; resize failure or a display change is an error.
The generated command and failure cases are exercised with a native-command fixture;
actual macOS scaled-display acceptance remains unverified in this Linux environment.

## Normal-flow contract

Public owned-device identities use `deviceId`, matching action arguments; stored provider records retain their internal `id`. Provider candidate identifiers (serial, udid, image IDs) are not device IDs.

`devices({view:"available"})` may omit backend to discover candidates grouped by backend. Discovery is read-only; missing prerequisites and partial failures remain visible. Supplying backend retains the focused inventory.

`start` defaults to waiting for the backend's configured control transport. It does not promise every app is loaded or every desktop permission is granted. Explicit asynchronous startup keeps its incomplete boot indication. Physical-device start retains attachment semantics: it does not power on the phone or promise an Appium session. macOS and Sandbox startup additionally require a read-only cursor observation through the configured control transport, within the original start deadline.

macOS window focus uses an opaque handle only when a window exposes a nonempty, unique accessibility identifier, fenced by the application's launch identity. Revalidate before focusing and verify the focused window afterwards. Do not select by title, list index or geometry. Windows without a usable identifier remain visible without a handle. App-defined identifiers can be reused within one application lifetime; native macOS verification remains required.
