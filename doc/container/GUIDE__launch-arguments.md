# Container launch argument policy

The application owns the complete project-container run argument operation and
runtime mount, source translation, relabel, socket selection and extra-run-flag
decisions. `createContainerLaunchArguments` and `createContainerMountArguments`
use synchronous ports. Their construction reads no port or native binding.
Domain contracts describe only consumed mutable values; caller identity remains
opaque, and existing native Docker options, Lab config and runtime exports keep
their signatures and mutable arrays.

The native facades retain runtime discovery and process caches, current-container
mount inspection, SELinux sysfs/getenforce observation, Node path joining and
socket existence. Cache/probe/reset bodies are unchanged. The socket resolver is
shared by run arguments and required-mount expectations; these calls retain
separate observations. Existing bind source, daemon identity, lifecycle, session,
credential and device ownership proofs retain authority.

Argument order and lazy reads are compatibility requirements. Mounts remain
project, credential, Git identity, Claude JSON, isolated Device Lab state/auth,
tool caches, optional ready Lab state, manager socket, SSH, extras and clipboard,
followed by labels and image. Unsupported Lab state creates no state mount or
device exposure; KVM group zero differs from undefined. No privileged flag,
additional validation, retry or resource effect is added.

Zero-argument capture ports select the native bind/path/existence/identity and
Object.entries callees before their metadata arguments run. Later calls capture
current functions again. Object.entries retains its original Object receiver.
The original options, nested objects and iterators are consumed directly without
copying, freezing or snapshots. Thrown values and partial observation order
propagate unchanged.

Daemon socket sources bypass caller-container translation. Ordinary absolute
caller paths translate only in nested Docker outside Vitest, using the first
longest destination match with its path boundary. Windows Desktop source
normalization precedes native path joining. Readonly suffix precedes SELinux Z;
named volumes do not relabel. Relabel off/force short circuits remain distinct
from auto Podman observation. Runtime extra arguments observe facts before the
unconditional cgroups override and the conditional nested-container marker.

Verification compares independently frozen old public-facade full argv and
native/metadata traces, exercises the inward decision branches and capture/error
boundaries, and checks strict mutable public declarations. The retained runtime,
Docker argument, lifecycle, bind-source and identity regressions remain required.
Both shipping forms must execute the compiled applications and public facades;
source unit tests alone do not establish distribution parity.

This is an internal parity extraction. Real Docker/Podman, remote/Colima,
rootless, SELinux and native Windows/macOS acceptance remain separate obligations.
This operation does not certify the full architecture migration.
