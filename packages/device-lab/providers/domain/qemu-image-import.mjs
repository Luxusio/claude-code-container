/** @typedef {{[key: string]: unknown, name?: unknown, imageId?: unknown, force?: unknown, copy?: unknown, sourcePath?: unknown, format?: unknown}} QemuImageImportArguments */
/** @typedef {{[key: string]: unknown, ok: false, error: string}} QemuImageImportFailure */
/** @typedef {{id: string, name: string, ownerId: string, provider: string, format: string, path: string, sourcePath: string, copied: boolean, sizeBytes: number, createdAt: unknown, updatedAt: unknown}} QemuImportedImage */
/** @param {QemuImageImportArguments} args */
export function qemuImageImportIdentity(args) {
    const name = String(args.name || "").trim();
    const imageId = args.imageId ? String(args.imageId) : String(name || "")
        .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "";
    return { name, imageId };
}
/** @param {string} value */
export function validQemuImageImportId(value) {
    return value.length > 0 && value.length <= 128 && value !== "." && value !== ".." && /^[a-zA-Z0-9._-]+$/.test(value);
}
/** @param {QemuImageImportArguments} args */
export function copyQemuImportedImage(args) { return args.copy !== false; }
/** @param {string} imageId @param {string} name @param {string} ownerId @param {string} provider @param {string} format @param {string} imagePath @param {string} sourcePath @param {boolean} copy @param {{size: number}} sourceStat @param {unknown} timestamp @returns {QemuImportedImage} */
export function qemuImportedImage(imageId, name, ownerId, provider, format, imagePath, sourcePath, copy, sourceStat, timestamp) {
    return { id: imageId, name, ownerId, provider, format, path: imagePath, sourcePath, copied: copy, sizeBytes: sourceStat.size, createdAt: timestamp, updatedAt: timestamp };
}
