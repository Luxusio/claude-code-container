# Clipboard paste and concurrent service generations

Screenshot paste in CCC Codex and Claude could use an older clipboard service
after a new session joined an existing container. The shims and X11 bridge
refreshed their new URL/token from the container's older immutable port-file
mount. New sessions now pin their authenticated current generation. Legacy
clients retain their refresh behavior and the container's original mount
verification remains in force.

Known policies publish a separate `clipboard.<12hex>.port` and startup slot.
Fresh creation requires complete runtime history, the held global guard and
exclusive publication. Older services, mounted files and helpers stay intact;
occupied namespaces and uncertain ownership retain their existing refusals.
This changes the shared clipboard service. Device-provider broker version
discovery is outside this change.

The native Mac helper now skips empty PNG data and converts available TIFF.
An empty advertised image may fall back to valid text; an unreadable image
without valid fallback remains an error. Windows raw seekable PNG streams rewind
before copying. Darwin helper source participates in the policy fingerprint and
selects a complete hash-qualified helper binary instead of an older global one.

Before launching a TUI, CCC checks the selected X11 bridge's first successful
sync. Positive X11 selection-owner loss can restore unchanged host content;
failed or unavailable observations cannot authorize overwriting another owner.
Host-side startup attachment uses loopback and settles incomplete or stalled
HTTP within five seconds. Clipboard readers use bounded transport requests.

Regression evidence is recorded in
[the current owner inventory](../../results/tests/clipboard-paste-2026-10-30/current-evidence.json).
Sixteen focused owners contain 1,070 passing tests and 18 platform skips. Older
RED reports are retained: stale endpoint selection, lost X11 ownership, native
Mac empty-PNG conversion and stalled/partial startup HTTP each had a failing
witness. TypeScript, affected-source lint and shell syntax checks also passed.
These are focused checks, not a new full-suite or GitHub Actions result.

[Actual device-lab Mac evidence](../../results/tests/clipboard-paste-2026-10-30/native-macos/candidate-v2/native-observation.json)
uses an owned disposable macOS 26.5 ARM64 VM. The exact helper passed native
TIFF conversion, image → text → empty → identical image, explicit read failure,
valid text fallback and recovery. Text and empty stages exposed zero image
bytes. The earlier failed native observations remain separate.

The [native commands](../verification/GUIDE__regression-test-entrypoints.md#live-clipboard-paste-and-service-generations)
include private AppKit conversion and controlled Windows PowerShell acquisition
witnesses. Windows cases are skipped on Linux. No Windows device-lab backend
is connected, and actual Codex/Claude shortcut-paste TUI acceptance remains
pending. Mac helper and Linux HTTP/shim/X11 evidence do not establish those
remaining boundaries. No merge, release or deployment is recorded here.

See [generation ownership](../clipboard/REQ__clipboard-generation-coexistence.md),
[policy fingerprint](../clipboard/REQ__server-policy-fingerprint.md) and
[image behavior](../common/REQ__clipboard-image-bridge.md). Reverting code must
preserve existing runtime publications and older processes; cleanup still
requires their original ownership proofs.
