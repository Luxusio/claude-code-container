# Provider, state and runtime integration

Source was delivered locally at `da5d7d368184aef48ae15ef357be69757688c411`
on `feature/device-mcp-squashed`. Independent verification matched all 72
changed paths to the accepted Git blobs and worktree bytes. All 97 original
user files and the operation inventory remain unchanged.

Windows Sandbox create, runtime capability discovery and Codex/Claude MCP
configuration regeneration now own their policy in the inward layers. Public
facades retain native provider, filesystem, process, lock and ownership
mechanisms. State-file reads and native adapters also move behind explicit
ports, while the broader storage operation remains partial.

The original source pins are Sandbox `c9261aed`, state `8b74ef39`, runtime
`8f97651b` and MCP `0cd28374`. Integration repairs retain MCP parser/callee
ordering and source-loader compatibility. Synchronous session device cleanup
now imports the extracted native cleanup module; legacy admin exports retain
binding identity. A portable immutable original witness removes ignored-task
dependencies from ordinary cleanup tests and shipping consumers. Broker waits
distinguish locally proven pre-RPC deadline exhaustion from remote errors with
the same text using private result provenance.

Fresh complete build, required typechecks and lint passed. Both actual shipping
forms passed seven cleanup and eight inherited consumer entries, current strict
declarations, the explicit 687-file original audit, 41 negative controls and zero
positive denied effects per payload. The final portable suite passed 11,895 tests
across 472 files; 151 tests and ten files were skipped. Its session71539 exited0
in472.78 seconds. Current fenced CLI help, version and invalid-runtime checks
also passed. Build artifacts and all tracked source hashes stayed unchanged.

Earlier failures remain recorded. The final test-only corrections bind Codex
startup cleanup mocks to the new native module and wait for actual fake ADB
registration before asserting both force-delete stop paths. Existing product
calls, assertions and timeouts remain unchanged. These repairs, cleanup
extraction and verification infrastructure receive no additional operation credit.

The WBS now records 58/218 integrated operations (26.6%), 20 partial and140 TODO.
The three new whole operations are Sandbox create, runtime capabilities and MCP
regeneration. State storage receives partial credit only. Counts remain
provisional and unweighted; they do not establish effort, native reliability or
full architecture completion.

Metadata projection passed 13 newly authored isolated renderer controls; an
existing 13-case harness was not found or claimed. Metadata delivery is verified
separately from the source result. Formal Harness close remains separate; no
missing hook receipt becomes a close PASS. Windows/macOS/Colima/provider
performance and full Goal acceptance remain unverified. No hosted CI, push,
global installation, automatic memory cap or Cargo default was added.
