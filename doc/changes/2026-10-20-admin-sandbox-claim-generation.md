# Administrative Sandbox generation checks

Administrative Sandbox stop and claim release now compare the owner record's claim generation with the freshly validated host claim. A replacement at identical owner/device/Sandbox coordinates is preserved. The existing host mutation guard covers validation through exact-ID stop; caller-requested release later reacquires it and checks the current claim again. Trusted owner context comes from the caller, while existing record CAS, release flags, command arguments and error handling remain. Explicit legacy compatibility is retained, with a new refusal when an existing legacy host claim has incompatible coordinates. Prune continues without Windows claim release. The derived contract is [administrative Sandbox claim authority](../device-lab/REQ__admin-sandbox-claim-generation.md).

Portable regression coverage uses registered fake Node WSB tools and owned state to distinguish same-generation success from same-coordinate replacement, guard waiting/lifetime, successor publication between stop and release, malformed state and timeout cleanup. These checks do not create, stop or delete a real Sandbox or host claim.

## Known ceiling

The shared guard covers cooperating current writers; older binaries and external writers can bypass it. Claim and owner-state files are not one crash-atomic transaction. Executable discovery retains its existing lack of an explicit timeout, and no whole-operation deadline or native Windows certification is claimed.
