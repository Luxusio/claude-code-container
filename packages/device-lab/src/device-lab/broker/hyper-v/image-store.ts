import { readDeviceLabFileIdentity, readDeviceLabFileIdentityAsync } from '../../../device-lab-file-identity.js';
import { createHash, randomBytes } from "crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "fs";
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
    hyperVAcquireBaseImagePrepareCommand,
    hyperVAcquireBaseImageFinalizeCommand,
    hyperVImportedImageStorageCommand,
    parseHyperVAcquireBaseImagePrepareObservation,
    parseHyperVBaseImageObservation,
    parseHyperVImportedImageStorage,
    type HyperVProviderCommand,
} from "../../../host-control/hyper-v/index.js";
import { createDeviceLabHyperVWindowsClient } from "./lifecycle-adapter.js";
import { createHyperVImagePreparation } from "../../application/hyper-v-image-preparation.js";
import type { HyperVImageProfile, HyperVImageManifest, HyperVImageResolution as HyperVImageResolutionOutcome, HyperVImageCreateRequest } from "../../domain/hyper-v-image-preparation.js";
import type { HyperVImagePreparationPorts } from "../../ports/hyper-v-image-preparation.js";
export { hyperVImageProfile } from "../../domain/hyper-v-image-preparation.js";
export type { HyperVImageProfile, HyperVImageManifest, HyperVImageCreateRequest } from "../../domain/hyper-v-image-preparation.js";

export type HyperVImageCommandResult = {mode: string; provider: string; status?: number | null; stdout?: string; stderr?: string; error?: string};
export type HyperVImageResolution =
    | {ok: true; params: Record<string, unknown>; imagePath: string; prepared: boolean}
    | {ok: false; status: number; error: string; detail?: string; remedy?: string};
function imageNativeObservation<T>(execution: HyperVImageCommandResult, observe: () => T | null): import("../../domain/hyper-v-image-preparation.js").HyperVImageNativeObservation<T> {
    return execution.status === 0 && !execution.error
        ? {kind: "completed", observation: observe(), receipt: execution}
        : {kind: "failed", diagnostic: hyperVProviderDiagnosticCode(execution, "hyper-v-powershell-execution-failed"), receipt: execution};
}
export function hyperVImageResolutionToWire(outcome: Extract<HyperVImageResolutionOutcome, {kind: "refused"}>): Extract<HyperVImageResolution, {ok: false}>;
export function hyperVImageResolutionToWire(outcome: Extract<HyperVImageResolutionOutcome, {kind: "resolved"}>): Extract<HyperVImageResolution, {ok: true}>;
export function hyperVImageResolutionToWire(outcome: HyperVImageResolutionOutcome): HyperVImageResolution;
export function hyperVImageResolutionToWire(outcome: HyperVImageResolutionOutcome): HyperVImageResolution {
    if (outcome.kind === "resolved") {
        const {kind: _kind, ...facts} = outcome;
        return {ok: true, ...facts};
    }
    const {kind: _kind, reason, ...failure} = outcome;
    return {ok: false, status: reason === "invalid-profile" ? 400 : reason === "preparation-failed" ? 422 : 409, ...failure};
}

const HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES = 16 * 1024;
const HYPER_V_IMPORTED_IMAGE_LIMIT_BYTES = 64 * 1024 * 1024 * 1024;
const HYPER_V_AUTOMATIC_SOURCE_CACHE_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;
const HYPER_V_PRIOR_UBUNTU_CATALOG_ID = "canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-native-vhdx-20260725-v1";
const HYPER_V_IMAGE_OWNER_ID_PATTERN = /^[a-f0-9]{16}$/;

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

export type HyperVUbuntuImageCacheConflictCode =
    | "hyper-v-base-image-profile-conflict"
    | "hyper-v-base-image-unmanaged-existing"
    | "hyper-v-base-image-artifact-owner-unknown";

