# Container QEMU lifecycle

The [Linux VM facade](../../packages/device-lab/providers/backends/linux-vm.mjs) delegates create/start/stop/delete to the [application](../../packages/device-lab/providers/application/qemu-lifecycle.mjs). MCP retains owner/device locking and response conversion. Image import is separate; listing, disk materialization and target listing retain accepted bindings.

The [domain](../../packages/device-lab/providers/domain/qemu-lifecycle.mjs) owns validation, guest SSH/agent normalization and presentation. The application owns admission, metadata, launch/reuse, guest-agent preparation, stop classification and delete ordering. [Required ports](../../packages/device-lab/providers/ports/qemu-lifecycle.d.mts) expose finite observations/effects. Disk materialization remains a peer application service.

Native adapters retain path/symlink/owner checks, atomic publication, process identity, guarded signals and SSH execution. A kill override is not identity or exit proof. Creation issues a fresh generated ID, rejects a caller-selected ID and refuses an assigned ID or lab/export residue collision regardless of `force`; a repeated display name creates a separate definition. It never replaces an existing runtime through force-create. Stop must confirm exact process exit before clearing runtime metadata; delete must refuse uncertain settlement.

Launch can survive later publication/provisioning failure; provisioning failure can leave running state. Directory-removal failure can retain stopped metadata. Report those outcomes truthfully without stronger CAS/ABA claims. Guest-agent history retains its 50-entry bound.

Existing [foundation](../../src/__tests__/device-lab-mcp.linux-vm-foundation.test.ts), [provider](../../src/__tests__/device-lab-mcp.linux-vm-provider.test.ts) and [smoke](../../src/__tests__/device-lab-mcp.linux-vm-smoke.test.ts) suites exercise actual facade/MCP, required ports, ownership and partial effects. Reuse the [image/disk/target guide](GUIDE__qemu-image-disk-target.md) for separate operations.

Acceptance requires independent review, current contracts, genuine build, affected regressions and ordinary actual npm/Unix smoke before local delivery. No archived implementation or private consumer framework is required. Portable fixtures do not certify real QEMU boot/guest behavior.
