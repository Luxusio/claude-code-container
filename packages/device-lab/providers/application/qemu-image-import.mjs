import { copyQemuImportedImage, qemuImageImportIdentity, qemuImportedImage, validQemuImageImportId } from "../domain/qemu-image-import.mjs";
/** @param {import('../ports/qemu-image-import.mjs').QemuImageImportPorts} ports */
export function createQemuImageImportApplication(ports) {
    /** @param {import('../ports/qemu-image-import.mjs').QemuImageImportArguments} [args] @returns {import('../ports/qemu-image-import.mjs').QemuImageImportResult} */
    function importImage(args = {}) {
        const unavailable = ports.runnerUnavailable();
        if (unavailable) return unavailable;
        const { name, imageId } = qemuImageImportIdentity(args);
        if (!name) return { ok: false, error: "missing-image-name" };
        if (!validQemuImageImportId(imageId)) return { ok: false, error: "invalid-image-id" };
        if (ports.metadataExists(imageId) && args.force !== true) return { ok: false, error: "base-image-already-exists", imageId };
        const source = ports.validateSource(args.sourcePath, args, "source-image");
        if (!source.ok) return source;
        const sourceStat = source.stat;
        const format = source.format;
        const copy = copyQemuImportedImage(args);
        const imageDir = ports.imageDirectory(imageId);
        const imagePath = copy ? ports.copyDestination(imageDir, format) : source.path;
        if (copy) {
            ports.ensureImageDirectory(imageDir);
            ports.copyImage(source.path, imagePath);
        }
        const timestamp = ports.timestamp();
        const image = qemuImportedImage(imageId, name, ports.ownerId, ports.providerName, format, imagePath, source.path, copy, sourceStat, timestamp);
        ports.publishImage(image);
        return { ok: true, ownerId: ports.ownerId, image };
    }
    return { importImage };
}
