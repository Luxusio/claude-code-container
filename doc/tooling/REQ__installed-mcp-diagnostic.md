# Installed MCP diagnostic

These engineering requirements derive from M13's self-contained installed
distribution and the existing `devices smoke` diagnostic. They do not replace
the comprehensive Level 0 provider-dispatch verification suite.

- Build a standalone `diagnostic.mjs` beside every selected MCP `server.mjs`
  output. Its runtime closure must not require checkout Source, test helpers,
  runtime TypeScript loading or repository `node_modules`.
- Reserve the companion filename `diagnostic.mjs`, ignoring case, for the
  diagnostic. Reject a colliding server `--outfile` before either build writes
  output, preserving any existing file. Other custom server filenames remain
  supported.
- The production admin diagnostic selects the installed bundle by default and
  retains its explicit script/server overrides and existing smoke exit behavior.
- Verify the MCP handshake, canonical advertised names and schemas, current
  display capability, current-display status and a flow containing that status.
  Only read-only catalog/status/flow calls are allowed; no device lifecycle or
  mutating public-tool samples are part of this production check.
- Start the owned server in a fresh private home, Windows profile and working
  directory with an explicit environment. Do not inherit broker credentials,
  profile overrides or test escape configuration from the caller.
- Protect connection setup and all calls with cleanup and a finite deadline
  shorter than the admin subprocess limit, reserving time to close the child.
  A closed, malformed, stalled or incompatible server fails the diagnostic.
- Actual direct execution works with spaces and URL-significant path characters.
  The diagnostic returns nonzero for failure; the admin presents FAIL or missing
  artifact SKIP accurately, without changing the historical outer CLI exit code.

Verification must execute the real bundle and default admin route in a private
materialized payload without development modules, check the protocol-call
allowlist and confirm cleanup after failed initialization and stalled calls.

## Direct invocation identity

Invoking the installed diagnostic through a symlinked entry or ancestor must run the same diagnostic as its canonical path. Direct-entry detection compares the actual module identity; lexical path differences must not silently skip diagnostics. Importing the module must remain side-effect free for dispatch, including unrelated or unavailable process arguments. Exercise both explicit alias invocation and import-only behavior in private subprocess fixtures.

## Known ceiling

This proves the installed diagnostic protocol and artifact closure. It does not
certify real provider lifecycles, native clipboard behavior, Windows/macOS host
acceptance or every comprehensive Level 0 tool-dispatch case.
