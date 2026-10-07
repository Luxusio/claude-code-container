# Version-file scanning and tool context

The scanner facade preserves five public functions and mutable VersionHint data.
Domain tooling owns the exact filename inventory, matching, parsing and first-tool
hint precedence. The application owns the complete recursive scan through five
required synchronous ports: directory entries, observed byte size, UTF-8 text,
child path and relative source path. Presentation owns the two exact context
formatters; index.ts retains both existing scans and its prompt/acceptance order.

The facade combines the mutable COMMON_IGNORE_DIRS array with scanner-specific
names once at module import. The application retains that explicit ignored set
by reference and supplies no native defaults. Structural entries retain original
name reads and isDirectory/isFile member receivers. Do not normalize entry kinds,
detach classifiers, sort entries or cache repeated names during a parity cutover.

Scanning retains unsorted DFS order, fresh mutable Maps, immediate child forEach
merging and duplicate-key overwrite without position changes. Directory failure
returns accumulated results; stat/read/relative-path/insertion failure skips that
file and continues siblings. Child-path computation remains outside the file
catch. Directory exclusions and dotfile matching keep their original ordering.

Observed size 102400 bytes is included; 102401 is excluded without reading.
Numeric depth values retain their original comparison and recursion semantics.
Context truncation is 2000 JavaScript code units. Preserve exact parser regexes,
JSON catches, truthy non-string SDK values, first-tool precedence and all strings.

Verify ordered fault/receiver/Map traces, actual private native trees and denied
reads under a nonprivileged UID, public defaults/arity/import-time snapshot,
mutable declarations, exact format bytes and both shipped payloads. Vitest mocks
that delegate native reads are facade evidence. Compiled subprocess proof must
separately import the real shipped facade and inject only a named private-file
observation failure while delegating other native operations. CLI help/version
alone does not establish scanner behavior.

## Known ceiling

Windows backslash hint parsing remains unchanged; correcting it requires a
separate authorized behavior change. The existing `.tool-versions` line regex
also ignores CRLF-terminated lines; LF lines still participate in first-tool
precedence. Exact baseline execution established that behavior, so this parity
cutover does not silently normalize it. The size threshold is an observed stat
decision, not a race-resistant read cap. Dirent symlinks are skipped, but the
existing stat/read replacement race gains no new link fencing. Native platform
and link capabilities remain unverified when unavailable. Prompting, mise writes,
credentials and the remaining architecture packets are separate work.
