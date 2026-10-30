# REQ - Clipboard Image Bridge

status: accepted

## Intent
Codex image paste through CCC must survive host clipboard image type variation and present an attachable image to the containerized Codex command.

## Observable Behavior
- User-explicit recurrence, 2026-10-30: both Codex and Claude fail during
  screenshot/image-copy shortcut paste on macOS and Windows; text paste can
  repeatedly produce an earlier image. Live consumers must follow current
  image → text → empty → identical-image transitions. At the text/empty stage,
  an older image target or payload must not remain attached. Startup `--image`
  attachment alone does not establish this live-paste behavior.
- Derived from that recurrence: the selected X11 bridge needs a bounded,
  positive first-sync observation before paste readiness is claimed. Recover
  unchanged host content after positively observed selection-owner loss;
  a failed text read, nontext owner or unavailable X11 observation alone does
  not authorize overwriting a current local selection.
- Current clipboard implementation delivery must follow
  [concurrent generation ownership](../clipboard/REQ__clipboard-generation-coexistence.md).
  Rebuilding source while silently selecting an older daemon is not current
  behavior acceptance. Preserve the existing native marker and failure rules.
- Derived native input continuity: a seekable Windows raw image stream must be
  read from its beginning, including when returned at EOF. Empty macOS PNG
  data is not an image and must not suppress an available TIFF/other supported
  conversion fallback. Native read failures remain errors, and all advertised
  image targets still require captured nonempty bytes.
- Concurrent clipboard consumers (Claude target checks, Codex image reads and the X11 bridge) must receive their own complete native responses. Persistent native helper operations must not cross-consume marker and snapshot frames. A delimiter occurring inside clipboard text is data, not a response terminator.
- For Windows/WSL and macOS persistent helpers, an unavailable, malformed, interrupted or timed-out native read is an HTTP error, not an empty clipboard. Only a successfully read empty snapshot returns 204. Failed reads must not create marker-backed negative cache entries; a subsequent request must recover even when the host clipboard marker has not changed. Image targets must agree with captured nonempty image bytes.
- Native snapshots must be coherent with the clipboard change marker. Changes during a read require bounded retry instead of caching mixed or stale content. Empty/no-image cache reuse must be short and bounded so delayed image rendering can recover even under an unchanged marker. Image → text → empty → the same image must remain observable to all consumers.
- The X11 bridge preserves its last successfully synchronized selection on host read errors and adopts the next successfully read host state. Windows clipboard reader processes use STA mode and discard incomplete responses on native failure.
- When CCC launches Codex with clipboard image attachment enabled, the host clipboard server exposes a stable `/clipboard/image/png` endpoint and the Codex wrapper writes the returned bytes under `.omx/clipboard-images/clipboard-<timestamp>.png` before injecting `--image`. The host bridge must treat common image clipboard targets such as `image/png`, `image/jpeg`, `image/jpg`, `image/gif`, `image/webp`, `image/bmp`, macOS PNG, macOS TIFF, Windows `Clipboard.GetImage()`, Windows Explorer image file-copy/file-drop payloads, and other `NSImage`-loadable pasteboard data as image candidates instead of failing only because the exact PNG clipboard type is unavailable.
- When a Windows image file-copy/file-drop payload can be converted to PNG, the clipboard snapshot must expose image targets and suppress the plain local path text so containerized Codex or Claude paste consumes the image rather than pasting `C:\...` path text.
- When Windows clipboard data advertises image content through raw `PNG`/`image/png` formats or `Clipboard.GetImage()`, CCC must expose `image/png` only after non-empty bytes have been captured. It must not advertise `image/png` targets with an empty `/clipboard/image/png` response.
- When a Windows image file-copy/file-drop payload looks like an image but cannot be converted to PNG by built-in host decoders, CCC must try to read the file bytes directly and expose those bytes as image clipboard data. If direct file-byte reading also fails, CCC copies the source file into the host clipboard shared-files directory mounted inside the container and returns that copied in-container path as the text fallback. The fallback path must be usable from inside the CCC container, not the original Windows `C:\...` source path.
- The same file-pointer fallback applies to macOS Finder file URL clipboard payloads, Linux desktop file URI clipboard payloads (`text/uri-list` and GNOME copied-files style data), and single `text/plain` values that are local image paths such as `C:\Users\...\clip.png`, `/Users/.../clip.webp`, or `file:///.../clip.avif`: direct clipboard image bytes remain first priority, readable local image file bytes are second priority, and shared copied file paths under `/run/ccc/clipboard-files/...` are last resort.
- WebP and AVIF are best-effort image file candidates without extra decoder dependencies. If the host can convert them to PNG, CCC exposes converted image bytes; if not but the file can be read, CCC exposes the source file bytes as image data; if file-byte reading fails, CCC falls back to the shared copied file path.
- If a Windows/WSL image endpoint request sees a cached snapshot with no image, CCC should perform one fresh clipboard read before returning empty so rapid copy/paste does not keep serving a recent negative cache.
- Clipboard cache invalidation must be request-triggered, not a background polling loop. Windows/WSL should use `GetClipboardSequenceNumber()` as a cheap clipboard marker when available, macOS should use the native helper's `NSPasteboard changeCount` marker when available, and marker-backed cache entries should be reused only while the marker is unchanged. Platforms without an available marker should use a short TTL fallback, and Linux image endpoint reads should force a fresh snapshot to avoid serving stale copied images.
- Linux containers whose kernel version mentions WSL must use the WSL/Windows clipboard path only when `powershell.exe` is actually runnable. If WSL interop is unavailable, CCC should fall back to normal Linux clipboard handling instead of failing server startup.

