# Container tool installation policy

The existing `src/container-setup.ts` facade composes `src/application/tooling/container-installation.ts` through the named synchronous operations in `src/ports/tooling/container-installation.ts`. The application owns the Claude, npm tool, bubblewrap and uv decisions and stops immediately after a failed stage. Native composition owns subprocess commands, protocol parsing, working directories, root privileges, stdio, timeouts and public messages. Requested-tool routing remains separately owned.

Ports return finite observations and mutation outcomes. The application does not inspect stdout, stderr, process status, shell programs or cleanup patterns. Native failure evidence and the prepared Claude handle are opaque to it. The handle contains the probe program and a per-call note deduplication Set. Ordinary functions are sufficient for this trusted composition; there is no capture, getter or reflection contract.

Claude accepts a valid or restored launcher, installs only when needed, and confirms the installation with the same prepared handle. Successful initial probes publish filtered, sanitized notes before interpreting their result, including an invalid result. Failed initial probes and unusable confirmations publish no notes. A usable confirmation shares deduplication with the initial probe. Every unusable confirmation produces the distinct installation-left-no-usable-launcher failure with the last three sanitized diagnostic lines.

Npm selects the configured registry definition, then observes the wrapper and cached executable. A present wrapper requires no further work. A ready cache still needs wrapper creation. Only a missing cache triggers package cleanup, shim cleanup, installation and reshim before wrapper creation. Each failed mutation prevents later effects. Native code computes package cleanup patterns and writes the wrapper.

Failure interpretation remains operation-specific. ETIMEDOUT means timeout throughout these observations. Exit124/137 mean ordinary failure for the npm wrapper and uv probes, but timeout for the cached executable and bounded mutations. Only bubblewrap exit42 and uv exit1 represent missing dependencies. Bubblewrap selects one runtime for its probe, package-index update, installation and confirmation; other native operations resolve the selected runtime when called. Unexpected native exceptions propagate.

Verification uses finite fake-port workflow cases, consumed negative type contracts, native command/output tests and public setup tests. Existing launcher-layout tests execute the actual shell assets against private filesystem fixtures. Required joined QA also builds the distribution, exercises actual shipping, and runs compiled and extracted public entries. These checks should verify behavior and authority rather than source text, arity, property descriptors or old/new invocation traces.

## Local verification and CI cost

Use local independent review and QA for this migration. Hosted CI requires explicit user authorization; committing or pushing does not override that restriction. Preserve local commits and evidence while hosted execution is unauthorized. Historical CI results do not certify a changed candidate.

## Known ceiling

These boundaries add no installer framework, retry, package-version, cleanup or cache policy. Controlled native mocks and shell fixtures do not certify live registry/network, platform, rootless/remote runtime or permission behavior. Requested-tool routing and the other M11–M14 obligations remain separately subject to the full architecture Goal.
