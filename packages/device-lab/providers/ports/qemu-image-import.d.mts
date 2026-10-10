export interface QemuImageImportArguments { [key: string]: unknown; name?: unknown; imageId?: unknown; force?: unknown; copy?: unknown; sourcePath?: unknown; format?: unknown; }
export interface QemuImageImportFailure { [key: string]: unknown; ok: false; error: string; }
export interface QemuImportedImage { id: string; name: string; ownerId: string; provider: string; format: string; path: string; sourcePath: string; copied: boolean; sizeBytes: number; createdAt: unknown; updatedAt: unknown; }
export interface QemuImageImportSource { ok: true; path: string; stat: { size: number }; format: string; }
export type QemuImageImportResult = { ok: true; ownerId: string; image: QemuImportedImage } | QemuImageImportFailure;
export interface QemuImageImportPorts {
    ownerId: string;
    providerName: string;
    runnerUnavailable(): QemuImageImportFailure | null;
    metadataExists(imageId: string): boolean;
    validateSource(sourcePath: unknown, args: QemuImageImportArguments, label: string): QemuImageImportSource | QemuImageImportFailure;
    imageDirectory(imageId: string): string;
    copyDestination(directory: string, format: string): string;
    ensureImageDirectory(directory: string): undefined;
    copyImage(source: string, destination: string): undefined;
    timestamp(): unknown;
    publishImage(image: QemuImportedImage): undefined;
}
