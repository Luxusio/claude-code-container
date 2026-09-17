# PLAN — Slice 2B: VM networking into the typed library

Working plan. On completion its durable decisions fold into
`ADR__library-boundary.md` and `REQ__internal-library-contract.md`, and this
file is removed.

## Outcome

`hyperVBootstrapNetworkCommand` and `hyperVBootstrapNetworkCleanupCommand` —
the two commands the boundary ADR names as slice 2B — stop being generated
PowerShell and become typed low-level primitives plus pure TypeScript
reconciliation. The broker calls the typed path; the legacy generators remain
reachable only through the same explicit compatibility seam slice 2A
established.

## Scope decision

The ADR names 2B as exactly those two commands. Measuring the code confirms the
boundary and rules two neighbours out:

| Site | What it does | Slice |
|---|---|---|
| `linux-guest.ts:202` → `Get-LinuxBootstrapNetwork.ps1` | bootstrap adapter discovery + DHCP address candidate selection | **2B** |
| `linux-guest.ts:241` `hyperVBootstrapNetworkCleanupCommand` | bootstrap adapter teardown | **2B** |
| `vm-create.ts:200-222` | adapter rename / static MAC / add managed adapter | 3 (creation) |
| `linux-guest.ts:129-137` | bootstrap read inside the cloud-init seed | out — cloud-init path stays in host-control |

`vm-create.ts` is deliberately excluded. Every adapter mutation there sits
between `New-VM` and a single `catch` whose rollback is one `Remove-VM`, which
takes the adapters with it. Extracting those calls into N typed round-trips
would trade Hyper-V's free all-or-nothing rollback for a half-configured VM that
ccc must then reconcile itself. That cost is only worth paying when the whole
creation transaction moves, which is slice 3.

## Why this slice is worth doing

Two reasons, and neither is "add types for their own sake".

**The address-selection logic is untested.** `Select-CccBootstrapIpv4Address`
and `Test-CccSameIpv4Prefix` in `Ccc.HyperV.Linux.psm1` are pure computation —
byte-mask prefix comparison, candidate filtering, dedup, an 8-entry cap — living
in a PowerShell module whose only coverage is an asset-hash pin. The logic
itself has never been exercised except on a real Windows host. Pure computation
in the guest-side script is precisely what `lifecycle/` exists to hold, where it
is testable on any platform.

**Discovery runs in a polling loop.** The broker calls
`hyperVBootstrapNetworkCommand` repeatedly (`bootstrapProbeAttempts`) while it
waits for the guest to take a DHCP lease, and every attempt starts a new
PowerShell process. Slice 2A already built the reused session; putting discovery
on it removes that per-attempt process cost.

## What 2B does not inherit from 2A

Both commands dispatch through `hyperVProviderCommandRunner`, the ordinary
unelevated path. Neither needs administrator rights: the VM already exists and
its adapters belong to it. So the elevation machinery 2A required — the
callback-scoped administrator executor, the medium-integrity relay, the
named-pipe handshake, the state/intent journal — is out of scope here, and no
part of this slice may grow a UAC prompt.

Teardown is also contained: it removes one adapter from one owned VM. It cannot
strand a host-wide resource, so it needs no crash-recovery intent journal. The
containment re-check after removal stays, because it is the property that
proves the right adapter went away.

## Type model

The single most important addition is a MAC address opaque value.

Native Hyper-V reports a MAC as twelve uppercase hex characters
(`00155D011A2C`). ccc carries its own as colon-separated lowercase
(`02:15:5d:01:1a:2c`), and derives the bootstrap MAC from the managed one by
replacing the `02` prefix with `06`. Today these two spellings are reconciled
ad hoc, per call site, with `.Replace(':','')` and `.ToUpperInvariant()` string
juggling — inside a path that ends in `Remove-VMNetworkAdapter`. A spelling
mismatch there does not fail loudly; it selects a different adapter or none.

So: one `HyperVMacAddress` opaque value with one canonical internal form, a
parser for each external spelling, and a renderer for each. Destructive
selection compares canonical values, never strings.

`HyperVVMNetworkAdapter` gains `macAddress` and `ipAddresses`, both of which the
decoder must supply for this slice and neither of which it carries today.

## Low-level additions

Four primitives, each one native cmdlet:

- `Get-VMNetworkAdapter -VM <id>` — VM-scoped adapter read. The existing
  operation is host-wide (`-All`) and carries no selector.
- `Get-VMNetworkAdapter -ManagementOS -SwitchName <name>` — host management
  adapter read, for the prefix set discovery matches against.
- `Get-NetNeighbor` — IPv4 neighbour table, for MAC-matched address candidates.
- `Remove-VMNetworkAdapter` — the one destructive primitive.

`Get-NetIPAddress` and the host-wide `Get-VMNetworkAdapter` already exist from
2A and are reused unchanged.

## Reconciliation

Pure, in `lifecycle/`:

