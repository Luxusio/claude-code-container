# Windows Sandbox create policy

The direct MCP `device_create` binding composes
`providers/application/lifecycle/windows-sandbox-create.mjs`. The authenticated
broker `broker.command.invoke` binding composes
`src/device-lab/application/lifecycle/windows-sandbox-create.ts`. Their domain
and required semantic port contracts live beside those applications in the
registered inward roots. Both bindings are needed before this operation can
receive whole-operation migration credit.

The direct application is synchronous. It reads definitions and refuses an
existing ID before generating a helper workspace. It then assembles the record,
claims it and returns a semantic outcome; the provider formats the existing MCP
response. A helper or claim failure preserves its original thrown value. A claim
conflict leaves previously generated helper files in place, as before.

The broker application creates the record, attempts the owner claim, performs
the nonprovisioning compensation decision on a claim exception or conflict, and publishes the
configuration only after a successful claim. Configuration failure removes only
records with both the created record's ID and `createdAt`. Replacement records
with another timestamp survive. Partial configuration files remain. Sandbox
create has not created a provider resource before the claim, so the application
returns `no-provider-resource-created` compensation evidence directly. A
configuration compensation mutation exception propagates without a new catch.
The native facade converts outcomes into its existing HTTP status and payload,
including the original rollback evidence, redaction and error detail.

## Variant rules

| Rule | Direct definition | Broker definition | Broker native config |
| --- | --- | --- | --- |
| Networking, clipboard, VGPU | `Boolean(value)` after destructuring defaults | `value === true` | `value === true` |
| Memory | Raw value, default 4096 only for undefined | Number value or 4096 | Finite Number value or 4096 |
| Minimized | `value !== false` | `value !== false` | Existing native config behavior |
| Timestamps | Two separate wall-clock calls | One shared timestamp | No definition timestamp |

These policies intentionally remain separate. Public validation may reject a
value that a narrowly characterized internal record constructor accepts; an
internal variant witness is not an assertion of public input reachability.

## Ports and native authority

Direct ports are `deriveDeviceId`, `readDefinitions`, `readOwnerId`,
`ensureHelperWorkspace`, `wallTimestamp` and `claimDefinition`. Broker ports are
`createRecord`, `claimDefinition`, `publishConfig` and `removeMatchingClaim`.
Constructors check bindings without
performing effects. Applications add no retry, lock, capacity control or
filesystem/process dependency. They do not accept a whole-transaction callback.

The existing owner/device operation lock remains outside each inward create
transaction. Native repository locks, owner-state validation, helper paths,
symlink fences, bounded asset reads and atomic publication stay with their
original helpers. `ensureHelperWorkspace`, `writeGeneratedHelperFile` and
`writeBrokerWindowsConfig` retain their original bodies and call order. The
broker's common validation, plan, dry-run and genuinely reachable idempotence
gates remain before the Sandbox transaction. Duplicate create 409 is verified
separately; no successful create idempotence is inferred from a generic gate.

Only Sandbox uses the new broker claim binding. The other backend claim,
rollback and error branches retain their existing behavior. The broker record
constructor delegates its Sandbox record projection to the inward domain,
while native composition supplies its fenced config path and existing single
timestamp.

## Verification

Use the current applications and actual direct MCP/authenticated broker facades.
Faults include helper failure, claim exception/conflict, configuration partial
write and compensation mutation throw. Assert surviving directories, files and
records, as well as returned semantic outcomes and public responses.

The create core, facade and type suites complement existing Windows MCP,
authenticated broker, owner-state, timeout, bootstrap and boundary regressions.
Actual direct MCP and authenticated broker RPC must cover positive and negative
admission, invalid input, dry-run, duplicate 409 and native symlink refusal.
Native helper/config bodies and supporting authority files must remain unchanged.

Coordinator integration must build and freshly assemble before executing the
actual public exports and inward modules in both extracted npm and materialized
installer payloads. Strict positive and negative consumers must use those
payloads' current emitted declarations. Package inclusion alone is insufficient.
Shared shipping scripts and WBS/inventory updates belong to that coordinator.

## Known ceiling

Portable fixtures and shipping execution do not certify real Windows Sandbox,
native Windows filesystem behavior or a live provider. Source authoring alone
does not establish whole-operation acceptance. Independent code/security review,
fresh source QA and both actual shipping proofs remain required. Other Sandbox
lifecycle operations and the full architecture migration remain separate work.
