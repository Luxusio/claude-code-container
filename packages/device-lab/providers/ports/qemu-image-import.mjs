/** @typedef {import('../domain/qemu-image-import.mjs').QemuImageImportArguments} QemuImageImportArguments */
/** @typedef {import('../domain/qemu-image-import.mjs').QemuImageImportFailure} QemuImageImportFailure */
/** @typedef {import('../domain/qemu-image-import.mjs').QemuImportedImage} QemuImportedImage */
/** @typedef {{ok: true, path: string, stat: {size: number}, format: string}} QemuImageImportSource */
/** @typedef {{ok: true, ownerId: string, image: QemuImportedImage} | QemuImageImportFailure} QemuImageImportResult */
/** Required synchronous guarded native leaves; no workflow callback.
 * @typedef {object} QemuImageImportPorts
 * @property {string} ownerId
 * @property {string} providerName
 * @property {() => QemuImageImportFailure | null} runnerUnavailable
 * @property {(imageId: string) => boolean} metadataExists
 * @property {(sourcePath: unknown, args: QemuImageImportArguments, label: string) => QemuImageImportSource | QemuImageImportFailure} validateSource
 * @property {(imageId: string) => string} imageDirectory
 * @property {(directory: string, format: string) => string} copyDestination
 * @property {(directory: string) => undefined} ensureImageDirectory
 * @property {(source: string, destination: string) => undefined} copyImage
 * @property {() => unknown} timestamp
 * @property {(image: QemuImportedImage) => undefined} publishImage
 */
export {};
