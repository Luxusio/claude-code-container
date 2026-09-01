---
area: device-lab
slug: hyper-v-network-teardown-identity
status: current
---

# REQ — Network-switch teardown ownership authority is the switch GUID

## Requirement
`hyperVCleanupNetworkCommand` (src/host-control/hyper-v/host.ts) MUST treat the
switch **GUID** (`$ExpectedSwitchId`) as the ownership authority, not the `Notes`
marker string:

```
if ([string]$Switch.SwitchType -ne 'Internal') { throw 'hyper-v-network-switch-ownership-conflict' }
if (-not $ExpectedSwitchId -and [string]$Switch.Notes -cne $Marker) { throw 'hyper-v-network-switch-ownership-conflict' }
```

The exact `Notes -cne $Marker` check is enforced ONLY when `$ExpectedSwitchId` is
absent (inspection-only paths). When present, switch identity was already
verified (the identity check throws `hyper-v-network-switch-identity-conflict`
unless the found switch's GUID equals `$ExpectedSwitchId`), so a matching GUID is
proof of ownership regardless of marker form.

## Why
The residue cleaned in E2E step 1 comes from many prior runs across code
versions. The SETUP path adopts/repairs owner-scoped switch markers and
recognizes BOTH the `stable` and `token` marker forms
(`$ObservedMarkerRecognized = $ObservedStable -or $ObservedToken`, with
token↔stable migration). So the switch's `Notes` legitimately drifts between
recognized forms. The teardown previously enforced an exact single-marker match
with none of that tolerance → false `hyper-v-network-switch-ownership-conflict`
that blocked residue cleanup even though the switch GUID matched.

## Invariant / consistency
- Ownership authority: switch GUID (`$ExpectedSwitchId`), verified before any
  mutation. Marker is secondary and expected to drift.
- For the removeSwitch path `$ExpectedSwitchId` is REQUIRED (host.ts guard), so
  identity is always available there.
- Safety retained: switch ambiguity (`Count -gt 1`), identity conflict, in-use
  deferral (attached adapters), and NAT/gateway identity checks are unchanged.
- Mirrors [[hyper-v-delete-disk-guard-subset]]: trust the strong identity proof
  (GUID / Notes marker / owned directory); do not let a secondary check that
  legitimate state variation can break veto owner-scoped cleanup.

## Regression coverage
- src/__tests__/device-lab-hyper-v-provider.test.ts asserts the split guard
  (unconditional Internal type check; identity-gated marker check).

## History
- v1: exact `SwitchType -ne 'Internal' -or Notes -cne $Marker` → rejected
  owner-scoped residue whose marker form drifted. Superseded.
- v2 (current): identity-gated — switch GUID governs when available.
