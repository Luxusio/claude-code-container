# Android broker lifecycle responsiveness

Android lifecycle requests may wait for native provisioning, inventory, boot,
shutdown, recorder/Appium cleanup or AVD removal. These waits must yield the
shared broker HTTP event loop so health and unrelated authenticated-owner RPCs
can progress before the lifecycle finishes. This is a concurrency requirement;
it does not promise a real-device latency bound.

The broker keeps the current device-operation and host-global Android allocation
locks until their complete native effect, state claim and required compensation
settle. Awaiting a command must not allow duplicate allocation, early success
publication, successor replacement or release of authority while cleanup can
still mutate state.

Each post-await process signal or destructive storage step rechecks its existing
current-record/identity authority. Unknown or reused process identities refuse
signalling. AVD deletion retains root/source/staged identity checks, quarantine,
fresh inactivity checks, rollback and final absence verification. A successful
preflight cannot be cached across a later removal fence.

Owner cleanup consumes its captured parent allowance for native execution and
failure cleanup, including the default async runner. Waiting does not reset its
deadline. Existing primary error priority, committed auxiliary observations,
pending recording artifacts and complete-record conditional publication remain
observable after later refusal or expiry. The synchronous physical lease guard
and other providers' synchronous APIs remain compatible.

Verification uses the genuine emitted broker in an owned child, its default
native runner and temporary fake executables. A separate controller holds native
create, boot and shutdown gates and requires health plus another owner's RPC to
finish before releasing them. Deferred core/native tests cover ordering,
contention, deadline expiry, identity changes, successor publication and storage
rollback. Fake executables establish integration and concurrency behavior, not
real Android or native Windows/macOS operation.

## Known ceiling

Short synchronous owner-state transactions and their contention still exist.
This requirement does not certify every broker adapter as nonblocking. Native
Android, physical Windows/macOS, full host runtime lifecycle, GUI streaming and
whole-architecture acceptance require their own current evidence.