## Acceptance Signals
- When CCC launches Codex with clipboard image attachment enabled, the host clipboard server exposes a stable `/clipboard/image/png` endpoint and the Codex wrapper writes the returned bytes under `.omx/clipboard-images/clipboard-<timestamp>.png` before injecting `--image`. The host bridge must treat common image clipboard targets such as `image/png`, `image/jpeg`, `image/jpg`, `image/gif`, `image/webp`, `image/bmp`, macOS PNG, macOS TIFF, Windows `Clipboard.GetImage()`, Windows Explorer image file-copy/file-drop payloads, and other `NSImage`-loadable pasteboard data as image candidates instead of failing only because the exact PNG clipboard type is unavailable.
- Copied local image files from Windows Explorer paste as image data in containerized Codex/Claude flows, not as local path text, when the file can be read and converted to PNG by the host bridge.
- Windows clipboard snapshots never advertise `image/png` unless `/clipboard/image/png` can return non-empty bytes for that same snapshot.
- Copied local image files that cannot be converted to PNG still paste as image bytes when the file can be read; only unreadable files fall back to a container-accessible copied file path under the CCC clipboard shared-files mount.
- Copied local image files from macOS Finder or Linux desktops, plus plain text clipboard values containing a single local image path, also paste as readable file bytes before falling back to a container-accessible copied file path under the CCC clipboard shared-files mount.
- WebP and AVIF image files are accepted as image-file candidates on a best-effort basis without adding decoder dependencies.
- Windows/WSL image endpoint reads retry once against a fresh clipboard snapshot when the cached image is empty.
- Clipboard image paste latency is bounded by request-time marker checks where supported, without background polling. Windows/WSL and macOS marker changes invalidate cache immediately; no-marker platforms use the short TTL/fresh image-read fallback.
- Docker/Linux sessions running on a WSL host but without runnable `powershell.exe` start the clipboard server using Linux clipboard handling rather than crashing during platform detection.

## Verification Cues
- Focused tests should prove alternate image MIME ordering, Darwin helper JSON/changeCount parsing, Windows sequence-marker command generation, cache reuse decisions, Windows image-file snapshot parsing, Linux file URI parsing, readable file-byte priority, copied container-path fallback parsing, clipboard shared-files mount arguments, and preservation of normal non-image text behavior. Build verification should compile the TypeScript clipboard server and package the updated Darwin helper source.

## Non-Goals
- This requirement does not add image editing, arbitrary binary clipboard support, or a new Codex CLI image API.
- Linux command adapters retain their existing absence behavior: a failed target query (including an unavailable display) can produce an empty response. The persistent-helper error distinction above does not claim to distinguish every Linux command failure from a genuinely unowned selection.

## Source
- Windows marker semantics: [GetClipboardSequenceNumber](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardsequencenumber). A zero marker does not establish cache validity; delayed rendering can postpone sequence changes.
- Windows native threading: [Clipboard STA requirement](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.clipboard.clear). Clipboard operations must run in STA mode.
- created: 2026-06-07
- source: task: TASK__fix-codex-image-paste-clipboard-type-stall

## macOS native fallback continuity

A valid native helper snapshot without image bytes must still try the existing
local converter, pasteboard file reference, and image-path text fallbacks. Keep
the snapshot change marker so a concurrent clipboard change discards fallback
bytes. Native image snapshots stay on the fast path; failed fallback leaves
ordinary text intact. No remote image URL fetching is introduced.

HTTP-to-Codex tests cover these paths with simulated pasteboard responses and
real temporary PNG files. Historical Slack reproduction and native macOS
pasteboard integration still require a Mac; these tests do not establish the
format used by a particular Slack version.
