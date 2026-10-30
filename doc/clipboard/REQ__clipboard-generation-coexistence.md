# Concurrent clipboard service generations

## User outcome and provenance

User-explicit, 2026-10-30: “broker가 구버전이 떠있더라도 그냥 신버전도
같이 띄워버릴수는 없을까 … 사용중인거 있다고 구버전에서 버전업 못한다”.
The matching source diagnostic is the shared clipboard service's deferred
upgrade warning. This requirement addresses that clipboard service; it does
not introduce isolated device-provider brokers or separate physical clipboards.

A newer CCC session must be able to select its current clipboard implementation
without stopping an older authenticated service or the sessions using it.
Existing TUIs and their clipboard access must remain usable. The old publication
file, mounted inode and active native helper must not be replaced to achieve this.

## Derived ownership and selection requirements

Derived from the image bridge contract and captured-runtime publication rules:
each concurrent service needs its own private, generation-bound publication and
startup slot. Reuse requires authenticated health for the selected generation.
The captured allowed path follows daemon initialization, publication receipt,
commit validation, retirement and watchdog checks. An arbitrary supplied path
or changed inode never gains publication or retirement authority.

A fresh namespace may be admitted only with exclusive creation and positive
runtime authority. Unknown history, unsafe ancestors, conflicting writers,
malformed records, symlink substitution and successors retain their refusals.
Concurrent callers for one generation converge without overwriting a winner.
Cleanup affects only an exact owned publication or staged process/file.

New sessions explicitly bind the selected URL and token together. Clients must
not silently replace them with an older immutable mounted record. Unmarked
legacy clients retain their existing refresh behavior. Reusing a running
container preserves verification of its actual immutable mount; no active-peer
stop, container replacement or general source-substitution exception is allowed.

The container's X11 selection remains a shared view of the same host clipboard.
An owned bridge may be updated through the existing asset-sync/lifetime path
while both service generations survive. This is not distinct clipboard-source
isolation per TUI. Bridge replacement must preserve both clients' operation and
must never signal an unverified process.

## Native helper continuity

The current policy fingerprint includes the shipped native helper behavior.
Each daemon selects its matching complete helper generation. An existing older
binary's presence is not proof of readiness. Compilation stages and atomically
publishes only owned output; failure cannot select a stale or partial helper.
An older running helper is neither overwritten nor terminated to ready the new
generation.

## Verification

Prove old and new authenticated endpoints live together with unchanged old file
bytes/inode; test contention, wrong-generation receipts, successor preservation
and generation-confined retirement. A new exec joining a running old container
must demonstrably reach the current endpoint while legacy client mode remains
functional. Use different generated image/text state at the two fixture
endpoints so wrong routing fails visibly. Preserve existing mount refusals.

Native Mac and Windows acceptance requires actual respective hosts. A mocked
platform, Linux X11 run or runnable Windows witness alone is not native Windows
PASS. Record candidate and client/OS identity and nonsecret synthetic image
digests, sizes and target transitions; never persist the user's clipboard or
authentication token as test evidence.
