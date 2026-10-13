# Broker recording artifact recovery

Broker recording stop must preserve Android media until the captured recording's artifact is copied and its remote cleanup is authorized. A successful process stop does not prove a successful copy.

- After verified recorder exit, publish a stopped pending-copy record for the exact captured recording before copying. Failed or conflicting publication permits no artifact effect.
- Failed copying reports `recording-artifact-copy-failed`, retains the remote original and pending recovery record, and allows a later stop to retry. Status preserves recovery evidence; start refuses overwriting it.
- After copying succeeds, publish copy-complete evidence before removing the remote file. If publication fails, keep the source. If removal fails, keep the copy-complete record so retry removes the source without repeating the copy. Clear metadata only after authorized cleanup and conditional publication.
- Publication checks captured recovery state as well as runtime identity. A delayed status operation must not erase a pending record belonging to the same runtime.
- Native stop, pull and removal each recheck the captured device, recording and exact physical attachment lease immediately before execution. Keep the device-operation lock outside the short physical-lease and state checks. Never hold the lease lock while awaiting process exit.
- Unknown or malformed expected process identity authorizes no signal or media effect. Verified PID reuse must not signal the successor. Remote process-name stopping is not evidence of an exact remote PID.
- Both auxiliary and device cleanup preserve incomplete media recovery records. Successor device/recording generations and foreign leases remain untouched.

Verification covers repeated copy failure then success, copy-complete retry, removal/publication failure, delayed stale status, same-path successors, lease replacement around effects, uncertain identity, and ordinary completion. Native Windows process/lease tests qualify those bindings; real ADB media acceptance requires an available Android target and is recorded separately.

Implementation uses the existing recording domain/application/ports, native broker binding, owner-state publication and physical lease helpers. It introduces no general recovery service or new journal.
