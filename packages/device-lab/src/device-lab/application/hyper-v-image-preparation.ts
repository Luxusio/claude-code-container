import { join } from "path";
import { hyperVImageManifest, hyperVImageProfile, inspectHyperVCreateVhd, inspectHyperVAcquiredVhd } from "../domain/hyper-v-image-preparation.js";
import type { HyperVBaseImageObservation, HyperVImageNativeObservation, HyperVImageCreateRequest, HyperVImageManifest, HyperVImageProfile, HyperVImageResolution, HyperVImageVhd } from "../domain/hyper-v-image-preparation.js";
import type { HyperVAutomaticArtifactIdentity, HyperVImagePreparationPorts, HyperVImagePreparationEffects } from "../ports/hyper-v-image-preparation.js";

const HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES = 16 * 1024;
const HYPER_V_IMAGE_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

function hyperVImageRoot(privateRoot: string): string { return join(privateRoot, "images", "hyper-v"); }
function hyperVImageProfileRoot(privateRoot: string, profile: HyperVImageProfile): string { return join(hyperVImageRoot(privateRoot), profile); }
function hyperVOwnerImageProfileRoot(privateRoot: string, ownerId: string, profile: HyperVImageProfile): string { return join(privateRoot, "owners", ownerId, "images", "hyper-v", profile); }

