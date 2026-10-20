import { createQemuLifecycleApplication } from "../../../packages/device-lab/providers/application/qemu-lifecycle.mjs";
import type { QemuLifecyclePorts, QemuLifecycleResult } from "../../../packages/device-lab/providers/ports/qemu-lifecycle.mjs";

export function rebootQemuLab(ports: QemuLifecyclePorts): QemuLifecycleResult {
    return createQemuLifecycleApplication(ports).reboot({ labId: "typed-lab" });
}
