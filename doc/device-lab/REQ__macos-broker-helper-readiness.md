# Broker macOS guest helper readiness

Status: derived correction, 2026-10-27.

The user requests fixes from saved native failures. The latest Tart failures
reach desktop control readiness but retain only `provider-error`; their exact
guest or broker cause is not established. Source inspection independently finds
that broker create/start never installs the helper script that cursor operations
execute for each new device ID. The direct lifecycle already installs it. This
correction repairs that source-proved gap without claiming it caused every
observed readiness failure.

For an admitted owned Mac VM start, launch, IP discovery, helper preparation and
final publication share the existing bounded start allowance captured before
the owner operation-lock wait. Shorten native calls to its remainder. The
internal installer reuses the existing helper leaves through the bounded backend
child, with the authenticated owner's registered cwd/profile. It acquires no
device lock, starts no VM and publishes no device state itself. Do not call the
direct lifecycle recursively or install from a read-only cursor operation.

Combine observed IP with admitted SSH metadata before helper installation.
Provision before publishing running/helper state through the existing complete
record CAS. Failed or late preparation retains partial-effect/recovery evidence;
it does not establish readiness or authorize a second launch, foreign cleanup
or successor overwrite. Successful detail includes the existing boot/helper
shape used by direct clients, with no credentials or raw child output added.

No SSH configuration preserves skipped provisioning without native SSH/SCP.
Configured `waitForBoot:false` preserves one-shot preparation without a retry
wait. The legacy exported Unix-wall deadline API retains its meaning; pass a
positive remaining duration to the new relative internal adapter. This shares
the allowance inside the broker request, not a new client-to-host aggregate
deadline guarantee.

Verify a fresh owned ID without seeded helper metadata: fake SSH refuses its
missing script until fake SCP installs it. Cover lock retention and HTTP
responsiveness during installation, decreasing remainder, failed/late results,
successor preservation, no-SSH skip and legacy deadline behavior. Native Mac
execution remains required to accept the actual provider correction.