export function createHyperVImagePreparation(ports: HyperVImagePreparationPorts) {
    async function prepareImportedHyperVImage(
        profile: HyperVImageProfile,
        sourceImage: string,
        ownerProfileRoot: string,
        effects: HyperVImagePreparationEffects,
        deadlineAt: number,
    ): Promise<{ observation: HyperVBaseImageObservation; prepared: boolean }> {
        const imagePath = join(ownerProfileRoot, "base.vhdx");
        const manifestPath = join(ownerProfileRoot, "manifest.json");
        const manifestWasPresent = ports.manifestPresent(manifestPath);
        const stagedSource = await ports.stageFile(ports.resolvePath(ports.cwd), sourceImage, ownerProfileRoot, "hyper-v-base-image-source", deadlineAt);
        let removeStagedSource = true;
        let partial: string | null = null;
        let publishedIdentity: { dev: number; ino: number } | null = null;
        let manifestTemporaryPath: string | null = null;
        let publishedManifestIdentity: { dev: number; ino: number } | null = null;
        const storage = async (readPartitionStyle: boolean, cleanup = false) => {
            const stage = await effects.storage(
                ownerProfileRoot, stagedSource, readPartitionStyle,
                cleanup ? 30_000 : ports.remainingTimeout(deadlineAt, ports.limits.prepareTimeoutMs),
            );
            if (stage.kind === "failed") throw new Error(`hyper-v-base-image-storage-failed:${stage.diagnostic}`);
            const observation = stage.observation;
            if (!observation) throw new Error("hyper-v-base-image-storage-invalid-result");
            return observation;
        };
        try {
            const source = ports.inspectFile(ownerProfileRoot, stagedSource, "hyper-v-base-image-source");
            const sourceSha256 = await ports.hashFile(ownerProfileRoot, stagedSource, "hyper-v-base-image-source", deadlineAt);
            let reused = false;
            if (ports.exists(imagePath)) {
                const existing = ports.inspectFile(ownerProfileRoot, imagePath, "hyper-v-base-image");
                if (existing.size !== source.size || await ports.hashFile(ownerProfileRoot, imagePath, "hyper-v-base-image", deadlineAt) !== sourceSha256) {
                    throw new Error("hyper-v-base-image-profile-conflict");
                }
                reused = true;
            }
            const sourceVhd = await effects.getVhd(stagedSource, () => ports.remainingTimeout(deadlineAt, ports.limits.prepareTimeoutMs));
            const virtualSizeBytes = inspectHyperVCreateVhd({ kind: "base", path: stagedSource }, sourceVhd);
            if (sourceVhd.vhdType !== "Dynamic" && sourceVhd.vhdType !== "Fixed") throw new Error("hyper-v-base-image-type-unsupported");
            if (sourceVhd.fileSizeBytes !== source.size
                || (sourceVhd.vhdType === "Dynamic" && source.size > virtualSizeBytes)) throw new Error("hyper-v-base-image-size-mismatch");
            const beforeMount = await storage(false);
            if (beforeMount.attached) {
                removeStagedSource = false;
                throw new Error("hyper-v-base-image-source-already-mounted");
            }
            let partitionStyle: string | null = null;
            let mountError: unknown = null;
            removeStagedSource = false;
            try {
                await effects.mountReadOnly(stagedSource, () => ports.remainingTimeout(deadlineAt, ports.limits.prepareTimeoutMs));
                const mounted = await storage(true);
                if (!mounted.attached) throw new Error("hyper-v-base-image-not-mounted");
                partitionStyle = mounted.partitionStyle;
            } catch (error) {
                mountError = error;
            } finally {
                // The staged path belongs only to this transaction, so a lost mount response can
                // safely be followed by a path-based dismount. Keep it if detached readback fails.
                let dismountError: unknown = null;
                try { await effects.dismount(stagedSource, 30_000); } catch (error) { dismountError = error; }
                try {
                    const detached = await storage(false, true);
                    if (detached.attached) throw new Error("hyper-v-base-image-dismount-failed");
                    removeStagedSource = true;
                    if (dismountError) throw new Error("hyper-v-base-image-dismount-failed");
                } catch {
                    throw new Error("hyper-v-base-image-dismount-failed");
                }
            }
            if (mountError) throw mountError;
            ports.assertDeadline(deadlineAt);
            const generation = partitionStyle === "GPT" ? 2 : partitionStyle === "MBR" ? 1 : null;
            if (!generation) throw new Error("hyper-v-base-image-partition-style-unsupported");

            if (reused) {
                const existingVhd = await effects.getVhd(imagePath, () => ports.remainingTimeout(deadlineAt, ports.limits.prepareTimeoutMs));
                if (inspectHyperVCreateVhd({ kind: "base", path: imagePath }, existingVhd) !== virtualSizeBytes
                    || existingVhd.fileSizeBytes !== source.size || existingVhd.vhdType !== sourceVhd.vhdType) throw new Error("hyper-v-base-image-profile-conflict");
            } else {
                partial = await ports.stageFile(ownerProfileRoot, stagedSource, ownerProfileRoot, "hyper-v-base-image-copy", deadlineAt);
                const copied = ports.inspectFile(ownerProfileRoot, partial, "hyper-v-base-image-copy");
                if (copied.size !== source.size
                    || await ports.hashFile(ownerProfileRoot, partial, "hyper-v-base-image-copy", deadlineAt) !== sourceSha256) {
                    throw new Error("hyper-v-base-image-hash-mismatch");
                }
                const copiedVhd = await effects.getVhd(partial, () => ports.remainingTimeout(deadlineAt, ports.limits.prepareTimeoutMs));
                if (inspectHyperVCreateVhd({ kind: "base", path: partial }, copiedVhd) !== virtualSizeBytes
                    || copiedVhd.fileSizeBytes !== source.size || copiedVhd.vhdType !== sourceVhd.vhdType) throw new Error("hyper-v-base-image-size-mismatch");
                ports.assertDeadline(deadlineAt);
                const partialStat = await ports.fileIdentity(partial);
                await ports.linkFile(partial, imagePath);
                publishedIdentity = { dev: partialStat.dev, ino: partialStat.ino };
                await ports.unlinkFile(partial);
                partial = null;
                const final = ports.inspectFile(ownerProfileRoot, imagePath, "hyper-v-base-image");
                if (final.size !== source.size
                    || await ports.hashFile(ownerProfileRoot, imagePath, "hyper-v-base-image", deadlineAt) !== sourceSha256) {
                    throw new Error("hyper-v-base-image-hash-mismatch");
                }
                const finalVhd = await effects.getVhd(imagePath, () => ports.remainingTimeout(deadlineAt, ports.limits.prepareTimeoutMs));
                if (inspectHyperVCreateVhd({ kind: "base", path: imagePath }, finalVhd) !== virtualSizeBytes
                    || finalVhd.fileSizeBytes !== source.size || finalVhd.vhdType !== sourceVhd.vhdType) throw new Error("hyper-v-base-image-size-mismatch");
            }
            const observation: HyperVBaseImageObservation = {
                ok: true, profile, imagePath, sha256: sourceSha256, sizeBytes: source.size,
                virtualSizeBytes, vhdType: sourceVhd.vhdType, generation, reused,
            };
            if (manifestWasPresent) {
                const existingManifest = ports.readManifestMetadata(ports.privateRoot, profile, ownerProfileRoot, true);
                if (existingManifest.sha256 !== sourceSha256
                    || existingManifest.sizeBytes !== source.size
                    || existingManifest.virtualSizeBytes !== virtualSizeBytes
                    || existingManifest.vhdType !== sourceVhd.vhdType
                    || existingManifest.generation !== generation) throw new Error("hyper-v-base-image-profile-conflict");
                ports.assertDeadline(deadlineAt);
                return { observation, prepared: !reused };
            }
            ports.assertDeadline(deadlineAt);
            const manifest = hyperVImageManifest(profile, imagePath, observation, false, profile === "windows-11" ? null : ports.catalog[profile], ports.preparedAt());
            const manifestBytes = JSON.stringify(manifest, null, 2);
            if (Buffer.byteLength(manifestBytes) > HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES) throw new Error("hyper-v-base-image-manifest-invalid");
            manifestTemporaryPath = ports.manifestTemporaryPath(ownerProfileRoot);
            const temporaryIdentity = await ports.writeManifestTemporary(manifestTemporaryPath, manifestBytes);
            ports.assertDeadline(deadlineAt);
            await ports.linkFile(manifestTemporaryPath, manifestPath);
            publishedManifestIdentity = temporaryIdentity;
            await ports.unlinkFile(manifestTemporaryPath);
            manifestTemporaryPath = null;
            ports.assertDeadline(deadlineAt);
            return { observation, prepared: !reused };
        } catch (error) {
            if (publishedManifestIdentity) {
                try {
                    const current = await ports.fileIdentity(manifestPath);
                    if (current.dev === publishedManifestIdentity.dev && current.ino === publishedManifestIdentity.ino) await ports.unlinkFile(manifestPath);
                } catch { /* preserve the original failure */ }
            }
            if (publishedIdentity) {
                try {
                    const current = await ports.fileIdentity(imagePath);
                    if (current.dev === publishedIdentity.dev && current.ino === publishedIdentity.ino) await ports.unlinkFile(imagePath);
                } catch { /* preserve the original failure */ }
            }
            throw error;
        } finally {
            if (manifestTemporaryPath) { try { await ports.unlinkFile(manifestTemporaryPath); } catch { /* best effort */ } }
            if (partial) { try { await ports.unlinkFile(partial); } catch { /* best effort */ } }
            if (removeStagedSource) { try { await ports.unlinkFile(stagedSource); } catch { /* best effort */ } }
        }
    }

    async function acquireAutomaticHyperVImage(
        profile: "windows-server" | "ubuntu-lts",
        globalProfileRoot: string,
        effects: HyperVImagePreparationEffects,
        acquireDeadlineAt: number,
    ): Promise<HyperVBaseImageObservation> {
        const imageRoot = hyperVImageRoot(ports.privateRoot);
        const imagePath = join(globalProfileRoot, "base.vhdx");
        const partialPath = join(globalProfileRoot, "base.partial.vhdx");
        const workPath = join(globalProfileRoot, ".acquire-work");
        const ownedArtifacts = new Map<string, HyperVAutomaticArtifactIdentity>();
        const options = {
            profile, imageRoot,
            expectedGeneration: 2 as const,
        } as const;
        const checkedStage = <T>(stage: HyperVImageNativeObservation<T>): T | null => {
            ports.assertDeadline(acquireDeadlineAt);
            if (stage.kind === "failed") {
                throw new Error(`hyper-v-base-image-acquire-failed:${stage.diagnostic}`);
            }
            return stage.observation;
        };
        const inspectVhd = async (
            path: string, format: "VHD" | "VHDX", expectedType?: "Fixed" | "Dynamic",
        ): Promise<HyperVImageVhd> => {
            const file = ports.inspectFile(globalProfileRoot, path, "hyper-v-base-image-vhd");
            const vhd = await effects.getVhd(path, () => ports.remainingTimeout(acquireDeadlineAt, ports.limits.acquireTimeoutMs));
            inspectHyperVAcquiredVhd(path, vhd, file.size, format, expectedType);
            return vhd;
        };
        try {
            const prepared = checkedStage(await effects.prepareAcquisition(options, ports.remainingTimeout(acquireDeadlineAt, ports.limits.acquireTimeoutMs)));
            if (!prepared || prepared.profile !== profile
                || ports.resolvePath(prepared.imagePath) !== ports.resolvePath(imagePath)
                || ports.resolvePath(prepared.partialPath) !== ports.resolvePath(partialPath)) {
                throw new Error("hyper-v-base-image-acquire-invalid-result");
            }
            for (const path of [partialPath, workPath]) {
                const identity = ports.artifactIdentity(path);
                if (identity) ownedArtifacts.set(path, identity);
            }
            let expectedSourceVhdSha256: string | undefined;
            let expectedSourceFileId: string | undefined;
            let expectedQemuSha256: string | undefined;
            let expectedPartialSha256: string;
            let expectedPartialFileId: string;
            let expectedVirtualSizeBytes: number;
            let expectedVhdType: "Fixed" | "Dynamic";
            if (prepared.profile === "ubuntu-lts") {
                const sourcePath = join(globalProfileRoot, ".acquire-work", "converted.normalized.fixed.vhd");
                if (ports.resolvePath(prepared.sourceVhdPath) !== ports.resolvePath(sourcePath)) throw new Error("hyper-v-base-image-source-path-invalid");
                const sourceIdentity = ports.artifactIdentity(sourcePath);
                if (!sourceIdentity || sourceIdentity.directory) throw new Error("hyper-v-base-image-source-invalid");
                const sourceHashBefore = await ports.hashFile(globalProfileRoot, sourcePath, "hyper-v-base-image-source", acquireDeadlineAt);
                if (sourceHashBefore !== prepared.sourceVhdSha256) throw new Error("hyper-v-base-image-source-mutated");
                const sourceVhd = await inspectVhd(sourcePath, "VHD", "Fixed");
                if (sourceVhd.virtualSizeBytes !== prepared.sourceVirtualSizeBytes
                    || sourceVhd.virtualSizeBytes > ports.catalog["ubuntu-lts"].virtualSizeBytes) {
                    throw new Error("hyper-v-base-image-source-format-invalid");
                }
                if (await ports.hashFile(globalProfileRoot, sourcePath, "hyper-v-base-image-source", acquireDeadlineAt) !== sourceHashBefore) {
                    throw new Error("hyper-v-base-image-source-mutated");
                }
                ports.assertFileIdentity(sourcePath, sourceIdentity, "hyper-v-base-image-source");
                await effects.convertVhd(sourcePath, partialPath, ports.remainingTimeout(acquireDeadlineAt, ports.limits.acquireTimeoutMs), () => ports.remainingTimeout(acquireDeadlineAt, ports.limits.acquireTimeoutMs));
                const convertedIdentity = ports.artifactIdentity(partialPath);
                if (convertedIdentity) ownedArtifacts.set(partialPath, convertedIdentity);
                if (await ports.hashFile(globalProfileRoot, sourcePath, "hyper-v-base-image-source", acquireDeadlineAt) !== sourceHashBefore) {
                    throw new Error("hyper-v-base-image-source-mutated");
                }
                ports.assertFileIdentity(sourcePath, sourceIdentity, "hyper-v-base-image-source");
                const partialIdentity = ports.artifactIdentity(partialPath);
                if (!partialIdentity || partialIdentity.directory) throw new Error("hyper-v-base-image-partial-invalid");
                let partialVhd = await inspectVhd(partialPath, "VHDX", "Dynamic");
                ports.assertFileIdentity(partialPath, partialIdentity, "hyper-v-base-image-partial");
                const targetSize = ports.catalog["ubuntu-lts"].virtualSizeBytes;
                if (partialVhd.virtualSizeBytes > targetSize) throw new Error("hyper-v-base-image-convert-failed");
                if (partialVhd.virtualSizeBytes < targetSize) {
                    await effects.resizeVhd(partialPath, targetSize, ports.remainingTimeout(acquireDeadlineAt, ports.limits.acquireTimeoutMs), () => ports.remainingTimeout(acquireDeadlineAt, ports.limits.acquireTimeoutMs));
                    partialVhd = await inspectVhd(partialPath, "VHDX", "Dynamic");
                    ports.assertFileIdentity(partialPath, partialIdentity, "hyper-v-base-image-partial");
                }
                if (partialVhd.virtualSizeBytes !== targetSize) throw new Error("hyper-v-base-image-convert-failed");
                expectedSourceVhdSha256 = sourceHashBefore;
                expectedSourceFileId = sourceIdentity.ino.toString();
                expectedQemuSha256 = prepared.qemuSha256;
                expectedPartialSha256 = await ports.hashFile(globalProfileRoot, partialPath, "hyper-v-base-image-partial", acquireDeadlineAt);
                expectedPartialFileId = partialIdentity.ino.toString();
                ports.assertFileIdentity(sourcePath, sourceIdentity, "hyper-v-base-image-source");
                ports.assertFileIdentity(partialPath, partialIdentity, "hyper-v-base-image-partial");
                expectedVirtualSizeBytes = partialVhd.virtualSizeBytes;
                expectedVhdType = "Dynamic";
            } else {
                const partialFile = ports.inspectFile(globalProfileRoot, partialPath, "hyper-v-base-image-partial");
                const partialIdentity = ports.artifactIdentity(partialPath);
                if (!partialIdentity || partialIdentity.directory) throw new Error("hyper-v-base-image-partial-invalid");
                expectedPartialSha256 = await ports.hashFile(globalProfileRoot, partialPath, "hyper-v-base-image-partial", acquireDeadlineAt);
                expectedPartialFileId = partialIdentity.ino.toString();
                if (partialFile.size !== prepared.partialSizeBytes || expectedPartialSha256 !== prepared.partialSha256) {
                    throw new Error("hyper-v-base-image-partial-mutated");
                }
                const partialVhd = await inspectVhd(partialPath, "VHDX");
                ports.assertFileIdentity(partialPath, partialIdentity, "hyper-v-base-image-partial");
                expectedVirtualSizeBytes = partialVhd.virtualSizeBytes;
                expectedVhdType = partialVhd.vhdType as "Fixed" | "Dynamic";
            }
            const finalizeCommon = {
                imageRoot, expectedGeneration: 2 as const,
                expectedPartialSha256, expectedPartialFileId, expectedVirtualSizeBytes, expectedVhdType,
            };
            const finalizeRequest = profile === "ubuntu-lts"
                ? ({
                    ...finalizeCommon, profile,
                    expectedSourceVhdSha256: expectedSourceVhdSha256!, expectedSourceFileId: expectedSourceFileId!, expectedQemuSha256: expectedQemuSha256!,
                })
                : ({ ...finalizeCommon, profile });
            const observation = checkedStage(await effects.finalizeAcquisition(finalizeRequest, ports.remainingTimeout(acquireDeadlineAt, ports.limits.acquireTimeoutMs)));
            if (!observation || observation.profile !== profile || ports.resolvePath(observation.imagePath) !== ports.resolvePath(imagePath)
                || observation.generation !== ports.catalog[profile].generation
                || observation.virtualSizeBytes !== expectedVirtualSizeBytes
                || observation.vhdType !== expectedVhdType) {
                throw new Error("hyper-v-base-image-acquire-invalid-result");
            }
            const finalVhd = await inspectVhd(imagePath, "VHDX", expectedVhdType);
            if (finalVhd.virtualSizeBytes !== observation.virtualSizeBytes) throw new Error("hyper-v-base-image-final-inspection-failed");
            ports.cleanupOwnedArtifacts(globalProfileRoot, ownedArtifacts);
            return observation;
        } catch (error) {
            // The finalizer has released its handle before a later typed read or broker check.
            // A path stat or matching hash cannot prove who created base.vhdx if it was replaced.
            // Keep any unmanifested base for guarded recovery and clean only known work paths.
            try { ports.cleanupOwnedArtifacts(globalProfileRoot, ownedArtifacts); }
            catch { /* preserve the original failure and leave uncertain artifacts in place */ }
            for (const [path, label] of [
                [partialPath, "partial-uncertain"], [workPath, "work-uncertain"],
            ] as const) {
                try { ports.quarantineUncertainArtifact(globalProfileRoot, path, label); }
                catch { /* an unsafe or changed path remains for explicit guarded recovery */ }
            }
            if (ports.deadlineExpired(acquireDeadlineAt)) throw ports.deadlineError();
            throw error;
        }
    }

    async function resolveForCreate(
        ownerId: string,
        request: HyperVImageCreateRequest,
        params: unknown,
        deadlineAt = Number.POSITIVE_INFINITY,
    ): Promise<HyperVImageResolution> {
        const input = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
        const create = request.create || {};
        const profile = hyperVImageProfile(create.profile || (request.backend === "linux-vm" ? "ubuntu-lts" : "windows-server"));
        if (!profile) {
            return { kind: "refused", reason: "invalid-profile", error: "hyper-v-image-profile-invalid", detail: "profile must be windows-11, windows-server, or ubuntu-lts" };
        }
        const globalProfileRoot = hyperVImageProfileRoot(ports.privateRoot, profile);
        const ownerProfileRoot = hyperVOwnerImageProfileRoot(ports.privateRoot, ownerId, profile);
        if (typeof create.image === "string" && create.image) {
            try {
                const requestedImage = ports.resolvePath(create.image);
                const ownerImage = ports.resolvePath(join(ownerProfileRoot, "base.vhdx"));
                const globalImage = ports.resolvePath(join(globalProfileRoot, "base.vhdx"));
                const manifest = requestedImage === ownerImage
                    ? await ports.readManifest(ports.privateRoot, profile, ownerProfileRoot, true, deadlineAt)
                    : requestedImage === globalImage
                        ? await ports.readManifest(ports.privateRoot, profile, globalProfileRoot, false, deadlineAt)
                        : (() => { throw new Error("hyper-v-base-image-manifest-path-mismatch"); })();
                if (ports.resolvePath(create.image) !== ports.resolvePath(manifest.imagePath)) throw new Error("hyper-v-base-image-manifest-path-mismatch");
                return { kind: "resolved", params: { ...input, profile, image: manifest.imagePath, baseImageSha256: manifest.sha256, baseImageGeneration: manifest.generation, diskMaxBytes: manifest.virtualSizeBytes }, imagePath: manifest.imagePath, prepared: false };
            } catch (error) {
                if (ports.isDeadlineError(error)) throw error;
                return {
                    kind: "refused",
                    reason: "not-prepared",
                    error: "hyper-v-base-image-not-prepared",
                    detail: ports.boundedErrorCode(error, "hyper-v-base-image-not-prepared"),
                    remedy: "import the generalized VHDX with --source-image",
                };
            }
        }

        const sourceImage = typeof create.sourceImage === "string" && create.sourceImage ? ports.resolvePath(ports.cwd, create.sourceImage) : null;
        if (request.dryRun) {
            if (sourceImage) {
                return {
                    kind: "refused",
                    reason: "not-prepared",
                    error: "hyper-v-base-image-not-prepared",
                    remedy: "run device_create without --dry-run once to import and validate the source image",
                };
            }
            try {
                let manifest: HyperVImageManifest;
                try {
                    manifest = await ports.readManifest(ports.privateRoot, profile, ownerProfileRoot, true, deadlineAt);
                } catch {
                    manifest = await ports.readManifest(ports.privateRoot, profile, globalProfileRoot, false, deadlineAt);
                }
                return {
                    kind: "resolved",
                    params: { ...input, profile, image: manifest.imagePath, baseImageSha256: manifest.sha256, baseImageGeneration: manifest.generation, diskMaxBytes: manifest.virtualSizeBytes },
                    imagePath: manifest.imagePath,
                    prepared: false,
                };
            } catch (error) {
                return {
                    kind: "refused",
                    reason: "not-prepared",
                    error: "hyper-v-base-image-not-prepared",
                    detail: ports.boundedErrorCode(error, "hyper-v-base-image-not-prepared"),
                    remedy: "run device_create without --dry-run once to acquire and validate the base image",
                };
            }
        }

        const preparationRoot = sourceImage ? ownerProfileRoot : globalProfileRoot;
        try {
            ports.ensurePreparationRoot(preparationRoot);
            return await ports.withPreparationLock(join(preparationRoot, "prepare.lock"), async () => {
                ports.assertDeadline(deadlineAt);
                if (!sourceImage) {
                    const acquireDeadlineAt = Math.min(deadlineAt, ports.now() + ports.limits.acquireTimeoutMs);
                    if (profile === "ubuntu-lts") await ports.recoverPriorImage(globalProfileRoot, acquireDeadlineAt);
                    let retiredPrior: {
                        prior: { manifestBytes: Buffer; imageSha256: string; imageSize: number };
                        identities: { manifest: HyperVAutomaticArtifactIdentity; image: HyperVAutomaticArtifactIdentity };
                    } | null = null;
                    let pendingPrior: { manifestBytes: Buffer; imageSha256: string; imageSize: number } | null = null;
                    let cachedManifest: HyperVImageManifest | null = null;
                    try {
                        cachedManifest = await ports.readManifest(ports.privateRoot, profile, ownerProfileRoot, true, deadlineAt);
                    } catch (cacheError) {
                        if (ports.isDeadlineError(cacheError)) throw cacheError;
                        try {
                            cachedManifest = await ports.readManifest(ports.privateRoot, profile, globalProfileRoot, false, deadlineAt);
                        } catch (globalCacheError) {
                            if (ports.isDeadlineError(globalCacheError)) throw globalCacheError;
                            if (profile === "windows-11") {
                                throw new Error(`hyper-v-base-image-profile-not-automatic:${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
                            }
                            ports.assertSafePath(globalProfileRoot, "hyper-v-base-image-cleanup");
                            if (ports.exists(join(globalProfileRoot, "manifest.json"))) {
                                const prior = await ports.knownPriorImage(profile, globalProfileRoot, acquireDeadlineAt);
                                if (!prior) {
                                    throw new Error("hyper-v-base-image-profile-conflict");
                                }
                                pendingPrior = prior;
                            } else if (ports.exists(join(globalProfileRoot, "base.vhdx"))) {
                                throw new Error("hyper-v-base-image-unmanaged-existing");
                            }
                        }
                    }
                    if (cachedManifest) {
                        if (cachedManifest.licenseId && !ports.licenseAccepted(join(ports.privateRoot, "setup"))) {
                            throw new Error("hyper-v-windows-evaluation-license-not-accepted");
                        }
                        return {
                            kind: "resolved" as const,
                            params: { ...input, profile, image: cachedManifest.imagePath, baseImageSha256: cachedManifest.sha256, baseImageGeneration: cachedManifest.generation, diskMaxBytes: cachedManifest.virtualSizeBytes },
                            imagePath: cachedManifest.imagePath,
                            prepared: false,
                        };
                    }
                    if (profile === "windows-server" && !ports.licenseAccepted(join(ports.privateRoot, "setup"))) {
                        throw new Error("hyper-v-windows-evaluation-license-not-accepted");
                    }
                    const automaticProfile = profile === "windows-server" || profile === "ubuntu-lts" ? profile : null;
                    if (!automaticProfile) throw new Error("hyper-v-base-image-profile-not-automatic");
                    const effects = ports.capturePreparation();
                    if (!effects) throw new Error("missing-provider-command:powershell");
                    const imagePath = join(globalProfileRoot, "base.vhdx");
                    if (ports.artifactIdentity(join(globalProfileRoot, "base.partial.vhdx"))
                        || ports.artifactIdentity(join(globalProfileRoot, ".acquire-work"))) {
                        throw new Error("hyper-v-base-image-artifact-owner-unknown");
                    }
                    try {
                        if (pendingPrior) {
                            const identities = await ports.retirePriorImage(globalProfileRoot, pendingPrior, acquireDeadlineAt);
                            retiredPrior = { prior: pendingPrior, identities };
                        }
                        const observation = await acquireAutomaticHyperVImage(
                            automaticProfile, globalProfileRoot, effects, acquireDeadlineAt,
                        );
                        if (ports.deadlineExpired(acquireDeadlineAt)) throw ports.deadlineError();
                        if (!observation
                            || observation.profile !== profile
                            || observation.generation !== ports.catalog[automaticProfile].generation
                            || ports.resolvePath(observation.imagePath) !== ports.resolvePath(imagePath)) {
                            throw new Error("hyper-v-base-image-acquire-invalid-result");
                        }
                        const image = ports.inspectFile(globalProfileRoot, imagePath, "hyper-v-base-image");
                        if (image.size !== observation.sizeBytes) throw new Error("hyper-v-base-image-size-mismatch");
                        if (await ports.hashFile(globalProfileRoot, imagePath, "hyper-v-base-image", acquireDeadlineAt) !== observation.sha256) {
                            throw new Error("hyper-v-base-image-hash-mismatch");
                        }
                        const manifest = hyperVImageManifest(profile, imagePath, observation, true, ports.catalog[automaticProfile], ports.preparedAt());
                        ports.assertDeadline(acquireDeadlineAt);
                        ports.publishManifest(join(globalProfileRoot, "manifest.json"), manifest);
                        if (retiredPrior) {
                            try {
                                await ports.discardPriorImage(globalProfileRoot, retiredPrior.prior, retiredPrior.identities, acquireDeadlineAt);
                            } catch { /* the committed current pair remains valid; retain backups for guarded recovery */ }
                        }
                        return {
                            kind: "resolved" as const,
                            params: { ...input, profile, image: imagePath, baseImageSha256: observation.sha256, baseImageGeneration: observation.generation, diskMaxBytes: observation.virtualSizeBytes },
                            imagePath,
                            prepared: !observation.reused,
                        };
                    } catch (error) {
                        if (retiredPrior) {
                            try { await ports.recoverPriorImage(globalProfileRoot, acquireDeadlineAt); }
                            catch { /* preserve an uncertain new base and the recoverable prior pair */ }
                        }
                        throw error;
                    }
                }

                if (!/\.vhdx$/i.test(sourceImage)) throw new Error("hyper-v-base-image-format-unsupported");
                const effects = ports.capturePreparation();
                if (!effects) throw new Error("missing-provider-command:powershell");
                const imagePath = join(ownerProfileRoot, "base.vhdx");
                const { observation, prepared } = await prepareImportedHyperVImage(profile, sourceImage, ownerProfileRoot, effects, deadlineAt);
                return {
                    kind: "resolved" as const,
                    params: { ...input, profile, image: imagePath, baseImageSha256: observation.sha256, baseImageGeneration: observation.generation, diskMaxBytes: observation.virtualSizeBytes },
                    imagePath,
                    prepared,
                };
            }, {
                waitMs: ports.remainingTimeout(deadlineAt, ports.limits.lockWaitMs),
                staleMs: HYPER_V_IMAGE_LOCK_STALE_MS,
            });
        } catch (error) {
            if (ports.isDeadlineError(error)) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            const publicDetail = ports.boundedErrorDetail(error, "hyper-v-base-image-prepare-failed");
            const licenseMissing = detail.includes("hyper-v-windows-evaluation-license-not-accepted");
            const automaticUnsupported = detail.includes("hyper-v-base-image-profile-not-automatic");
            const notPrepared = !sourceImage && (detail.includes("ENOENT") || detail.includes("not found") || detail.includes("manifest-missing") || automaticUnsupported);
            const profileConflict = detail.includes("hyper-v-base-image-profile-conflict") || detail.includes("hyper-v-base-image-unmanaged-existing")
                || detail.includes("hyper-v-base-image-artifact-owner-unknown");
            return {
                kind: "refused",
                reason: licenseMissing ? "license-required" : notPrepared ? "not-prepared" : profileConflict ? "profile-conflict" : "preparation-failed",
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

    return { resolveForCreate };
}
