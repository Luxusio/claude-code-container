# Level 3 broker endpoint isolation

Status: approved, 2026-10-26.

## Basis

In the 2026-10-26 task conversation, the user approved preserving the shared
broker after reviewing the concrete proposal: ordinary port 17373 with
`runtime.json`, and Level 3 port 17374 with `runtime-17374.json`. The confirmation
was `ㅇㅋ ㄱ`. The [failure chronology](../changes/2026-10-22-test-failure-groups.md)
records the native entry-path conflict that motivated this outcome.

The environment variable, strict validation, explicit API precedence, propagation
and metadata scoping below are derived implementation choices. They follow the
existing [host launch](REQ__host-broker-launch.md) and
[recovery](REQ__host-broker-automatic-recovery.md) boundaries; they are not separate
user-confirmed requirements or evidence of native acceptance.

## Outcome

With its default dedicated endpoint, `npm run test:level3` must preserve the
ordinary host broker on `127.0.0.1:17373` and its
`~/.ccc/devices/broker/runtime.json`. The runner defaults
to `127.0.0.1:17374` with `~/.ccc/devices/broker/runtime-17374.json`, so a verified
global installation and a checkout build can coexist without trusting each
other's executable paths.

## Endpoint and metadata contract

Host CLI and MCP use one shared validator for `CCC_DEVICE_BROKER_PORT`. An absent
or empty value retains ordinary behavior. A supplied value must be a canonical
decimal integer from 1 through 65535; invalid values fail before broker effects.
Explicit numeric internal API ports retain precedence. In configured mode the
effective numeric port also selects the metadata filename and child environment;
without the override, existing explicit-port APIs retain their singleton metadata.
A configured port other than 17373 selects `runtime-<port>.json`; the default
port retains `runtime.json`.
No arbitrary runtime-file path is accepted.

The Level 3 runner supplies 17374 unless an explicitly configured valid port is
present, and propagates the same environment to preflight and provider clients.
Preflight refuses a CLI-reported endpoint different from that selected port.
Configured implicit MCP routing defaults to loopback and must not follow a
different port stored in metadata. Selected metadata is used consistently for
read, publication, removal, compare-and-set, authenticated generation checks,
and reported runtime paths. On 17374 or another nondefault dedicated port,
scoped operations preserve the ordinary runtime file, including when startup,
reuse or recovery fails. Explicitly selecting 17373 rejoins ordinary routing
and its shared `runtime.json`; the separate-broker guarantee no longer applies.

## Preserved boundaries

Keep the actual HOME, shared owner/authentication state, provider state,
physical-device leases and host mutation locks. Keep the existing exclusive
real-provider test lock. Endpoint isolation does not isolate the physical
devices or permit simultaneous conflicting provider operations.

Retain exact trusted entry-path checks, native listener/PID/birth observations,
protocol compatibility, owner resolution and successor protection. A foreign
listener on the selected port remains a refusal. Do not restart the ordinary
broker to run Level 3. Internal Level 2 broker fixtures with temporary HOME and
free ports clear the override and keep their existing isolated runtime cleanup.

## Verification

Use controlled endpoint and private-HOME fixtures to check strict validation,
default compatibility, explicit port selection, scoped read/write/removal and
generation checks, and byte-for-byte preservation of a default runtime sentinel.
Verify runner environment propagation and refusal of mismatching preflight
output. Do not probe shared host ports in portable unit tests.

Actual macOS acceptance requires host execution: the ordinary listener and
runtime stay intact, the checkout broker is attested on the selected endpoint,
and Level 3 produces its actual provider results. Portable tests do not certify
native macOS ownership or real providers.
