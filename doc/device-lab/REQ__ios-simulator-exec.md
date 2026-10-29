# iOS Simulator program execution

Status: derived from actual Mac observations, 2026-10-27.

## Basis

The saved Level 3 Simulator case fails when its echo command is wrapped in
`/bin/sh -lc`. Direct host probes reproduce the same launchd failure on iOS
26.5 and 27.0. Both runtime roots contain `bin/launchctl` and lack `bin/sh`.
The installed `simctl help spawn` says bare program names search the device's
PATH, while absolute executable paths start from the host root. These facts
do not establish the complete cause of launchd error 111, and do not justify
running the test command in a host shell or using deprecated standalone mode.

## Execution contract

Public `exec` accepts exactly one of the existing `command` string or a new
`argv` array. Existing command strings retain their exact shell construction,
quoting, error behavior and backend support. Do not split strings into words,
retry them as direct programs, or substitute a host operation after failure.

The explicit argv form is supported only for an owned iOS Simulator. It has
1–64 string elements, at most 4096 characters per element and 4096 characters
in total, with no NUL. The first element is a program basename matching
`[A-Za-z0-9][A-Za-z0-9._+-]*`; paths and option-like program names are refused.
All later argument bytes, including whitespace, empty strings, quotes and
shell metacharacters, are passed unchanged. They are not shell syntax.

After the existing owner and actual Simulator target checks, invoke the fixed
`xcrun` executable with `simctl spawn`, the verified UDID, and exactly that
argv. Bare-name resolution intentionally uses the device PATH; this mode does
not authorize host-root executable paths. Preserve native status/output/error
projection, existing command deadlines, and lifecycle/cleanup protections.

Validate public inputs before dispatch. Validate broker RPC inputs as well,
and refuse argv for every non-Simulator backend before any native executor is
selected. A direct provider call also validates argv before invoking its leaf.
The MCP application admits normalized execution inputs through an explicit
validation port. Server composition binds that port to the existing canonical
validator; the application must not import a provider package directly or
duplicate its validation policy. Keep the validation location, order and
returned details unchanged. Repository factory fixtures supply the same
capability explicitly; external custom factory constructors need that port.
Keep malformed arrays, both/neither forms, foreign/missing targets and unsupported
backends as failures. No shell or host fallback, retry, timeout extension or
skip may turn an unsuccessful execution into a pass.

The MCP-to-broker RPC projection retains the argv array without rewriting it;
backend-child transport retains the same array. An internal direct call with
a contradictory explicit backend hint preserves the existing
`device-backend-mismatch` refusal before invoking any provider.

## Results

Successful execution retains the existing `stdout`, `stderr` and `status`
result. Broker RPC rejects invalid execution forms with HTTP 400,
`error:"device-exec-input-invalid"` and a fixed validation `detail`. A valid
argv form targeting another backend returns HTTP 501,
`error:"device-exec-argv-unsupported"` and the selected `backend`. These error
payloads have `ok:false`; validation detail does not echo rejected arguments.
Public preflight still rejects invalid arguments before RPC, and existing
HTTP 401 authentication and HTTP 404 owner/target refusals remain intact.

## Verification and limits

Cover schema and actual validation, typed application effects, exact native
argument forwarding, broker-child transport and non-iOS refusal. Preserve a
regression for legacy shell strings and selected native failure privacy.
Use a current-source packaged MCP for portable transport verification.

The real iOS E2E uses `argv:["launchctl","managerpid"]` and requires status zero
plus a positive decimal safe integer in stdout. The actual owned iOS 27.0 host
probe completed bootstatus and returned `32253`; native shutdown and deletion
then succeeded and owned inventory was empty. This establishes the native
primitive used by the assertion. This certifies direct program execution rather than
the availability of a Simulator shell. Candidate Mac provider acceptance
remains required; portable fake executables are not native acceptance.
