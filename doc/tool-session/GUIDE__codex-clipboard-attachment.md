# Codex clipboard image attachment

The public `src/codex-clipboard-image.ts` facade composes one application operation
from `src/application/tool-session/codex-clipboard-image.ts`. The domain module
owns attachment argument scans, eligibility, prompt, filename, and directory
segments. Canonical subcommands and value options come from the existing pure
tool registry, shared with launch and local resume under their individual
eligibility policies. Ports supply the native clock, path joining,
default image reader, directory creation, and image write. The application uses
opaque image values; it neither interprets nor copies native image bytes.

The existing CLI caller remains Codex-only. It passes the project path, mutable
arguments, and clipboard URL/token to the public async function. Admission skips
disabled or missing credentials, existing image arguments, and excluded
subcommands before any image read. An eligible invocation reads the selected
image function once, creates `.omx/clipboard-images/clipboard-<timestamp>.png`,
then returns the prepared image arguments and relative path. A missing image
returns a new copy of the arguments as they exist after the awaited read.

Admission precedes clipboard reads and filesystem effects. Keep one selected
reader invocation and prepare the returned arguments after its awaited read, so
live mutable arguments are not replaced by entry-time snapshots. The facade
exposes the application's async operation and preserves its Promise completion
boundary. Native adapters own path composition, directory creation and image
writes. Verification checks eligibility, resulting arguments, completion and
input/output failures rather than function reflection or native property-read
order.

The HTTP reader remains in the facade. It retains the original authenticated PNG
endpoint, chunk conversion, status/body decisions, and request-error handling.
Synchronous request setup failures reject the Promise. Errors in response
callbacks invoked later retain their original EventEmitter behavior; they do
not acquire a new catch or settlement policy. Read/path/directory/write failures
reject the attachment operation unchanged, with no new retry or cleanup.

Behavior tests check command exclusion before clipboard effects, option/value
adjacency, interactive image arguments and existing asynchronous failure paths.
Registry, launch and resume tests retain catalog independence and their distinct
eligibility policies. Strict fixtures cover consumed ports and public signatures;
clipboard image/server tests use synthetic HTTP and private files. Relocated
resume execution includes its existing registry and tool-layout dependencies.
Verification does not use a frozen implementation or source-shape comparisons.

Root integration verifies emitted facade/domain/application modules and
declarations in packed and materialized installer forms outside the checkout.
The port declaration has an empty emitted runtime module but is not a native
service. Portable and distribution checks do not establish native host clipboard
behavior or the historical Slack reproduction. Native clipboard acceptance stays
separate and unverified by this extraction.
