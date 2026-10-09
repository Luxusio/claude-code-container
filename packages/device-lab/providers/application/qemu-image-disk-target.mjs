import { inferQemuImageFormat, qemuCommandTimeout, qemuOverlayArguments, qemuTargetForLab } from "../domain/qemu-image-disk-target.mjs";
/** @typedef {import("../ports/qemu-image-disk-target.mjs").QemuLab} QemuLab */
/** @typedef {import("../ports/qemu-image-disk-target.mjs").QemuImageSource} QemuImageSource */

/** Complete image, overlay and passive-target policy; construction observes no native state.
 * @param {import("../ports/qemu-image-disk-target.mjs").QemuImageDiskTargetPorts} ports
 */
export function createQemuImageDiskTargetApplication(ports) {

    /** @returns {{ok: true, ownerId: string, images: import("../ports/qemu-image-disk-target.mjs").QemuImageMetadata[]}} */
    function listImages() {
        if (!ports.imagesRootExists()) return { ok: true, ownerId: ports.ownerId, images: [] };
        const images = ports.imageEntries()
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
                try {
                    return ports.readImageMetadata(entry.name);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
        return { ok: true, ownerId: ports.ownerId, images };
    }

    /** @param {import("../ports/qemu-image-disk-target.mjs").QemuDiskArguments} [args] @returns {import("../ports/qemu-image-disk-target.mjs").QemuDiskResult} */
    function materializeDisk(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) return loaded;
        const lab = loaded.lab;
        if (lab.runtimeState === "running") return { ok: false, error: "lab-running", labId: lab.id };
        const sourcePath = lab.image?.sourceImage;
        const format = lab.image?.format || inferQemuImageFormat({}, sourcePath || "");
        const source = ports.validateImageSource(sourcePath, format);
        if (!source.ok) return source;
        const diskPathResult = ports.validateDiskPath(lab);
        if (!diskPathResult.ok) return diskPathResult;
        const diskPath = diskPathResult.diskPath;
        const exists = ports.diskExists(diskPath);
        if (exists && args.force !== true) {
            return { ok: true, ownerId: ports.ownerId, lab: ports.presentLab(lab), materialized: false, reused: true, diskImage: diskPath };
        }
        if (args.dryRun === true) {
            const planned = createOverlay(lab, source, true);
            return planned.ok
                ? { ok: true, ownerId: ports.ownerId, dryRun: true, lab: ports.presentLab(lab), materialized: false, diskImage: diskPath, plan: ports.presentExecution(planned) }
                : planned;
        }
        const created = createOverlay(lab, source, false);
        if (!created.ok) return created;
        const timestamp = ports.now();
        const diskMetadata = {
            kind: "qcow2-overlay",
            path: diskPath,
            backingPath: source.path,
            backingFormat: source.format,
            materializedAt: timestamp,
            forced: args.force === true,
        };
        const next = {
            ...lab,
            updatedAt: timestamp,
            image: { ...lab.image, diskImage: diskPath, disk: diskMetadata },
        };
        ports.writeLab(next);
        return { ok: true, ownerId: ports.ownerId, lab: ports.presentLab(next), materialized: true, diskImage: diskPath, disk: diskMetadata, result: created.result };
    }

    /** @param {QemuLab} lab @param {QemuImageSource} source @param {boolean} dryRun @returns {import("../ports/qemu-image-disk-target.mjs").QemuOverlayResult} */
    function createOverlay(lab, source, dryRun) {
        const disk = ports.validateDiskPath(lab);
        if (!disk.ok) return disk;
        const status = ports.providerStatus();
        const args = qemuOverlayArguments(source, disk.diskPath);
        if (dryRun) return { ok: true, dryRun: true, command: status.qemuImg || "qemu-img", args, providerStatus: status };
        if (!status.available) return { ok: false, error: "lab-provider-unsupported", providerStatus: status };
        if (!status.qemuImg) return { ok: false, error: "qemu-img-unavailable", providerStatus: status };
        ports.ensureDiskParent(disk.diskPath);
        const runner = ports.qemuImageRunner();
        const result = runner(status.qemuImg, args, {
            cwd: lab.paths.labDir,
            env: ports.commandEnvironment(),
            timeoutMs: qemuCommandTimeout(ports.providerCommandTimeoutMs, 120000),
        });
        if (!result?.ok) return { ok: false, error: "qemu-img-create-failed", result: ports.presentExecution(result) };
        return { ok: true, command: status.qemuImg, args, result: ports.presentExecution(result) };
    }

    /** @param {import("../ports/qemu-image-disk-target.mjs").QemuTargetArguments} [args] @returns {import("../ports/qemu-image-disk-target.mjs").QemuTargetResult} */
    function listTargets(args = {}) {
        if (args.labId !== undefined) {
            const loaded = ports.readLab(String(args.labId || ""));
            if (!loaded.ok) return loaded;
            return { ok: true, ownerId: ports.ownerId, targets: [qemuTargetForLab(loaded.lab)] };
        }
        return {
            ok: true,
            ownerId: ports.ownerId,
            targets: ports.ownerLabs().map((lab) => qemuTargetForLab(lab)),
        };
    }

    return { listImages, materializeDisk, listTargets };
}
