# Per-profile MCP config regeneration

`buildMcpConfig(profile?, restoreAccess?)` remains a synchronous public facade.
It composes `createMcpConfigRegenerator` with native profile-storage and Codex-lock
ports. The domain owns managed server selection, host-definition decoding,
container URL transformation and managed TOML preservation/rendering. The
application owns the complete regeneration sequence and publication decisions.

Fresh and already-running container setup call the same facade for current
Codex and Claude launches. The operation generates both profile files regardless
of the selected tool. Its other public helpers, `readHostMcpServers`,
`rewriteLocalhostUrl` and `processServerForContainer`, retain their existing
synchronous signatures. This boundary does not change localhost listeners,
remote transports or tool launchers.

## Selection and preservation

Each build resolves and reads the Claude profile before reading host servers.
It constructs a fresh managed map before that host read, with the existing
shared Chrome DevTools object and fresh Device Lab config, args and auth-file
environment. Managed/retired/legacy host entries keep their existing exclusions;
accepted host definitions retain their order, cloning and loopback URL rewrite.
No server validation, deep clone, freeze or new allowlist is added.

The original TOML scanner preserves user bytes while removing the existing
managed marker blocks and managed/retired aliases, including their subtables.
Quoted/dotted keys, Unicode escapes, comments, multiline strings and nested
values keep their original interpretation and fallback. Known server keys retain
their order; supported unknown keys retain sorted rendering. The application
compares the resulting exact text and skips only an unchanged Codex write.
Claude publication still occurs on every successful build.

## Storage and lock authority

| Semantic port | Native responsibility |
| --- | --- |
| resolveClaudeProfile | Existing profile/environment path resolution |
| readClaudeProfileDocument | Existing existence observation and optional synchronous native read capability |
| readHostMcpDocument | Existing host-home existence observation and optional synchronous native read capability |
| withCodexProfileLock | Existing profile lock, container refusal and mutation authority |
| prepareCodexProfile | Resolve profile, create parent and read current Codex text with contextual errors |
| publishCodexProfile | Existing direct write and contextual write error |
| publishClaudeProfile | Existing direct write and raw error |

The optional access-restoration callback runs bare inside the generator's Codex
lock, before Codex path resolution and access. The caller's earlier locked access
restoration remains a separate position. The native lock still uses its default
profile fence or named-profile hash, waits 300000ms and does not reclaim stale
locks. Utilities, home-layout policy and Docker access restoration are unchanged.

Writes retain `writeFileSync` and creation mode `0600`. They retain inode and
symlink behavior; they do not become atomic replacement, metadata repair or a
transaction across both files. Core has no native imports, paths, environment
reads or ambient defaults. Publishers return the ignored synchronous undefined
carrier; asynchronous publishers are not valid inward bindings.

## Failure and partial effects

Host decoding retains the original read/JSON/optional-inspection fallback.
Existence is observed first. A present document supplies one read capability;
the application invokes `JSON.parse(read())` inside the original catch, selecting
the parser before native reading. A parser getter failure prevents the read.
Claude malformed JSON and ignored native read failures retain the empty-object
fallback. Existence/path failures outside those catches propagate unchanged.
Valid Claude JSON null, scalars and arrays retain their original behavior;
regeneration adds no runtime rejection or repair.

Codex lock, restoration, access, render or publication failures stop before
Claude mutation and write. Successful Codex publication precedes Claude
`mcpServers` assignment, serialization and publication. A null/scalar assignment,
serialization failure or Claude write error therefore leaves any newly published
Codex bytes in place. There is no rollback. Permission diagnostics and raw error
precedence remain the original native behavior.

Claude publication selects the native writer before evaluating JSON
serialization. Its port getter captures that invocation's writer; constructor
validation recognizes the getter without invoking it. A serializer that changes
a builtin export therefore cannot redirect the already-selected publication.
Serializer or selected-writer failures retain their raw identity and preceding
Codex bytes.

## Verification and known ceiling

Freeze actual baseline source/native authority before edits. Pair baseline and
candidate public facade executions with identical ordered native observations,
raw errors, mutable values and surviving bytes. New core/replay/facade/type/CLI
suites complement the existing MCP forwarding, Codex lock/access and startup
regressions. CLI proof must execute the actual generator through fresh/reuse,
Codex/Claude and default/named variants, retaining both restoration positions.
Native fixtures use private homes and fences around external runtime effects.

Coordinator integration must freshly build and assemble both extracted npm and
materialized installer payloads, execute their real compiled public/inward
exports, and compile strict consumers of their current emitted declarations.
Package inclusion, source authoring or mocked outer call counts alone do not
establish whole-operation acceptance.

Known ceiling: portable source and shipping proof does not certify live MCP
services, real launcher binaries or native macOS/Windows filesystem/ACL behavior.
OpenCode is outside current implementation and acceptance scope. Independent
code/security review, fresh QA and coordinator shipping evidence remain required
before whole-operation credit; this operation does not complete the architecture
migration.
