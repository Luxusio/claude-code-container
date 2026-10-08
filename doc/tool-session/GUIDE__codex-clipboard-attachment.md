# Codex clipboard image attachment

The public `src/codex-clipboard-image.ts` facade composes one application operation
from `src/application/tool-session/codex-clipboard-image.ts`. The domain module
owns the unchanged argument scans, excluded subcommands, value options, prompt,
filename, and directory segments. Ports supply the native clock, path joining,
default image reader, directory creation, and image write. The application uses
opaque image values; it neither interprets nor copies native image bytes.

The existing CLI caller remains Codex-only. It passes the project path, mutable
arguments, and clipboard URL/token to the public async function. Admission skips
disabled or missing credentials, existing image arguments, and excluded
subcommands before any image read. An eligible invocation reads the selected
image function once, creates `.omx/clipboard-images/clipboard-<timestamp>.png`,
then returns the prepared image arguments and relative path. A missing image
returns a new copy of the arguments as they exist after the awaited read.

The timing of reads is part of compatibility. Do not snapshot the options or
argument array at entry, bind a custom reader to the options object, or add an
async forwarding wrapper. The facade forwards the application's named async
function directly, retaining its name, arity, and completion boundary. Relative
path composition lets the native `posix.join` callee be read before timestamp
template coercion. Directory creation retains `mkdirSync` lookup before its
nested native `join`. Reader selection, URL/token reads, and filesystem calls
remain at their original stages.

The HTTP reader remains in the facade. It retains the original authenticated PNG
endpoint, chunk conversion, status/body decisions, and request-error handling.
Synchronous request setup failures reject the Promise. Errors in response
callbacks invoked later retain their original EventEmitter behavior; they do
not acquire a new catch or settlement policy. Read/path/directory/write failures
reject the attachment operation unchanged, with no new retry or cleanup.

The architecture tests replay a frozen inert facade from commit
`c284ead3a637d4d31ca93661920ee0f0200b9077` against the actual candidate under
explicit synthetic native bindings. They check argv and result identity, option
getters, mutations across await, function/receiver/callee behavior, coercion,
HTTP callbacks, and raw failure identity. Pure core tests cover the operation
sequence and dependency guard negatives; strict type fixtures preserve required
ports and mutable public signatures. Existing clipboard image/server tests use
synthetic HTTP and private files. The architecture typecheck includes these files
through its existing explicit globs.

Root integration verifies emitted facade/domain/application modules and
declarations in packed and materialized installer forms outside the checkout.
The port declaration has an empty emitted runtime module but is not a native
service. Portable and distribution checks do not establish native host clipboard
behavior or the historical Slack reproduction. Native clipboard acceptance stays
separate and unverified by this extraction.
