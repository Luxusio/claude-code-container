# Clipboard server policy fingerprint

Status: accepted.

An authenticated running Clipboard bridge must report a compatibility version
that changes when its compiled facade or moved Clipboard policy changes. This
preserves upgrade detection after the snapshot, text-write and server lifecycle
operations move behind application boundaries. Existing image/text contracts
remain defined by [image bridge](../common/REQ__clipboard-image-bridge.md) and
[text copy](../common/REQ__clipboard-text-copy.md).

The version is the first twelve lowercase hexadecimal characters of a SHA-256
digest, captured once at module import. It hashes a fixed, ordered runtime
closure: `clipboard-server.js`, `domain/clipboard/snapshot.js`,
`domain/clipboard/text-write.js`, `domain/clipboard/server-lifecycle.js`,
`application/clipboard/snapshot.js`, `application/clipboard/text-write.js` and
`application/clipboard/server-lifecycle.js`. A fixed format prefix and each
literal logical filename and UTF-8 byte length frame the corresponding source
body. Equal concatenated bodies in differently divided files must produce
different versions. The resolved absolute directory is not digest material.

The native adapter resolves those compiled files relative to its module. It must
not scan directories or imports, use an environment or working-directory root,
load optional modules dynamically, or substitute TypeScript source. Type-only
ports and existing external/native dependencies are outside the fingerprint.
The native helper, platform commands, authentication and HTTP transport retain
their existing authority and protocols; this requirement adds no restart trigger
for dependencies that the old facade hash did not cover.

If any hash read fails, the imported module captures `unknown`, retaining the
existing failure behavior. Later file changes do not change that module's
captured version. A missing statically imported runtime policy module instead
fails ESM startup before a server can publish health or port metadata. An
incomplete distribution must not be reported as a live `unknown` server.

Authenticated `/health` reports the captured version. Unauthenticated health
continues to expose only service liveness. Ensure reuses an authenticated bridge
with the current version; a differing version follows the existing serialized
upgrade and shutdown-acknowledgment workflow. Active or uncertain container bind
users defer the upgrade and preserve the authenticated existing bridge and its
mounted port inode. Hash changes never grant authority to remove mounted state,
reclaim an uncertain lock, or stop a foreign process.

Verify each listed runtime file and the facade by independent byte mutation,
the framing rule, each read failure, import-time capture, missing-static-module
startup failure, authenticated reuse/upgrade and conservative bind-user deferral.
Exercise both an extracted root `npm pack --ignore-scripts` package outside the
checkout and the actual `materializeUnixInstallPayload` result from that package.
Both must use freshly built/assembled compiled modules and strict declarations
without source files, checkout dependencies or a runtime TypeScript loader.

Known ceiling: portable native-command and protocol fixtures do not establish
interactive Windows or macOS desktop clipboard behavior; native acceptance
requires those hosts.
