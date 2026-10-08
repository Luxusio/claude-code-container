# Device Lab destructive admission

`OP-device-destructive-admission` (M03) is the complete existing classification
and confirmation decision. `BIND-destructive-admission` binds this policy to MCP
tool dispatch across existing supported backends. Its canonical owner is
`packages/device-lab/providers/domain/destructive-admission.mjs`; the paired
`.d.mts` describes its result union. The legacy
`device-lab-mcp/src/policy/destructive.mjs` directly re-exports the same evaluator
through `@ccc/device-lab/providers/domain/destructive-admission.mjs` and retains
the original mutable `DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES` array.

The domain has no native effects, state, locks or ambient observations. No
effect port or application pass-through is needed for this pure operation.
Public schemas and aliases, flow argument routing, server error presentation,
broker context and concrete device authority remain with their existing owners.

## Exact admission behavior

The evaluator classifies the action before reading confirmation. A classified
action requires the value `confirmDestructive === true`; force is not consent.
Existing inherited property reads remain ordinary JavaScript reads. A
non-destructive or unknown operation returns
`{ ok: true, destructive: false, actions: [] }` without reading confirmation.
The router and schemas continue to restrict public operations separately.

Confirmed destructive actions return `{ ok: true, destructive: true, actions }`.
Denied actions retain `ok: false`, `destructive: true`, error
`destructive-action-confirmation-required`, message
`Set confirmDestructive=true to run this destructive device-lab action.`,
`confirmationField: "confirmDestructive"`, and the ordered `actions` array.
Reasons use the existing Set insertion order without normalization.

Delete reasons are `device-delete`, followed by `force-delete`, `delete-avd`
and `delete-simulator` when their original strict predicates match. Reset uses
`erase-simulator` or `app-data-clear`. Snapshot restore/delete and shutdown use
`snapshot-restore`, `snapshot-delete` and `broker-shutdown`. Uninstall/data clear,
battery and network changes use `app-uninstall`, `app-data-clear`,
`device-system-change` and `device-network-change`. Broker command invocation
of `device_delete` uses `broker-device-delete`.

Broker Appium retains path, method, body, then force/action observation order,
including repeated getter reads. Forced clear/stop adds
`broker-appium-force-lifecycle`. A POST path containing
`/appium/device/remove_app` adds `app-uninstall`. POST `mobile: shell` requests
inspect only the original first argument and String-converted argv: `pm clear`
with a target adds `app-data-clear`; `svc wifi/data`, settings
`airplane_mode_on`, and the exact airplane broadcast add
`device-network-change`; `cmd` argv containing `battery` adds
`device-system-change`. Case, whitespace, substring matching and short circuits
remain the original expressions.

The default argument remains `{}` for omission/undefined. Null, primitives,
getters and argv String conversion retain original property access and raw
exception behavior. The domain does not catch errors or eagerly normalize
arguments. Public server catches and presentation are a separate contract.
Flow confirmation remains per step; parent consent is not inherited.

## Verification and acceptance boundaries

The core test freezes baseline policy independently and compares outputs,
changing getter traces and thrown sentinel identity. The facade test binds the
canonical evaluator and exercises a real public MCP denial, observing zero
downstream routing, provider/native calls and fixture effects. Entry into broker
context alone is not a provider effect. Existing policy, broker Appium,
canonical-flow, preparation and test-level suites retain public schema and
per-step consent coverage.

The negative compiler consumer must pass a completed
`npm run typecheck:architecture`; Vitest transpilation alone cannot establish
the declaration contract. The architecture AST guard checks inward imports and
ambient-effect exclusions. Integration QA must prove the exact package
dependency is included and resolves from both installed directory and packed
npm artifact forms, alongside independent code/security review and CLI QA.

Source extraction and portable fixture proofs do not establish installed,
native or reliability acceptance. `ACC-M03-install`, `ACC-M03-native` and
`ACC-M03-reliability` remain separate obligations; this operation does not
complete M03 or the wider architecture migration. Hosted CI and push require
separate authorization under the current project restriction.
