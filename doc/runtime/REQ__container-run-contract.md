# Existing container admission

This derived contract preserves the existing behavior of `startProjectContainer`
while moving its strict and deferred admission decisions out of `docker.ts`.
It follows the [architecture contracts](../common/SPEC__ccc-architecture-contracts.md)
and [captured runtime authority](REQ__captured-container-runtime.md). It does not
change the CLI, container labels, storage, timeouts or replacement policy.

## Strict admission

Each check obtains fresh inspection of its exact container ID. Unavailable
inspection returns an indeterminate result, not a mismatch or permission to
replace a container. Preflight requires a known running state. A confirmed
stopped container uses static mount verification; live verification requires a
confirmed running container. Neither unknown nor stopped live state permits
execution probes.

Strict admission requires the desired immutable image and identity labels,
valid host configuration, CCC management and project identity, well-formed
project and device-lab mount fingerprints, and the exact inspected container ID.
Missing and empty fingerprints retain their legacy meaning; a fingerprint does
not replace current source identity proof. Required mounts use the existing
mount-verification application and its retry, daemon and cleanup rules.

Broker-auth mount selection and its environment must agree. Privileged mode,
missing init, nonempty device requests, stale lab environment, unexpected VM
devices and extra supplementary groups refuse admission. Ready lab settings
require the exact configured KVM device and group set; unsupported settings
permit neither VM devices nor supplementary groups.

## Deferred admission

A running CCC-managed container may defer additive contract updates only after
project identity, project fingerprint, exact container ID, effective execution
user and current mount proof succeed. The effective-user proof retains its
existing UID, GID, username and HOME checks. Unknown or stopped state refuses
before execution-user or live mount probes.

Image and identity-label drift, device-lab fingerprint, broker-auth environment,
lab environment and init updates do not independently prevent this existing
deferral policy. It still rejects privilege expansion, nonempty device requests,
foreign devices and foreign groups. Ready settings may omit expected devices
or groups but may not add others. Unsupported settings permit neither.

## Native interpretation and failures

Docker and Podman inspection records stay in the native adapter. Missing
`DeviceRequests` is accepted only for the trusted selected Podman runtime; an
inspection payload cannot select that exception. Existing null-array, device,
group and environment coercions remain. Environment values split at the first
equals sign and the last occurrence wins.

Observation and decision order remains staged. Malformed later device/group
values cannot preempt an earlier image, management, state or mount refusal.
Each mount proof uses the inspection captured for that invocation, with the
existing bind guard and runtime authority. A previous check grants no cached
permission to a later invocation.

Strict retryable proof returns `null`; defer retryable proof returns `false`.
Ordinary failures inside the decision region report the existing generic
inspection diagnostic with those same return distinctions. Initial inspection
exceptions remain outside that catch boundary. Runtime-unavailable errors
propagate as their original object. Existing diagnostic strings, ordering and
strict-only debug reporting remain unchanged.

## Verification

Focused semantic and native-observation tests cover state/probe ordering,
strict versus subset policy, runtime-selected schema, fresh inspection and
failure translation. Consumed compiler contracts cover the required semantic
ports. Existing public Docker, lifecycle, mount-verification and runtime-error
owners verify actual construction and caller behavior. These checks do not
certify native macOS or Windows execution by themselves.
