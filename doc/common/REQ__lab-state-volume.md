---
type: REQ
status: active
created: 2026-09-26
source: user question ("project별로 볼륨 마운트되는거 있던데 그건 왜있지? 없어도 될 것 같은데"), confirmed on a Windows Docker Desktop host where every such volume was 0 B
---

# Lab state volume only where nested VMs can run

A ccc container gets the `<container>-lab-state` volume only when it can actually
run container-QEMU `linux-vm` labs.

## Intent

The lab state volume (mounted at `/home/ccc/.ccc/labs`) holds the disks, snapshots,
imported images and workspace copies of container-QEMU Linux VM labs. Those labs
need nested virtualization: a native Linux container host with `/dev/kvm`, a
rootful runtime, and no VM-backed engine in between. On any other host, such as
Docker Desktop on Windows or macOS, a rootless runtime, or a host without KVM, the
labs can never start. Every project container still received an empty volume.

## Observable behaviors

1. When nested VMs are available (lab status `ready`), containers mount the
   volume exactly as before.
2. When they are not (lab status `unsupported`), new containers are created
   without the volume. The `CCC_LAB_*` environment is still set, so the
   container-QEMU `linux-vm` backend reports `unsupported` with the precise
   reason.
3. A container created before this change that still mounts the volume keeps it.
   ccc neither recreates nor refuses that container for it. It is dropped the next
   time the container is recreated for another reason, and the init-process change
   (`REQ__container-init-and-socket-access.md`) already recreates every container
   once. A mount at that path with another volume name, a bind mount, or a
   read-only mount is still a contract mismatch.
4. On an unsupported host, container-QEMU `linux-vm` `device_create` and image
   import return `lab-provider-unsupported` and write nothing. They used to write
   lab metadata and image copies that could never be started.
5. `ccc labs` reports `state volume: not mounted for new containers (nested VM
   unavailable)`. `ccc labs smoke` reports `default-durable-lab-state: SKIP
   <reason>`, and the same for the lab-runner profile. Output on ready hosts is
   unchanged.
6. ccc never deletes lab state volumes automatically. A host whose status flips
   keeps the same named volume, which is mounted again when it becomes `ready`.
   A status flip can come from switching Docker and Podman, switching rootful and
   rootless, or KVM appearing or disappearing.

## Cleanup of existing empty volumes

Ownership preparation follows the new container's mount policy. When lab status
is `unsupported`, restart/recreation must leave any old named lab volume alone:
do not probe its previous image account, mount it in a repair helper, change its
owners or delete it. Codex state preparation remains independent. A `ready` host
still requires the existing strict ownership checks before replacing the old
container; an unconfirmed required migration must preserve that container/data.

A volume cannot be removed while a container mounts it. Remove or recreate the
project container first (`ccc rm`, or let the one-time recreate happen), then:

```
docker volume rm <container-name>-lab-state
```

`ccc clean --volumes` also removes these volumes, but it removes every `ccc-*` volume,
including `ccc-mise-cache` and `ccc-codex-packages`.

## Verification cues

- On an unsupported host, `docker inspect <new-container>` shows no mount at
  `/home/ccc/.ccc/labs`.
- `ccc labs smoke` prints `default-durable-lab-state: SKIP` on such hosts.
