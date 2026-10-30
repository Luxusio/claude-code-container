# Clipboard server policy fingerprint

Status: accepted.

An authenticated running Clipboard bridge must report a compatibility version
that changes when its compiled facade, Clipboard policy, bind admission or
shipped Darwin helper changes. Existing image/text contracts
remain defined by [image bridge](../common/REQ__clipboard-image-bridge.md) and
[text copy](../common/REQ__clipboard-text-copy.md).

The version is the first twelve lowercase hexadecimal characters of a SHA-256
digest, captured once at module import. It hashes a fixed, ordered runtime
closure: `clipboard-server.js`, `domain/clipboard/snapshot.js`,
`domain/clipboard/text-write.js`, `domain/clipboard/server-lifecycle.js`,
`application/clipboard/snapshot.js`, `application/clipboard/text-write.js`,
`application/clipboard/server-lifecycle.js`, `clipboard-bind-users.js`,
`adapters/runtime-bind-authority.js`, `adapters/runtime-bind-users.js`,
`application/runtime-bind-admission.js` and
`../scripts/clipboard-helper-darwin.m`. The prefix `ccc-clipboard-policy-v2`
and each literal logical filename and UTF-8 byte length frame the corresponding source
body. Equal concatenated bodies in differently divided files must produce
different versions. The resolved absolute directory is not digest material.

The native adapter resolves these files relative to its module. It must
not scan directories or imports, use an environment or working-directory root,
load optional modules dynamically, or substitute TypeScript source. Type-only
ports and other external/native dependencies remain outside the fingerprint.
The shipped Darwin source is captured once independently of compiled-policy
availability and supplies both its fingerprint entry and helper generation.
This permits native helper qualification for source-based callers without
granting a known policy version when compiled-policy reads fail. Platform
commands, authentication and HTTP transport retain their existing authority
and protocols.

If any hash read fails, the imported module captures `unknown`, retaining the
existing failure behavior. Later file changes do not change that module's
captured version. A missing statically imported runtime policy module instead
fails ESM startup before a server can publish health or port metadata. Liveness
or an `unknown` hash never qualifies an incomplete artifact as the current
generation.

Authenticated `/health` reports the captured version. Unauthenticated health
continues to expose only service liveness. A known current policy selects
`clipboard.<12hex>.port` and its own startup slot. An admitted fresh generation
can coexist with an older service; it does not rewrite that service's mounted
file or terminate its helper. An occupied generation still follows the
serialized retirement and shutdown-acknowledgment workflow, including active
session and uncertain bind-user vetoes. An unknown policy retains the legacy
path and cannot authorize generation pinning or disjoint creation. See
[concurrent generation ownership](REQ__clipboard-generation-coexistence.md).
Hash changes never grant authority to remove mounted state, reclaim an
uncertain lock, or stop a foreign process.

Darwin helper binaries use
`clipboard-helper-darwin-<source-sha256-first-16-hex>` under the runtime `bin/`
directory. Only a complete, private, executable regular file for the captured
source qualifies. Compilation uses owned stages and no-replace publication;
an older global binary cannot satisfy current readiness and remains untouched.

Verify each listed runtime file and the facade by independent byte mutation,
the framing rule, each read failure, import-time capture, missing-static-module
startup failure, authenticated generation reuse/coexistence and conservative
bind-user deferral. Cover wrong-generation commit receipts, changed successors,
same-generation contention, helper readiness and generation-confined retirement.
Exercise both an extracted root `npm pack --ignore-scripts` package outside the
checkout and the actual `materializeUnixInstallPayload` result from that package.
Both must use freshly built/assembled compiled modules and strict declarations
without source files, checkout dependencies or a runtime TypeScript loader.

Known ceiling: portable native-command and protocol fixtures do not establish
interactive Windows or macOS desktop clipboard behavior; native acceptance
requires those hosts.
