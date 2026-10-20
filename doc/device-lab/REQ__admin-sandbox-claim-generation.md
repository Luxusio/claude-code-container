# Administrative Sandbox claim authority

Administrative stop and claim release must distinguish the claim represented by an owner record from a replacement at the same owner/device/Sandbox coordinates. This requirement derives from the existing [architecture contracts](../common/SPEC__ccc-architecture-contracts.md) for exact claim and destructive authority.

The Windows stop intent carries the trusted caller's owner ID. Record fields must not substitute that authority. The native boundary validates the existing Sandbox GUID, acquires the existing host singleton mutation guard, rereads the existing validated claim file and checks coordinates and generation before executable discovery or exact-ID stop. The guard remains held until the native stop returns and ends before owner-state publication. Existing owner-device locking, state comparison, auxiliary cleanup and record CAS remain unchanged.

| Expected `singletonClaimId` | Validated host claim | Stop / release |
| --- | --- | --- |
| Nonempty A | Same A, compatible coordinates | Stop allowed; release only when already requested by the caller |
| Nonempty A | Different B, legacy or absent | Refuse stop; preserve claim |
| `null` or absent | Modern claim | Refuse stop; preserve claim |
| `null` or absent | Legacy claim, compatible coordinates | Preserve legacy stop and coordinate release rules |
| `null` or absent | No claim file | Preserve valid-GUID legacy stop; release is a no-op |
| `null` or absent | Legacy claim, incompatible coordinates | Refuse stop and release |
| Present malformed value | Any claim | Refuse stop and release |

The host validator is unchanged: owner and device IDs are required; a present host `claimId` must be a nonempty string. Invalid JSON/schema, links, unreadable files and guard errors retain existing error propagation. They must not become absence. Legacy release retains its current expected-ID and Sandbox-coordinate wildcard rules. The absent-file legacy stop is existing compatibility; refusal of an existing incompatible legacy claim is the new authority check.

An authority mismatch yields no Windows stop command and the existing `provider-stop-failed` row for an active record. That record is retained for explicit recovery. Earlier owned auxiliary effects are not rolled back. After successful stop and matching owner-record CAS, a caller-requested release separately reacquires the same host guard and rereads the claim. A successor installed after stop must remain byte-for-byte intact. Explicit inactive deletion follows the same guarded release rule while retaining its existing metadata CAS. Prune does not release a Windows claim. Single and all-project stop retain their existing no-release default.

Regression tests must exercise real native adapter calls with registered fake Node tools: same-coordinate A/B refusal and inactive deletion, matching modern authority, one-sided and malformed generations, legacy compatibility, trusted owner propagation, guard waiting/rereading, guard lifetime through stop, replacement between stop and release, invalid/linked state, timeout and guard unwind. Old-source controls must fail for actual unauthorized dispatch or unlink through existing APIs. No real Sandbox or host claim is used.

## Known ceiling

The guard protects cooperating writers using the same lock. Older binaries and uncooperative external writers remain outside that guarantee. Stop keeps its existing command timeout; executable discovery has no explicit timeout, so this is not a whole-operation deadline. Host claim and owner-state files are not one crash-atomic transaction. Portable fake-tool tests do not certify native Windows Sandbox behavior.
