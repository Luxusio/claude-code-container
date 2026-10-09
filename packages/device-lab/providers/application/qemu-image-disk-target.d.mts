import type { QemuDiskArguments, QemuTargetArguments, QemuImageDiskTargetPorts, QemuImageMetadata, QemuDiskResult, QemuTargetResult } from "../ports/qemu-image-disk-target.mjs";
export declare function createQemuImageDiskTargetApplication(ports: QemuImageDiskTargetPorts): {
    listImages(): { ok: true; ownerId: string; images: QemuImageMetadata[]; };
    materializeDisk(args?: QemuDiskArguments): QemuDiskResult;
    listTargets(args?: QemuTargetArguments): QemuTargetResult;
};
