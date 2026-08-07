import { createHash, randomBytes } from "crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, rmSync } from "fs";
import { promises as fsPromises } from "fs";
import { dirname, join, resolve } from "path";
import { assertDeviceLabPathWithinRoot, readDeviceLabStateFile } from "../../../device-lab-state-file.js";
import { withSharedMutationLockAsync, writeJsonFileAtomically } from "../../../device-lab-shared-state.js";
import { quarantineAndRemoveDirectory } from "../../../device-lab-safe-cleanup.js";
import { HYPER_V_IMAGE_CATALOG, readHyperVWindowsEvaluationReceipt } from "../../hyper-v-images.js";
import {
    assertHyperVOperationDeadline,
    HyperVOperationDeadlineError,
    hyperVOperationDeadlineExpired,
    hyperVRemainingTimeout,
} from "./deadline.js";
import {
    hyperVBoundedErrorCode,
    hyperVBoundedErrorDetail,
    hyperVProviderDiagnosticCode,
} from "./public-response.js";
import {
    hyperVAcquireBaseImageCommand,
    hyperVPrepareBaseImageCommand,
    parseHyperVBaseImageObservation,
    type HyperVProviderCommand,
} from "../../../host-control/hyper-v/index.js";

const HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES = 16 * 1024;
const HYPER_V_IMPORTED_IMAGE_LIMIT_BYTES = 64 * 1024 * 1024 * 1024;
const HYPER_V_AUTOMATIC_SOURCE_ARCHIVE_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;
const HYPER_V_IMAGE_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export type HyperVImageProfile = "windows-11" | "windows-server" | "ubuntu-lts";

export type HyperVImageManifest = {
    version: 3;
    profile: HyperVImageProfile;
    catalogId: string;
    sourceUrl: string | null;
    sourceFormat: "vhdx" | "vhd-tar-gz" | "vhdx-zip" | "qcow2" | "vmdk";
    sourceSha256: string | null;
    licenseId: string | null;
    generation: 1 | 2;
    secureBootTemplate: "MicrosoftWindows" | "MicrosoftUEFICertificateAuthority";
    preparationVersion: 1;
    imagePath: string;
    sha256: string;
    sizeBytes: number;
    virtualSizeBytes: number;
    vhdType: string;
    preparedAt: string;
};

export type HyperVImageResolution =
    | { ok: true; params: Record<string, unknown>; imagePath: string; prepared: boolean }
    | { ok: false; status: number; error: string; detail?: string; remedy?: string };

export type HyperVImageCommandResult = {
    mode: string;
    provider: string;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
};

export interface HyperVImageStoreRuntime {
    cwd: string;
    privateRoot: string;
    resolveExecutable(name: string): string | null;
    run(
        command: HyperVProviderCommand,
        options: { timeoutMs: number; outputLimit: number },
    ): Promise<HyperVImageCommandResult>;
    limits: {
        acquireTimeoutMs: number;
        prepareTimeoutMs: number;
        lockWaitMs: number;
        commandOutputBytes: number;
    };
}

export type HyperVImageCreateRequest = {
    backend: string;
    dryRun: boolean;
    create?: Record<string, unknown>;
};

export function hyperVImageProfile(value: unknown): HyperVImageProfile | null {
    return value === "windows-11" || value === "windows-server" || value === "ubuntu-lts" ? value : null;
}

export function hyperVImageRoot(privateRoot: string): string {
    return join(privateRoot, "images", "hyper-v");
}

export function hyperVImageProfileRoot(privateRoot: string, profile: HyperVImageProfile): string {
    return join(hyperVImageRoot(privateRoot), profile);
}

export function hyperVOwnerImageProfileRoot(privateRoot: string, ownerId: string, profile: HyperVImageProfile): string {
    return join(privateRoot, "owners", ownerId, "images", "hyper-v", profile);
}