export type HyperVUbuntuImageCacheInspection =
    | { state: "valid"; source: "owner" | "global"; code?: undefined }
    | { state: "acquisition-required"; source?: undefined; code?: undefined }
    | { state: "conflict"; source?: undefined; code: HyperVUbuntuImageCacheConflictCode };

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
    for (const sourceCache of [join(profileRoot, "source.vmdk"), join(profileRoot, "source.vhdx.zip"), join(profileRoot, "source.vhd.tar.gz"), join(profileRoot, "source.qcow2")]) {
        try {
            const archiveMetadata = lstatSync(sourceCache);
            const currentCache = sourceCache.endsWith("source.qcow2");
            const validRetryCache = currentCache
                && archiveMetadata.isFile()
                && !archiveMetadata.isSymbolicLink()
                && archiveMetadata.nlink === 1
                && archiveMetadata.size > 0
                && archiveMetadata.size <= HYPER_V_AUTOMATIC_SOURCE_CACHE_LIMIT_BYTES;
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
}

type AutomaticArtifactIdentity = { dev: bigint; ino: bigint; directory: boolean };

function automaticArtifactIdentity(path: string): AutomaticArtifactIdentity | null {
    try {
        const named = lstatSync(path, { bigint: true });
        if (named.isSymbolicLink()) throw new Error("hyper-v-base-image-artifact-symlink");
        const stat = readDeviceLabFileIdentity(path, "hyper-v-base-image-artifact");
        return { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
    }
}

function assertAutomaticFileIdentity(path: string, expected: AutomaticArtifactIdentity, label: string): void {
    const current = automaticArtifactIdentity(path);
    if (!current || current.directory || current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error(`${label}-identity-changed`);
    }
}

function cleanupOwnedAutomaticArtifacts(profileRoot: string, owned: Map<string, AutomaticArtifactIdentity>): void {
    for (const path of [join(profileRoot, "base.partial.vhdx"), join(profileRoot, ".acquire-work")]) {
        const expected = owned.get(path);
        if (!expected) continue;
        const current = automaticArtifactIdentity(path);
        if (!current || current.dev !== expected.dev || current.ino !== expected.ino || current.directory !== expected.directory) continue;
        if (current.directory) {
            quarantineAndRemoveDirectory(path, (candidate) => {
                assertDeviceLabPathWithinRoot(profileRoot, candidate, "hyper-v-base-image-cleanup");
                assertNoSymlinkPathComponents(candidate, "hyper-v-base-image-cleanup");
            });
        } else {
            rmSync(path);
        }
    }
}

function quarantineUncertainAutomaticArtifact(profileRoot: string, path: string, label: string): boolean {
    const identity = automaticArtifactIdentity(path);
    if (!identity) return false;
    assertNoSymlinkPathComponents(path, label);
    assertDeviceLabPathWithinRoot(profileRoot, path, label);
    const quarantine = join(profileRoot, `.${label}-${randomBytes(12).toString("hex")}.retained`);
    renameSync(path, quarantine);
    const moved = automaticArtifactIdentity(quarantine);
    if (!moved || moved.dev !== identity.dev || moved.ino !== identity.ino || moved.directory !== identity.directory) {
        if (!existsSync(path)) renameSync(quarantine, path);
        throw new Error("hyper-v-base-image-artifact-identity-changed");
    }
    return true;
}

// The exact manifest of the immediately previous automatic ubuntu-lts catalog, or null. Throws when
// the file cannot be read; callers treat that as not the prior catalog.
function readKnownPriorAutomaticManifest(profileRoot: string, manifestPath: string): { sha256: string; sizeBytes: number } | null {
    const raw = readDeviceLabStateFile(manifestPath, (value) => value, "hyper-v-base-image-prior-manifest", HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const prior = raw as Record<string, unknown>;
    const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
    if (prior.version !== 3 || prior.profile !== "ubuntu-lts"
        || prior.catalogId !== HYPER_V_PRIOR_UBUNTU_CATALOG_ID
        || prior.sourceUrl !== catalog.sourceUrl || prior.sourceSha256 !== catalog.sourceSha256
        || prior.sourceFormat !== catalog.sourceFormat || prior.generation !== catalog.generation
        || prior.licenseId !== catalog.licenseId || prior.secureBootTemplate !== catalog.secureBootTemplate
        || prior.preparationVersion !== 1 || prior.imagePath !== join(profileRoot, "base.vhdx")
        || typeof prior.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(prior.sha256)
        || typeof prior.sizeBytes !== "number" || !Number.isSafeInteger(prior.sizeBytes) || prior.sizeBytes <= 0
        || prior.virtualSizeBytes !== catalog.virtualSizeBytes || prior.vhdType !== "Dynamic"
        || typeof prior.preparedAt !== "string" || !Number.isFinite(Date.parse(prior.preparedAt))) return null;
    return { sha256: prior.sha256, sizeBytes: prior.sizeBytes };
}

async function isKnownPriorAutomaticImage(
    profile: "windows-server" | "ubuntu-lts",
    profileRoot: string,
    deadlineAt: number,
    manifestPath = join(profileRoot, "manifest.json"),
    imageFile = join(profileRoot, "base.vhdx"),
): Promise<{ manifestBytes: Buffer; imageSha256: string; imageSize: number } | null> {
    if (profile !== "ubuntu-lts") return null;
    try {
        const prior = readKnownPriorAutomaticManifest(profileRoot, manifestPath);
        if (!prior) return null;
        const image = inspectLargeRegularFile(profileRoot, imageFile, "hyper-v-base-image-prior");
        if (image.size !== prior.sizeBytes
            || await sha256LargeRegularFile(profileRoot, imageFile, "hyper-v-base-image-prior", deadlineAt) !== prior.sha256) return null;
        return { manifestBytes: readFileSync(manifestPath), imageSha256: prior.sha256, imageSize: image.size };
    } catch (error) {
        if (error instanceof HyperVOperationDeadlineError) throw error;
        return null;
    }
}

function priorRecoveryPaths(profileRoot: string): { manifest: string; image: string } {
    return {
        manifest: join(profileRoot, ".manifest-prior-recovery.json"),
        image: join(profileRoot, ".base-prior-recovery.vhdx"),
    };
}

async function recoverPriorAutomaticImage(profileRoot: string, deadlineAt: number): Promise<void> {
    const backup = priorRecoveryPaths(profileRoot);
    if (!existsSync(backup.manifest) && !existsSync(backup.image)) return;
    const manifestPath = join(profileRoot, "manifest.json");
    const imagePath = join(profileRoot, "base.vhdx");
    // A completed new pair can use the normal cache path. Keep the old pair until
    // a guarded maintenance pass can validate it again.
    if (existsSync(manifestPath) && existsSync(imagePath)) return;
    const manifestFile = existsSync(backup.manifest) ? backup.manifest : manifestPath;
    const imageFile = existsSync(backup.image) ? backup.image : imagePath;
    const prior = await isKnownPriorAutomaticImage("ubuntu-lts", profileRoot, deadlineAt, manifestFile, imageFile);
    if (!prior || (manifestFile !== backup.manifest && existsSync(backup.manifest))
        || (imageFile !== backup.image && existsSync(backup.image))
        || (manifestFile === backup.manifest && existsSync(manifestPath))
        || (imageFile === backup.image && existsSync(imagePath) && existsSync(manifestPath))) {
        throw new Error("hyper-v-base-image-profile-conflict");
    }
    if (imageFile === backup.image && existsSync(imagePath)) {
        quarantineUncertainAutomaticArtifact(profileRoot, imagePath, "base-uncertain");
    }
    if (imageFile === backup.image) renameSync(backup.image, imagePath);
    if (manifestFile === backup.manifest) renameSync(backup.manifest, manifestPath);
}

async function retireKnownPriorAutomaticImage(profileRoot: string, prior: {
    manifestBytes: Buffer; imageSha256: string; imageSize: number;
}, deadlineAt: number): Promise<{ manifest: AutomaticArtifactIdentity; image: AutomaticArtifactIdentity }> {
    const manifestPath = join(profileRoot, "manifest.json");
    const imagePath = join(profileRoot, "base.vhdx");
    const { manifest: retiredManifest, image: retiredImage } = priorRecoveryPaths(profileRoot);
    if (existsSync(retiredManifest) || existsSync(retiredImage)) throw new Error("hyper-v-base-image-profile-conflict");
    let manifestMoved = false;
    let imageMoved = false;
    try {
        renameSync(manifestPath, retiredManifest);
        manifestMoved = true;
        if (!readFileSync(retiredManifest).equals(prior.manifestBytes)) throw new Error("hyper-v-base-image-prior-changed");
        renameSync(imagePath, retiredImage);
        imageMoved = true;
        const retired = inspectLargeRegularFile(profileRoot, retiredImage, "hyper-v-base-image-prior");
        if (retired.size !== prior.imageSize
            || await sha256LargeRegularFile(profileRoot, retiredImage, "hyper-v-base-image-prior", deadlineAt) !== prior.imageSha256) {
            throw new Error("hyper-v-base-image-prior-changed");
        }
        // Keep the validated pair recoverable until the replacement manifest commits.
        const manifestIdentity = automaticArtifactIdentity(retiredManifest);
        const imageIdentity = automaticArtifactIdentity(retiredImage);
        if (!manifestIdentity || !imageIdentity) throw new Error("hyper-v-base-image-prior-changed");
        return { manifest: manifestIdentity, image: imageIdentity };
    } catch (error) {
        if (imageMoved && !existsSync(imagePath)) renameSync(retiredImage, imagePath);
        if (manifestMoved && !existsSync(manifestPath)) renameSync(retiredManifest, manifestPath);
        throw error;
    }
}

async function discardRetiredPriorAutomaticImage(
    profileRoot: string,
    prior: { manifestBytes: Buffer; imageSha256: string; imageSize: number },
    identities: { manifest: AutomaticArtifactIdentity; image: AutomaticArtifactIdentity },
    deadlineAt: number,
): Promise<void> {
    const backup = priorRecoveryPaths(profileRoot);
    const checked = await isKnownPriorAutomaticImage("ubuntu-lts", profileRoot, deadlineAt, backup.manifest, backup.image);
    if (!checked || !checked.manifestBytes.equals(prior.manifestBytes)
        || checked.imageSha256 !== prior.imageSha256 || checked.imageSize !== prior.imageSize) return;
    const manifestIdentity = automaticArtifactIdentity(backup.manifest);
    const imageIdentity = automaticArtifactIdentity(backup.image);
    if (!manifestIdentity || !imageIdentity
        || manifestIdentity.dev !== identities.manifest.dev || manifestIdentity.ino !== identities.manifest.ino
        || imageIdentity.dev !== identities.image.dev || imageIdentity.ino !== identities.image.ino) return;
    rmSync(backup.image);
    rmSync(backup.manifest);
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
    let pathStat = lstatSync(absolute, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n || pathStat.size <= 0n) throw new Error(`${label}-invalid`);
    pathStat = readDeviceLabFileIdentity(absolute, label, pathStat);
    if (pathStat.size <= 0n) throw new Error(`${label}-invalid`);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const descriptor = openSync(absolute, fsConstants.O_RDONLY | noFollow | (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0));
    try {
        const descriptorStat = fstatSync(descriptor, { bigint: true });
        if (!descriptorStat.isFile() || descriptorStat.nlink !== 1n
            || descriptorStat.dev !== pathStat.dev
            || descriptorStat.ino !== pathStat.ino
            || descriptorStat.size !== pathStat.size) {
            throw new Error(`${label}-identity-changed`);
        }
        return { path: absolute, size: Number(descriptorStat.size) };
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
        let pathStat = await fsPromises.lstat(absolute, { bigint: true });
        if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n || pathStat.size <= 0n || pathStat.size > BigInt(HYPER_V_IMPORTED_IMAGE_LIMIT_BYTES)) {
            throw new Error(`${label}-invalid`);
        }
        pathStat = await readDeviceLabFileIdentityAsync(absolute, label, pathStat);
        if (pathStat.size <= 0n || pathStat.size > BigInt(HYPER_V_IMPORTED_IMAGE_LIMIT_BYTES)) throw new Error(`${label}-invalid`);
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        sourceDescriptor = await fsPromises.open(absolute, fsConstants.O_RDONLY | noFollow | (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0));
        const openedSource = await sourceDescriptor.stat({ bigint: true });
        const currentSource = await readDeviceLabFileIdentityAsync(absolute, label);
        if (!openedSource.isFile() || openedSource.nlink !== 1n
            || openedSource.dev !== pathStat.dev || openedSource.ino !== pathStat.ino || openedSource.size !== pathStat.size
            || currentSource.isSymbolicLink() || currentSource.nlink !== 1n || currentSource.dev !== openedSource.dev || currentSource.ino !== openedSource.ino || currentSource.size !== openedSource.size) {
            throw new Error(`${label}-identity-changed`);
        }
        await fsPromises.mkdir(targetRoot, { recursive: true, mode: 0o700 });
        assertNoSymlinkPathComponents(targetRoot, `${label}-staging`);
        assertDeviceLabPathWithinRoot(targetRoot, stagingPath, `${label}-staging`);
        targetDescriptor = await fsPromises.open(stagingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
        const openedTarget = await targetDescriptor.stat({ bigint: true });
        const targetPathStat = await readDeviceLabFileIdentityAsync(stagingPath, `${label}-staging`, openedTarget);
        if (!openedTarget.isFile() || openedTarget.nlink !== 1n
            || targetPathStat.isSymbolicLink() || targetPathStat.dev !== openedTarget.dev || targetPathStat.ino !== openedTarget.ino) {
            throw new Error(`${label}-staging-identity-changed`);
        }
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let copied = 0;
        while (copied < Number(openedSource.size)) {
            assertHyperVOperationDeadline(deadlineAt);
            const { bytesRead: count } = await sourceDescriptor.read(buffer, 0, Math.min(buffer.length, Number(openedSource.size) - copied), null);
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
        const finalSource = await sourceDescriptor.stat({ bigint: true });
        const finalTarget = await targetDescriptor.stat({ bigint: true });
        const finalSourcePath = await readDeviceLabFileIdentityAsync(absolute, label);
        if (finalSource.nlink !== 1n || finalSource.dev !== openedSource.dev || finalSource.ino !== openedSource.ino || finalSource.size !== openedSource.size
            || finalSourcePath.isSymbolicLink() || finalSourcePath.nlink !== 1n || finalSourcePath.dev !== openedSource.dev || finalSourcePath.ino !== openedSource.ino || finalSourcePath.size !== openedSource.size
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
    let pathStat = await fsPromises.lstat(absolute, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n || pathStat.size <= 0n) throw new Error(`${label}-invalid`);
    pathStat = await readDeviceLabFileIdentityAsync(absolute, label, pathStat);
    if (pathStat.size <= 0n) throw new Error(`${label}-invalid`);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const descriptor = await fsPromises.open(absolute, fsConstants.O_RDONLY | noFollow | (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0));
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        const openedStat = await descriptor.stat({ bigint: true });
        if (!openedStat.isFile() || openedStat.nlink !== 1n
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
        const finalStat = await descriptor.stat({ bigint: true });
        const finalPathStat = await readDeviceLabFileIdentityAsync(absolute, label);
        if (!finalStat.isFile()
            || !finalPathStat.isFile()
            || finalPathStat.isSymbolicLink()
            || finalStat.nlink !== 1n
            || finalPathStat.nlink !== 1n
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
            || value.virtualSizeBytes <= 0
            || (value.vhdType !== "Fixed" && value.virtualSizeBytes < value.sizeBytes)
            || (value.vhdType !== "Dynamic" && value.vhdType !== "Fixed")
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

function hyperVImageEntryPresent(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
        throw error;
    }
}

// isKnownPriorAutomaticImage without the hash: the prior-catalog manifest and an image file of its size.
function knownPriorAutomaticImageMetadata(profileRoot: string, manifestPath: string, imageFile: string): boolean {
    try {
        const prior = readKnownPriorAutomaticManifest(profileRoot, manifestPath);
        return !!prior && inspectLargeRegularFile(profileRoot, imageFile, "hyper-v-base-image-prior").size === prior.sizeBytes;
    } catch {
        return false;
    }
}

// Readiness view of the ubuntu-lts cache decision that resolveHyperVImageForCreate makes before
// acquisition. It reads manifests and file metadata only: nothing is hashed, written, locked,
// cleaned up or recovered, so it fits the smoke and device_backends budgets. Create remains the
// trust gate and hashes base.vhdx before use, so an image that passes here can still fail there.
export function inspectHyperVUbuntuImageCache(privateRoot: string, ownerId: string): HyperVUbuntuImageCacheInspection {
    const profileConflict = { state: "conflict", code: "hyper-v-base-image-profile-conflict" } as const;
    const globalProfileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
    const manifestPath = join(globalProfileRoot, "manifest.json");
    const imagePath = join(globalProfileRoot, "base.vhdx");
    const backup = priorRecoveryPaths(globalProfileRoot);
    let backupPresent: boolean;
    let priorRestorable = false;
    try {
        // Create prepares into the shared root and, before it reads any cache, restores a prior-catalog
        // pair whose retirement was interrupted. An unsafe root or a pair it cannot restore stops create
        // even when the owner has a valid image; recoverPriorAutomaticImage decides the same way.
        assertNoSymlinkPathComponents(globalProfileRoot, "hyper-v-base-image-cache-inspection");
        if (hyperVImageEntryPresent(globalProfileRoot) && !lstatSync(globalProfileRoot).isDirectory()) return profileConflict;
        backupPresent = hyperVImageEntryPresent(backup.manifest) || hyperVImageEntryPresent(backup.image);
        if (backupPresent && !(hyperVImageEntryPresent(manifestPath) && hyperVImageEntryPresent(imagePath))) {
            const manifestFile = hyperVImageEntryPresent(backup.manifest) ? backup.manifest : manifestPath;
            const imageFile = hyperVImageEntryPresent(backup.image) ? backup.image : imagePath;
            if ((manifestFile === backup.manifest && hyperVImageEntryPresent(manifestPath))
                || !knownPriorAutomaticImageMetadata(globalProfileRoot, manifestFile, imageFile)) return profileConflict;
            priorRestorable = true;
        }
    } catch {
        return profileConflict;
    }
    if (HYPER_V_IMAGE_OWNER_ID_PATTERN.test(ownerId)) {
        try {
            readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts", hyperVOwnerImageProfileRoot(privateRoot, ownerId, "ubuntu-lts"), true);
            return { state: "valid", source: "owner" };
        } catch { /* create falls back to the shared automatic cache */ }
    }
    // A restorable prior pair is retired and reacquired, like a prior-catalog manifest in place.
    if (priorRestorable) {
        try {
            return hyperVImageEntryPresent(join(globalProfileRoot, "base.partial.vhdx"))
                || hyperVImageEntryPresent(join(globalProfileRoot, ".acquire-work"))
                ? { state: "conflict", code: "hyper-v-base-image-artifact-owner-unknown" }
                : { state: "acquisition-required" };
        } catch {
            return profileConflict;
        }
    }
    try {
        readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts", globalProfileRoot, false);
        return { state: "valid", source: "global" };
    } catch { /* classify what create would do without a usable cache */ }
    try {
        let priorCatalog = false;
        if (hyperVImageEntryPresent(manifestPath)) {
            // Only the immediately previous catalog, with its image in place, is retired and
            // reacquired; any other manifest that failed validation is left for the operator.
            if (!knownPriorAutomaticImageMetadata(globalProfileRoot, manifestPath, imagePath)) return profileConflict;
            priorCatalog = true;
        } else if (hyperVImageEntryPresent(imagePath)) {
            return { state: "conflict", code: "hyper-v-base-image-unmanaged-existing" };
        }
        if (hyperVImageEntryPresent(join(globalProfileRoot, "base.partial.vhdx"))
            || hyperVImageEntryPresent(join(globalProfileRoot, ".acquire-work"))) {
            return { state: "conflict", code: "hyper-v-base-image-artifact-owner-unknown" };
        }
        // Retirement refuses to overwrite the backups an earlier retirement left beside a complete pair.
        if (priorCatalog && backupPresent) return profileConflict;
        return { state: "acquisition-required" };
    } catch {
        // An unreadable image root is one create cannot prepare into either.
        return profileConflict;
    }
}


export async function resolveHyperVImageForCreateOutcome(
    ownerId: string,
    request: HyperVImageCreateRequest,
    params: unknown,
    runtime: HyperVImageStoreRuntime,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HyperVImageResolutionOutcome> {
    const client = (executable: string, timeoutMilliseconds: number | (() => number)) => createDeviceLabHyperVWindowsClient({
        executable, timeoutMilliseconds, run: runtime.run,
    });
    const ports: HyperVImagePreparationPorts = {
        cwd: runtime.cwd, privateRoot: runtime.privateRoot, limits: runtime.limits,
        catalog: HYPER_V_IMAGE_CATALOG,
        now: () => Date.now(), preparedAt: () => new Date().toISOString(),
        resolvePath: resolve,
        capturePreparation: () => {
            const executable = runtime.resolveExecutable("powershell.exe") || runtime.resolveExecutable("pwsh") || runtime.resolveExecutable("powershell");
            if (!executable) return null;
            return {
                getVhd: (path, timeout) => client(executable, timeout).getVHD(path),
                mountReadOnly: (path, timeout) => client(executable, timeout).mountVHD({path, readOnly: true, noDriveLetter: true}).then(() => undefined),
                dismount: (path, timeout) => client(executable, timeout).dismountVHD(path).then(() => undefined),
                convertVhd: (sourcePath, destinationPath, timeout, remainingTimeout) => client(executable, remainingTimeout).convertVHD({sourcePath, destinationPath, vhdType: "Dynamic"}, {timeoutMilliseconds: timeout}).then(() => undefined),
                resizeVhd: (path, sizeBytes, timeout, remainingTimeout) => client(executable, remainingTimeout).resizeVHD({path, sizeBytes}, {timeoutMilliseconds: timeout}).then(() => undefined),
                storage: async (root, path, readPartitionStyle, timeoutMs) => {
                    const execution = await runtime.run(hyperVImportedImageStorageCommand({executable, imageRoot: root, path, readPartitionStyle}), {timeoutMs, outputLimit: runtime.limits.commandOutputBytes});
                    return imageNativeObservation(execution, () => parseHyperVImportedImageStorage(execution.stdout || "", path));
                },
                prepareAcquisition: async (options, timeoutMs) => {
                    const execution = await runtime.run(hyperVAcquireBaseImagePrepareCommand({...options, executable}), {timeoutMs, outputLimit: runtime.limits.commandOutputBytes});
                    return imageNativeObservation(execution, () => parseHyperVAcquireBaseImagePrepareObservation(execution.stdout || ""));
                },
                finalizeAcquisition: async (options, timeoutMs) => {
                    const execution = await runtime.run(hyperVAcquireBaseImageFinalizeCommand({...options, executable}), {timeoutMs, outputLimit: runtime.limits.commandOutputBytes});
                    return imageNativeObservation(execution, () => parseHyperVBaseImageObservation(execution.stdout || ""));
                },
            };
        },
        assertDeadline: (deadline) => { assertHyperVOperationDeadline(deadline); return undefined; },
        remainingTimeout: hyperVRemainingTimeout, deadlineExpired: hyperVOperationDeadlineExpired,
        isDeadlineError: (error) => error instanceof HyperVOperationDeadlineError,
        deadlineError: () => new HyperVOperationDeadlineError(),
        boundedErrorCode: hyperVBoundedErrorCode, boundedErrorDetail: hyperVBoundedErrorDetail,
        exists: existsSync,
        manifestPresent: (path) => {
            try { lstatSync(path); return true; }
            catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false; throw error; }
        },
        inspectFile: inspectLargeRegularFile, hashFile: sha256LargeRegularFile, stageFile: stageLargeRegularFileFromProject,
        fileIdentity: async (path) => { const stat = await fsPromises.lstat(path); return { dev: stat.dev, ino: stat.ino }; },
        linkFile: (source, destination) => fsPromises.link(source, destination),
        unlinkFile: (path) => fsPromises.unlink(path),
        manifestTemporaryPath: (root) => join(root, `.manifest-${randomBytes(12).toString("hex")}.tmp`),
        writeManifestTemporary: async (path, bytes) => {
            const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
            const descriptor = await fsPromises.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
            try {
                await descriptor.writeFile(bytes);
                await descriptor.sync();
                const temporary = await descriptor.stat();
                if (!temporary.isFile() || temporary.nlink !== 1 || temporary.size !== Buffer.byteLength(bytes)) {
                    throw new Error("hyper-v-base-image-manifest-invalid");
                }
                return { dev: temporary.dev, ino: temporary.ino };
            } finally { await descriptor.close(); }
        },
        publishManifest: (path, manifest) => { writeJsonFileAtomically(path, manifest); return undefined; },
        readManifest: readHyperVImageManifest, readManifestMetadata: readHyperVImageManifestMetadata,
        ensurePreparationRoot: (root) => {
            mkdirSync(root, { recursive: true, mode: 0o700 });
            assertNoSymlinkPathComponents(root, "hyper-v-base-image-preparation");
            const metadata = lstatSync(root);
            if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("hyper-v-base-image-preparation-root-invalid");
            return undefined;
        },
        assertSafePath: (path, label) => { assertNoSymlinkPathComponents(path, label); return undefined; },
        withPreparationLock: withSharedMutationLockAsync,
        licenseAccepted: (root) => Boolean(readHyperVWindowsEvaluationReceipt(root)),
        artifactIdentity: automaticArtifactIdentity,
        assertFileIdentity: (path, expected, label) => { assertAutomaticFileIdentity(path, expected, label); return undefined; },
        cleanupOwnedArtifacts: (root, owned) => { cleanupOwnedAutomaticArtifacts(root, owned); return undefined; },
        quarantineUncertainArtifact: quarantineUncertainAutomaticArtifact,
        knownPriorImage: isKnownPriorAutomaticImage, recoverPriorImage: recoverPriorAutomaticImage,
        retirePriorImage: retireKnownPriorAutomaticImage, discardPriorImage: discardRetiredPriorAutomaticImage,
    };
    return createHyperVImagePreparation(ports).resolveForCreate(ownerId, request, params, deadlineAt);
}

/** Legacy native wire compatibility; semantic lifecycle peers use the Outcome export. */
export async function resolveHyperVImageForCreate(ownerId: string, request: HyperVImageCreateRequest, params: unknown, runtime: HyperVImageStoreRuntime, deadlineAt = Number.POSITIVE_INFINITY): Promise<HyperVImageResolution> {
    return hyperVImageResolutionToWire(await resolveHyperVImageForCreateOutcome(ownerId, request, params, runtime, deadlineAt));
}
