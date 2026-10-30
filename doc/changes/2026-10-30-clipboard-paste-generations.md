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
Successful empty formats retain the existing text/file fallbacks; native
transport and framing failures remain errors. Windows raw seekable PNG streams rewind
before copying. Darwin helper source participates in the policy fingerprint and
selects a complete hash-qualified helper binary instead of an older global one.
Its directory chain is qualified before execution, compilation and publication.

Before launching a TUI, CCC checks the selected X11 bridge's first successful
sync. Partial client copies leave installed shims intact. Marked sessions verify
all seven installed client assets and program execution permissions before
starting the bridge, so old clients cannot silently bypass generation pinning.
Positive X11 selection-owner loss can restore unchanged host content;
failed or unavailable observations cannot authorize overwriting another owner.
Host-side startup attachment uses loopback and settles incomplete or stalled
HTTP within five seconds. Clipboard readers use bounded transport requests.

Regression evidence is recorded in
[the current owner inventory](../../results/tests/clipboard-paste-2026-10-30/current-evidence.json).
Twenty focused owners account for 1,599 passing tests and 27 platform skips,
using the recorded per-case corrections without repeating unchanged owners. Older
RED reports are retained: stale endpoint selection, lost X11 ownership, native
Mac empty-PNG conversion and stalled/partial startup HTTP each had a failing
witness. TypeScript, affected-source lint and shell syntax checks also passed.
These are focused checks, not a new full-suite or GitHub Actions result.

[Actual device-lab Mac evidence](../../results/tests/clipboard-paste-2026-10-30/native-macos/candidate-v3/native-observation.json)
uses an owned disposable macOS 26.5 ARM64 VM. The exact helper passed native
TIFF conversion, image → text → empty → identical image, successful empty-format
capture, valid text/file-reference fallback frames and recovery. Text and empty stages exposed zero image
bytes. The earlier failed native observations remain separate.

The [actual packaged Mac HTTP flow](../../results/tests/clipboard-paste-2026-10-30/native-macos/candidate-v3/http-native-observation.json)
also passed eight generated transitions on native Node 22.22.1, including real
AppleScript file-URL lookup and JS file fallback. Its authenticated policy is
`c02026440612`. Text/empty responses contain no earlier image; the owned
service and helper stopped afterward. This remains separate from Slack and
actual CLI shortcut acceptance.

Actual Docker verification used an owned container without network or host
mounts. It checked seven normalized assets as the ordinary container user,
root ownership and final permissions, then refused retained old shim, bridge,
policy and nonexecutable same-byte clients before bridge dispatch. Recovery and
exact fixture deletion were confirmed; the initial permission failure remains
in a separate report. This verifies delivery, not actual TUI paste.

The production Darwin daemon compiler entry was also exercised with real clang:
eight cases passed, including unsafe directory ancestry and a substituted
compile output. Two old-candidate controls reproduced the unsafe compiler
entry. The durable native test uses the same driver, skips on non-Darwin hosts
and records child exit and owned cleanup.

The user's actual Slack format listing contained 410,317 PNG bytes and
9,490,384 TIFF bytes. A generated 1600×1500 fixture placed 537,830 PNG bytes
and 9,603,966 TIFF bytes on the native Mac pasteboard, and the packaged service
returned the exact PNG. Its
image → text → empty → identical image sequence passed, with zero image bytes
after text and empty. The same generated image passed HTTP/Codex-consumer and
actual private X11 delivery checks. This is equivalent-size synthetic coverage;
Slack itself and the shortcut-paste TUIs were not exercised.

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

Follow-up verification on October 30 used the saved Mac npm report with 44
failures in five files. Twenty-two clipboard-state failures followed the old
publication filename; the fixture now follows the authenticated generation.
One startup fixture retained a failed installation result for subsequent
clipboard preparation; that failure is now scoped to the intended call.
The other 21 failures read workspace or embedded modules that temporarily
disappeared during the original run. No shared-output test mutator was
established. The current five owners pass 395 tests with two platform skips;
this does not establish a fresh full Mac suite PASS or explain who replaced
those files. Details and report paths are in
[the saved-failure status](../../results/tests/clipboard-paste-2026-10-30/saved-failure-status.json).

Additional changes prepare the selected local Claude profile permission
default, forward the requested Claude launch variable, and repair positively
identified npm launcher links that shadow the source installer. Unknown
launchers and unverified running broker processes remain protected. The
separate remote transport retains its previous launch behavior.

Container Claude and Codex sessions with the current authenticated host
connection receive a browser helper. It sends a bounded HTTP/HTTPS URL to
the host service, which invokes its default browser without treating URL
content as shell code. Explicit session environment overrides remain last.
The new extracted package and Unix materialized payload both report policy
`f2b0577977a9` and pass strict declaration checks; earlier native clipboard
evidence above belongs to policy `c02026440612`.

Actual generated-content Cmd+V tests now cover both Linux TUIs through five
native Mac terminals. Zed attaches the image in both tools. Ghostty and VS
Code do not attach it with Cmd+V; iTerm2 opens its image-paste dialog, and
IntelliJ inserts a host-only temporary image path. Ctrl+V attaches the same
image in all five. These mixed results are remaining terminal integration
gaps, not an all-terminal acceptance PASS. Actual Windows and Slack UI
acceptance remain unverified.

After reviewing these results, the user explicitly chose to preserve the
clients' default image shortcut, Ctrl+V. No terminal-specific Cmd+V integration
or host preference change is added. The historical Cmd+V observations and QA
findings remain recorded; they do not override this clarified shortcut scope.