export function cleanupIncompleteHyperVImageArtifacts(profileRoot: string): void {
    assertNoSymlinkPathComponents(profileRoot, "hyper-v-base-image-cleanup");
    rmSync(join(profileRoot, "base.partial.vhdx"), { force: true });
    const acquireWork = join(profileRoot, ".acquire-work");
    if (existsSync(acquireWork)) {
        quarantineAndRemoveDirectory(acquireWork, (path) => {
            assertDeviceLabPathWithinRoot(profileRoot, path, "hyper-v-base-image-cleanup");
            assertNoSymlinkPathComponents(path, "hyper-v-base-image-cleanup");
        });
    }
    for (const sourceCache of [join(profileRoot, "source.vmdk"), join(profileRoot, "source.qcow2"), join(profileRoot, "source.vhdx.zip")]) {
        try {
            const archiveMetadata = lstatSync(sourceCache);
            const currentCache = sourceCache.endsWith("source.vmdk");
            const validRetryCache = currentCache
                && archiveMetadata.isFile()
                && !archiveMetadata.isSymbolicLink()
                && archiveMetadata.nlink === 1
                && archiveMetadata.size > 0
                && archiveMetadata.size <= HYPER_V_AUTOMATIC_SOURCE_ARCHIVE_LIMIT_BYTES;
            if (!validRetryCache) {
                if (archiveMetadata.isDirectory() && !archiveMetadata.isSymbolicLink()) {
                    quarantineAndRemoveDirectory(sourceCache, (path) => {
                        assertDeviceLabPathWithinRoot(profileRoot, path, "hyper-v-base-image-cache-cleanup");
                        assertNoSymlinkPathComponents(path, "hyper-v-base-image-cache-cleanup");
                    });
                } else {
                    rmSync(sourceCache, { force: true });
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
    }
    if (!existsSync(join(profileRoot, "manifest.json"))) rmSync(join(profileRoot, "base.vhdx"), { force: true });
}

export function assertNoSymlinkPathComponents(file: string, label: string): void {
    const chain: string[] = [];
    let current = resolve(file);
    while (true) {
        chain.push(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    for (const component of chain.reverse()) {
        try {
            if (lstatSync(component).isSymbolicLink()) throw new Error(`${label}-path-symlink-rejected`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") break;
            throw error;
        }
    }
}

export function inspectLargeRegularFile(root: string, file: string, label: string): { path: string; size: number } {
    const absolute = resolve(file);
    assertNoSymlinkPathComponents(root, label);
    assertNoSymlinkPathComponents(absolute, label);
    assertDeviceLabPathWithinRoot(root, absolute, label);
    const pathStat = lstatSync(absolute);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 || pathStat.size <= 0) throw new Error(`${label}-invalid`);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const descriptor = openSync(absolute, fsConstants.O_RDONLY | noFollow);
    try {
        const descriptorStat = fstatSync(descriptor);
        if (!descriptorStat.isFile() || descriptorStat.nlink !== 1
            || descriptorStat.dev !== pathStat.dev
            || descriptorStat.ino !== pathStat.ino
            || descriptorStat.size !== pathStat.size) {
            throw new Error(`${label}-identity-changed`);
        }
        return { path: absolute, size: descriptorStat.size };
    } finally {
        closeSync(descriptor);
    }
}

export async function stageLargeRegularFileFromProject(
    root: string,
    file: string,
    targetRoot: string,
    label: string,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<string> {
    const absolute = resolve(file);
    if (dirname(absolute) !== resolve(root)) throw new Error(`${label}-must-be-project-root-file`);
    const stagingPath = join(targetRoot, `.source-${randomBytes(12).toString("hex")}.vhdx`);
    let sourceDescriptor: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
    let targetDescriptor: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
    try {
        assertNoSymlinkPathComponents(root, label);
        assertNoSymlinkPathComponents(absolute, label);
        assertDeviceLabPathWithinRoot(root, absolute, label);
        const pathStat = await fsPromises.lstat(absolute);
        if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 || pathStat.size <= 0 || pathStat.size > HYPER_V_IMPORTED_IMAGE_LIMIT_BYTES) {
            throw new Error(`${label}-invalid`);
        }
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        sourceDescriptor = await fsPromises.open(absolute, fsConstants.O_RDONLY | noFollow);
        const openedSource = await sourceDescriptor.stat();
        const currentSource = await fsPromises.lstat(absolute);
        if (!openedSource.isFile() || openedSource.nlink !== 1
            || openedSource.dev !== pathStat.dev || openedSource.ino !== pathStat.ino || openedSource.size !== pathStat.size
            || currentSource.isSymbolicLink() || currentSource.nlink !== 1 || currentSource.dev !== openedSource.dev || currentSource.ino !== openedSource.ino || currentSource.size !== openedSource.size) {
            throw new Error(`${label}-identity-changed`);
        }
        await fsPromises.mkdir(targetRoot, { recursive: true, mode: 0o700 });
        assertNoSymlinkPathComponents(targetRoot, `${label}-staging`);
        assertDeviceLabPathWithinRoot(targetRoot, stagingPath, `${label}-staging`);
        targetDescriptor = await fsPromises.open(stagingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
        const openedTarget = await targetDescriptor.stat();
        const targetPathStat = await fsPromises.lstat(stagingPath);
        if (!openedTarget.isFile() || openedTarget.nlink !== 1
            || targetPathStat.isSymbolicLink() || targetPathStat.dev !== openedTarget.dev || targetPathStat.ino !== openedTarget.ino) {
            throw new Error(`${label}-staging-identity-changed`);
        }
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let copied = 0;
        while (copied < openedSource.size) {
            assertHyperVOperationDeadline(deadlineAt);
            const { bytesRead: count } = await sourceDescriptor.read(buffer, 0, Math.min(buffer.length, openedSource.size - copied), null);
            if (count <= 0) throw new Error(`${label}-copy-short-read`);
            let offset = 0;
            while (offset < count) {
                const { bytesWritten: written } = await targetDescriptor.write(buffer, offset, count - offset, null);
                if (written <= 0) throw new Error(`${label}-copy-short-write`);
                offset += written;
            }
            copied += count;
        }
        await targetDescriptor.sync();
        const finalSource = await sourceDescriptor.stat();
        const finalTarget = await targetDescriptor.stat();
        const finalSourcePath = await fsPromises.lstat(absolute);
        if (finalSource.nlink !== 1 || finalSource.dev !== openedSource.dev || finalSource.ino !== openedSource.ino || finalSource.size !== openedSource.size
            || finalSourcePath.isSymbolicLink() || finalSourcePath.nlink !== 1 || finalSourcePath.dev !== openedSource.dev || finalSourcePath.ino !== openedSource.ino || finalSourcePath.size !== openedSource.size
            || finalTarget.dev !== openedTarget.dev || finalTarget.ino !== openedTarget.ino || finalTarget.size !== openedSource.size) {
            throw new Error(`${label}-identity-changed`);
        }
        return stagingPath;
    } catch (error) {
        if (targetDescriptor !== null) { await targetDescriptor.close(); targetDescriptor = null; }
        if (sourceDescriptor !== null) { await sourceDescriptor.close(); sourceDescriptor = null; }
        try { await fsPromises.unlink(stagingPath); } catch { /* preserve the original failure */ }
        throw error;
    } finally {
        if (targetDescriptor !== null) await targetDescriptor.close();
        if (sourceDescriptor !== null) await sourceDescriptor.close();
    }
}

export async function sha256LargeRegularFile(
    root: string,
    file: string,
    label: string,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<string> {
    const absolute = resolve(file);
    assertNoSymlinkPathComponents(root, label);
    assertNoSymlinkPathComponents(absolute, label);
    assertDeviceLabPathWithinRoot(root, absolute, label);
    const pathStat = await fsPromises.lstat(absolute);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 || pathStat.size <= 0) throw new Error(`${label}-invalid`);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const descriptor = await fsPromises.open(absolute, fsConstants.O_RDONLY | noFollow);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        const openedStat = await descriptor.stat();
        if (!openedStat.isFile() || openedStat.nlink !== 1
            || openedStat.dev !== pathStat.dev
            || openedStat.ino !== pathStat.ino
            || openedStat.size !== pathStat.size) {
            throw new Error(`${label}-identity-changed`);
        }
        while (true) {
            assertHyperVOperationDeadline(deadlineAt);
            const { bytesRead: count } = await descriptor.read(buffer, 0, buffer.length, null);
            if (count === 0) break;
            hash.update(buffer.subarray(0, count));
        }
        const finalStat = await descriptor.stat();
        const finalPathStat = await fsPromises.lstat(absolute);
        if (!finalStat.isFile()
            || !finalPathStat.isFile()
            || finalPathStat.isSymbolicLink()
            || finalStat.nlink !== 1
            || finalPathStat.nlink !== 1
            || finalStat.dev !== openedStat.dev
            || finalStat.ino !== openedStat.ino
            || finalStat.size !== openedStat.size
            || finalPathStat.dev !== openedStat.dev
            || finalPathStat.ino !== openedStat.ino
            || finalPathStat.size !== openedStat.size) {
            throw new Error(`${label}-identity-changed`);
        }
        return hash.digest("hex");
    } finally {
        await descriptor.close();
    }
}

function hyperVImageManifest(
    profile: HyperVImageProfile,
    imagePath: string,
    observation: NonNullable<ReturnType<typeof parseHyperVBaseImageObservation>>,
    automatic: boolean,
): HyperVImageManifest {
    const catalog = profile === "windows-server" || profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG[profile] : null;
    return {
        version: 3,
        profile,
        catalogId: automatic && catalog ? catalog.catalogId : "user-provided-vhdx",
        sourceUrl: automatic && catalog ? catalog.sourceUrl : null,
        sourceFormat: automatic && catalog ? catalog.sourceFormat : "vhdx",
        sourceSha256: automatic && catalog && "sourceSha256" in catalog ? catalog.sourceSha256 : null,
        licenseId: automatic && catalog ? catalog.licenseId : null,
        generation: observation.generation,
        secureBootTemplate: profile === "ubuntu-lts" ? "MicrosoftUEFICertificateAuthority" : "MicrosoftWindows",
        preparationVersion: 1,
        imagePath,
        sha256: observation.sha256,
        sizeBytes: observation.sizeBytes,
        virtualSizeBytes: observation.virtualSizeBytes,
        vhdType: observation.vhdType,
        preparedAt: new Date().toISOString(),
    };
}

export function readHyperVImageManifestMetadata(
    privateRoot: string,
    profile: HyperVImageProfile,
    profileRoot = hyperVImageProfileRoot(privateRoot, profile),
    allowUserProvided = false,
): HyperVImageManifest {
    const expectedImagePath = join(profileRoot, "base.vhdx");
    const manifest = readDeviceLabStateFile(join(profileRoot, "manifest.json"), (parsed) => {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hyper-v-base-image-manifest-invalid");
        const value = parsed as Record<string, unknown>;
        if (value.version !== 3
            || value.profile !== profile
            || typeof value.catalogId !== "string"
            || (value.sourceUrl !== null && typeof value.sourceUrl !== "string")
            || (value.sourceFormat !== "vhdx" && value.sourceFormat !== "vhd-tar-gz" && value.sourceFormat !== "vhdx-zip" && value.sourceFormat !== "qcow2" && value.sourceFormat !== "vmdk")
            || (value.sourceSha256 !== null && (typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sourceSha256)))
            || (value.licenseId !== null && typeof value.licenseId !== "string")
            || (value.generation !== 1 && value.generation !== 2)
            || (value.secureBootTemplate !== "MicrosoftWindows" && value.secureBootTemplate !== "MicrosoftUEFICertificateAuthority")
            || value.preparationVersion !== 1
            || typeof value.imagePath !== "string"
            || resolve(value.imagePath) !== resolve(expectedImagePath)
            || typeof value.sha256 !== "string"
            || !/^[a-f0-9]{64}$/i.test(value.sha256)
            || typeof value.sizeBytes !== "number"
            || !Number.isSafeInteger(value.sizeBytes)
            || value.sizeBytes <= 0
            || typeof value.virtualSizeBytes !== "number"
            || !Number.isSafeInteger(value.virtualSizeBytes)
            || value.virtualSizeBytes < value.sizeBytes
            || typeof value.vhdType !== "string"
            || typeof value.preparedAt !== "string") {
            throw new Error("hyper-v-base-image-manifest-invalid");
        }
        return value as HyperVImageManifest;
    }, "hyper-v-base-image-manifest", HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES);
    if (!manifest) throw new Error("hyper-v-base-image-manifest-missing");
    const catalog = profile === "windows-server" || profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG[profile] : null;
    if (manifest.catalogId !== "user-provided-vhdx") {
        const catalogSourceSha256 = catalog && "sourceSha256" in catalog ? catalog.sourceSha256 : null;
        if (!catalog
            || manifest.catalogId !== catalog.catalogId
            || manifest.sourceUrl !== catalog.sourceUrl
            || manifest.sourceFormat !== catalog.sourceFormat
            || manifest.sourceSha256 !== catalogSourceSha256
            || manifest.licenseId !== catalog.licenseId
            || manifest.generation !== catalog.generation
            || manifest.secureBootTemplate !== catalog.secureBootTemplate) {
            throw new Error("hyper-v-base-image-manifest-provenance-mismatch");
        }
        if ("virtualSizeBytes" in catalog && manifest.virtualSizeBytes !== catalog.virtualSizeBytes) {
            throw new Error("hyper-v-base-image-manifest-provenance-mismatch");
        }
    } else if (!allowUserProvided || manifest.sourceUrl !== null || manifest.sourceSha256 !== null || manifest.licenseId !== null || manifest.sourceFormat !== "vhdx") {
        throw new Error("hyper-v-base-image-manifest-provenance-mismatch");
    }
    const image = inspectLargeRegularFile(profileRoot, expectedImagePath, "hyper-v-base-image");
    if (image.size !== manifest.sizeBytes) throw new Error("hyper-v-base-image-size-mismatch");
    return manifest;
}

async function readHyperVImageManifest(
    privateRoot: string,
    profile: HyperVImageProfile,
    profileRoot = hyperVImageProfileRoot(privateRoot, profile),
    allowUserProvided = false,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HyperVImageManifest> {
    const manifest = readHyperVImageManifestMetadata(privateRoot, profile, profileRoot, allowUserProvided);
    if (await sha256LargeRegularFile(profileRoot, manifest.imagePath, "hyper-v-base-image", deadlineAt) !== manifest.sha256) {
        throw new Error("hyper-v-base-image-hash-mismatch");
    }
    return manifest;
}

function commandSucceeded(result: HyperVImageCommandResult): boolean {
    return result.status === 0 && !result.error;
}

function resolvePowerShell(runtime: HyperVImageStoreRuntime): string | null {
    return runtime.resolveExecutable("powershell.exe")
        || runtime.resolveExecutable("pwsh")
        || runtime.resolveExecutable("powershell");
}

export async function resolveHyperVImageForCreate(
    ownerId: string,
    request: HyperVImageCreateRequest,
    params: unknown,
    runtime: HyperVImageStoreRuntime,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HyperVImageResolution> {
    const input = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const create = request.create || {};
    const profile = hyperVImageProfile(create.profile || (request.backend === "linux-vm" ? "ubuntu-lts" : "windows-server"));
    if (!profile) {
        return { ok: false, status: 400, error: "hyper-v-image-profile-invalid", detail: "profile must be windows-11, windows-server, or ubuntu-lts" };
    }
    const globalProfileRoot = hyperVImageProfileRoot(runtime.privateRoot, profile);
    const ownerProfileRoot = hyperVOwnerImageProfileRoot(runtime.privateRoot, ownerId, profile);
    if (typeof create.image === "string" && create.image) {
        try {
            const requestedImage = resolve(create.image);
            const ownerImage = resolve(join(ownerProfileRoot, "base.vhdx"));
            const globalImage = resolve(join(globalProfileRoot, "base.vhdx"));
            const manifest = requestedImage === ownerImage
                ? await readHyperVImageManifest(runtime.privateRoot, profile, ownerProfileRoot, true, deadlineAt)
                : requestedImage === globalImage
                    ? await readHyperVImageManifest(runtime.privateRoot, profile, globalProfileRoot, false, deadlineAt)
                    : (() => { throw new Error("hyper-v-base-image-manifest-path-mismatch"); })();
            if (resolve(create.image) !== resolve(manifest.imagePath)) throw new Error("hyper-v-base-image-manifest-path-mismatch");
            return { ok: true, params: { ...input, profile, image: manifest.imagePath, baseImageSha256: manifest.sha256, baseImageGeneration: manifest.generation, diskMaxBytes: manifest.virtualSizeBytes }, imagePath: manifest.imagePath, prepared: false };
        } catch (error) {
            if (error instanceof HyperVOperationDeadlineError) throw error;
            return {
                ok: false,
                status: 409,
                error: "hyper-v-base-image-not-prepared",
                detail: hyperVBoundedErrorCode(error, "hyper-v-base-image-not-prepared"),
                remedy: "import the generalized VHDX with --source-image",
            };
        }
    }

    const sourceImage = typeof create.sourceImage === "string" && create.sourceImage ? resolve(runtime.cwd, create.sourceImage) : null;
    if (request.dryRun) {
        if (sourceImage) {
            return {
                ok: false,
                status: 409,
                error: "hyper-v-base-image-not-prepared",
                remedy: "run device_create without --dry-run once to import and validate the source image",
            };
        }
        try {
            let manifest: HyperVImageManifest;
            try {
                manifest = await readHyperVImageManifest(runtime.privateRoot, profile, ownerProfileRoot, true, deadlineAt);
            } catch {
                manifest = await readHyperVImageManifest(runtime.privateRoot, profile, globalProfileRoot, false, deadlineAt);
            }
            return {
                ok: true,
                params: { ...input, profile, image: manifest.imagePath, baseImageSha256: manifest.sha256, baseImageGeneration: manifest.generation, diskMaxBytes: manifest.virtualSizeBytes },
                imagePath: manifest.imagePath,
                prepared: false,
            };
        } catch (error) {
            return {
                ok: false,
                status: 409,
                error: "hyper-v-base-image-not-prepared",
                detail: hyperVBoundedErrorCode(error, "hyper-v-base-image-not-prepared"),
                remedy: "run device_create without --dry-run once to acquire and validate the base image",
            };
        }
    }

    const preparationRoot = sourceImage ? ownerProfileRoot : globalProfileRoot;
    try {
        mkdirSync(preparationRoot, { recursive: true, mode: 0o700 });
        assertNoSymlinkPathComponents(preparationRoot, "hyper-v-base-image-preparation");
        const preparationMetadata = lstatSync(preparationRoot);
        if (!preparationMetadata.isDirectory() || preparationMetadata.isSymbolicLink()) throw new Error("hyper-v-base-image-preparation-root-invalid");
        return await withSharedMutationLockAsync(join(preparationRoot, "prepare.lock"), async () => {
            assertHyperVOperationDeadline(deadlineAt);
            if (!sourceImage) {
                let cachedManifest: HyperVImageManifest | null = null;
                try {
                    cachedManifest = await readHyperVImageManifest(runtime.privateRoot, profile, ownerProfileRoot, true, deadlineAt);
                } catch (cacheError) {
                    if (cacheError instanceof HyperVOperationDeadlineError) throw cacheError;
                    try {
                        cachedManifest = await readHyperVImageManifest(runtime.privateRoot, profile, globalProfileRoot, false, deadlineAt);
                    } catch (globalCacheError) {
                        if (globalCacheError instanceof HyperVOperationDeadlineError) throw globalCacheError;
                        if (profile === "windows-11") {
                            throw new Error(`hyper-v-base-image-profile-not-automatic:${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
                        }
                        assertNoSymlinkPathComponents(globalProfileRoot, "hyper-v-base-image-cleanup");
                        rmSync(join(globalProfileRoot, "base.vhdx"), { force: true });
                        rmSync(join(globalProfileRoot, "manifest.json"), { force: true });
                    }
                }
                if (cachedManifest) {
                    if (cachedManifest.licenseId && !readHyperVWindowsEvaluationReceipt(join(runtime.privateRoot, "setup"))) {
                        throw new Error("hyper-v-windows-evaluation-license-not-accepted");
                    }
                    return {
                        ok: true as const,
                        params: { ...input, profile, image: cachedManifest.imagePath, baseImageSha256: cachedManifest.sha256, baseImageGeneration: cachedManifest.generation, diskMaxBytes: cachedManifest.virtualSizeBytes },
                        imagePath: cachedManifest.imagePath,
                        prepared: false,
                    };
                }
                if (profile === "windows-server" && !readHyperVWindowsEvaluationReceipt(join(runtime.privateRoot, "setup"))) {
                    throw new Error("hyper-v-windows-evaluation-license-not-accepted");
                }
                const automaticProfile = profile === "windows-server" || profile === "ubuntu-lts" ? profile : null;
                if (!automaticProfile) throw new Error("hyper-v-base-image-profile-not-automatic");
                const powershell = resolvePowerShell(runtime);
                if (!powershell) throw new Error("missing-provider-command:powershell");
                const imagePath = join(globalProfileRoot, "base.vhdx");
                const execution = await runtime.run(hyperVAcquireBaseImageCommand({
                    executable: powershell,
                    profile: automaticProfile,
                    imageRoot: hyperVImageRoot(runtime.privateRoot),
                    expectedGeneration: HYPER_V_IMAGE_CATALOG[automaticProfile].generation,
                }), {
                    timeoutMs: hyperVRemainingTimeout(deadlineAt, runtime.limits.acquireTimeoutMs),
                    outputLimit: runtime.limits.commandOutputBytes,
                });
                if (hyperVOperationDeadlineExpired(deadlineAt)) {
                    cleanupIncompleteHyperVImageArtifacts(globalProfileRoot);
                    throw new HyperVOperationDeadlineError();
                }
                if (!commandSucceeded(execution)) {
                    cleanupIncompleteHyperVImageArtifacts(globalProfileRoot);
                    throw new Error(`hyper-v-base-image-acquire-failed:${hyperVProviderDiagnosticCode(execution, "hyper-v-powershell-execution-failed")}`);
                }
                try {
                    const observation = parseHyperVBaseImageObservation(execution.stdout || "");
                    if (!observation
                        || observation.profile !== profile
                        || observation.generation !== HYPER_V_IMAGE_CATALOG[automaticProfile].generation
                        || resolve(observation.imagePath) !== resolve(imagePath)) {
                        throw new Error("hyper-v-base-image-acquire-invalid-result");
                    }
                    const image = inspectLargeRegularFile(globalProfileRoot, imagePath, "hyper-v-base-image");
                    if (image.size !== observation.sizeBytes) throw new Error("hyper-v-base-image-size-mismatch");
                    if (await sha256LargeRegularFile(globalProfileRoot, imagePath, "hyper-v-base-image", deadlineAt) !== observation.sha256) {
                        throw new Error("hyper-v-base-image-hash-mismatch");
                    }
                    const manifest = hyperVImageManifest(profile, imagePath, observation, true);
                    writeJsonFileAtomically(join(globalProfileRoot, "manifest.json"), manifest);
                    cleanupIncompleteHyperVImageArtifacts(globalProfileRoot);
                    return {
                        ok: true as const,
                        params: { ...input, profile, image: imagePath, baseImageSha256: observation.sha256, baseImageGeneration: observation.generation, diskMaxBytes: observation.virtualSizeBytes },
                        imagePath,
                        prepared: !observation.reused,
                    };
                } catch (error) {
                    cleanupIncompleteHyperVImageArtifacts(globalProfileRoot);
                    throw error;
                }
            }

            if (!/\.vhdx$/i.test(sourceImage)) throw new Error("hyper-v-base-image-format-unsupported");
            const powershell = resolvePowerShell(runtime);
            if (!powershell) throw new Error("missing-provider-command:powershell");
            const imagePath = join(ownerProfileRoot, "base.vhdx");
            const stagedSource = await stageLargeRegularFileFromProject(resolve(runtime.cwd), sourceImage, ownerProfileRoot, "hyper-v-base-image-source", deadlineAt);
            let execution: HyperVImageCommandResult;
            try {
                execution = await runtime.run(hyperVPrepareBaseImageCommand({
                    executable: powershell,
                    profile,
                    sourceImagePath: stagedSource,
                    sourceRoot: ownerProfileRoot,
                    imagePath,
                    imageRoot: dirname(ownerProfileRoot),
                }), {
                    timeoutMs: hyperVRemainingTimeout(deadlineAt, runtime.limits.prepareTimeoutMs),
                    outputLimit: runtime.limits.commandOutputBytes,
                });
                if (hyperVOperationDeadlineExpired(deadlineAt)) {
                    cleanupIncompleteHyperVImageArtifacts(ownerProfileRoot);
                    throw new HyperVOperationDeadlineError();
                }
            } finally {
                rmSync(stagedSource, { force: true });
            }
            if (!commandSucceeded(execution)) {
                cleanupIncompleteHyperVImageArtifacts(ownerProfileRoot);
                throw new Error(`hyper-v-base-image-prepare-failed:${hyperVProviderDiagnosticCode(execution, "hyper-v-powershell-execution-failed")}`);
            }
            try {
                const observation = parseHyperVBaseImageObservation(execution.stdout || "");
                if (!observation
                    || observation.profile !== profile
                    || resolve(observation.imagePath) !== resolve(imagePath)) {
                    throw new Error("hyper-v-base-image-prepare-invalid-result");
                }
                const image = inspectLargeRegularFile(ownerProfileRoot, imagePath, "hyper-v-base-image");
                if (image.size !== observation.sizeBytes) throw new Error("hyper-v-base-image-size-mismatch");
                if (await sha256LargeRegularFile(ownerProfileRoot, imagePath, "hyper-v-base-image", deadlineAt) !== observation.sha256) {
                    throw new Error("hyper-v-base-image-hash-mismatch");
                }
                const manifest = hyperVImageManifest(profile, imagePath, observation, false);
                writeJsonFileAtomically(join(ownerProfileRoot, "manifest.json"), manifest);
                return {
                    ok: true as const,
                    params: { ...input, profile, image: imagePath, baseImageSha256: observation.sha256, baseImageGeneration: observation.generation, diskMaxBytes: observation.virtualSizeBytes },
                    imagePath,
                    prepared: !observation.reused,
                };
            } catch (error) {
                cleanupIncompleteHyperVImageArtifacts(ownerProfileRoot);
                throw error;
            }
        }, {
            waitMs: hyperVRemainingTimeout(deadlineAt, runtime.limits.lockWaitMs),
            staleMs: HYPER_V_IMAGE_LOCK_STALE_MS,
        });
    } catch (error) {
        if (error instanceof HyperVOperationDeadlineError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        const publicDetail = hyperVBoundedErrorDetail(error, "hyper-v-base-image-prepare-failed");
        const licenseMissing = detail.includes("hyper-v-windows-evaluation-license-not-accepted");
        const automaticUnsupported = detail.includes("hyper-v-base-image-profile-not-automatic");
        const notPrepared = !sourceImage && (detail.includes("ENOENT") || detail.includes("not found") || detail.includes("manifest-missing") || automaticUnsupported);
        const profileConflict = detail.includes("hyper-v-base-image-profile-conflict");
        return {
            ok: false,
            status: licenseMissing || notPrepared || profileConflict ? 409 : 422,
            error: licenseMissing
                ? "hyper-v-windows-evaluation-license-not-accepted"
                : notPrepared
                    ? "hyper-v-base-image-not-prepared"
                    : profileConflict
                        ? "hyper-v-base-image-profile-conflict"
                        : "hyper-v-base-image-prepare-failed",
            detail: publicDetail,
            remedy: licenseMissing
                ? "review the Microsoft Windows Server evaluation terms, then run ccc devices setup hyper-v --confirm --accept-windows-evaluation-license"
                : notPrepared
                    ? "provide --source-image with a generalized Windows 11 VHDX, or use the automatic windows-server profile"
                    : undefined,
        };
    }
}