- **Discovery.** Given a VM's adapters, the management adapter addresses, the
  host IPv4 prefixes, and the neighbour table, produce the ordered bounded
  candidate address list. This is a faithful port of the two psm1 functions,
  including the 8-entry cap, the `0./127./169.254.` exclusions, and the
  same-prefix rule. Ported behaviour is pinned against the PowerShell source by
  test, not by reading.
- **Teardown.** Given the VM's adapters and the expected bootstrap MAC, decide
  remove / already-absent / ambiguous / identity-mismatch. Identity requires
  the exact MAC *and* the expected adapter name *and* the expected switch, as
  the current script demands; anything else refuses rather than guesses.

Diagnostic codes stay byte-identical to the current ones, because the broker
maps them into public status today.

## Acceptance criteria

1. A raw string cannot be passed where a MAC address is required; native-hex and
   colon spellings both parse to one canonical value and compare equal.
2. Malformed, wrong-length, and non-hex MAC input fails closed with a named
   error, and invalid input invokes the executor zero times. The all-zero MAC
   that native Hyper-V reports for an adapter with no address yet assigned
   decodes to absent, not to a value and not to a failure.
3. `Get-VMNetworkAdapter` VM-scoped, management-OS, and host-wide requests are
   distinct union members; a VM-scoped request cannot be built without a VM
   identity and the host-wide request still carries no selector.
4. The ported address selection agrees with the PowerShell implementation on a
   table of cases covering: no adapter, multiple adapters, wrong switch, empty
   candidates, neighbour-only candidates, adapter-only candidates, duplicates,
   out-of-prefix addresses, excluded ranges, and more than eight matches.
5. Teardown removes only an adapter whose MAC, name, and switch all match; a
   mismatch on any one refuses with the existing diagnostic code.
6. Teardown re-checks host-wide containment after removal and fails when any
   adapter still carries the bootstrap MAC.
7. Every diagnostic code the broker maps today is produced by the typed path
   with the same spelling.
8. No path in this slice requests elevation; a test asserts the typed bootstrap
   operations never construct an administrator-scoped executor.
9. Discovery reuses the existing session across polling attempts rather than
   starting one process per attempt.
10. The legacy generators remain behind the compatibility seam; the broker never
    dual-runs both paths.
11. Full build, lint, three typechecks, and the existing suite pass.

## Sequence

1. `HyperVMacAddress` opaque value, parsers, renderers, tests.
2. `HyperVVMNetworkAdapter` gains `macAddress` / `ipAddresses`; decoder and the
   PowerShell converter updated together; asset digest re-pinned.
3. The four low-level operations, with request contracts and decoders.
4. Pure discovery reconciliation + parity table tests.
5. Pure teardown reconciliation + refusal tests.
6. Broker adapter wiring; legacy generators moved behind the seam.
7. Docs: fold decisions into the ADR and the library requirement; delete this
   file.

## Risk

The destructive surface is one `Remove-VMNetworkAdapter` against an owned VM.
Its mitigation is exact canonical-MAC identity plus name and switch agreement
plus post-removal containment — all three of which the current script already
does and none of which this slice may weaken.

The porting risk is that the TypeScript selection silently disagrees with the
PowerShell it replaces. That is what criterion 4 is for: the parity table is
written from the psm1 source and must fail if either side is changed alone.

## Step 6 status — routing attempted and reverted

Steps 1-5 are complete and committed. Step 6, routing the broker's three call
sites through the typed path, was implemented, hit a test-harness problem that
is not yet explained, and was **reverted rather than shipped**. Everything on
the branch today is additive: the typed path exists and is tested, and the
broker still calls the legacy generators.

The routing itself was straightforward — a `HyperVBootstrapNetworkSeam` closed
union mirroring `hostFabric`, plus two helpers that both paths answer through.
What stopped it was `device-lab-hyper-v-linux-broker.test.ts`'s end-to-end test.

What is established by measurement:

- The seam composes the typed client and `options.run` is called; the requests
  it emits are correct (`{"operation":"Get-VM","names":["ccc-<owner>-<device>-<incarnation>"]}`).
- Those nine requests never reach the test's own `commandRunner`, which logged
  all forty-six other commands of the same run.
- They are nonetheless answered, with a well-formed empty envelope.
- `configureTypedHyperVNetworkOperations` wraps the runner with a fabric
  simulator that intercepts typed operations before the test's body sees them,
  and its `Get-VM`-by-names case answers from a VM list built only from network
  allocations. That explains the empty answer.
- Making the simulator defer what it does not model fixed the bootstrap path
  and broke `device-lab-broker.commands.test.ts`, where "no such VM" is the
  correct fabric answer. Moving the device VM into the test's own
  `beforeOperation` hook then produced a hook that never observed a `names`
  request at all, which contradicts the measurement above and is the part that
  is still unexplained.

Deliberately not resolved by weakening the end-to-end test. It is a real
regression guard for the whole Linux create/boot/cleanup lane, and degrading it
to land routing would trade a proven check for an unproven one.

The next attempt should give the typed bootstrap path its own broker-level test
with a runner that is not behind the fabric simulator, prove the three call
sites against that, and only then decide what the end-to-end test should model.
