import type {
    HyperVAutomaticImageCatalogs, HyperVBaseImageObservation, HyperVImageNativeObservation,
    HyperVImageManifest, HyperVImageProfile, HyperVImageVhd,
} from "../domain/hyper-v-image-preparation.js";

export type HyperVImageFileIdentity = { dev: number; ino: number };
export type HyperVAutomaticArtifactIdentity = { dev: bigint; ino: bigint; directory: boolean };
export type HyperVPriorImage = { manifestBytes: Buffer; imageSha256: string; imageSize: number };
export type HyperVPriorImageIdentities = { manifest: HyperVAutomaticArtifactIdentity; image: HyperVAutomaticArtifactIdentity };
export type HyperVImagePreparedObservation =
    | { ok: true; profile: "windows-server"; imagePath: string; partialPath: string; partialSha256: string; partialSizeBytes: number }
    | { ok: true; profile: "ubuntu-lts"; imagePath: string; partialPath: string; sourceVhdPath: string; sourceVhdSha256: string; sourceVirtualSizeBytes: number; qemuSha256: string };
export type HyperVImageFinalizeRequest = {
    imageRoot: string; expectedGeneration: 2;
    expectedPartialSha256: string; expectedPartialFileId: string;
    expectedVirtualSizeBytes: number; expectedVhdType: "Dynamic" | "Fixed";
} & (
    | { profile: "windows-server" }
    | { profile: "ubuntu-lts"; expectedSourceVhdSha256: string; expectedSourceFileId: string; expectedQemuSha256: string }
);

/** Required individual native capabilities; preparation sequencing stays in the application. */
export interface HyperVImagePreparationPorts {
    cwd: string;
    privateRoot: string;
    limits: { acquireTimeoutMs: number; prepareTimeoutMs: number; lockWaitMs: number; commandOutputBytes: number };
    catalog: HyperVAutomaticImageCatalogs;
    now(): number;
    preparedAt(): string;
    imageRoot(privateRoot: string): string;
    imageProfileRoot(privateRoot: string, profile: HyperVImageProfile): string;
    ownerImageProfileRoot(privateRoot: string, ownerId: string, profile: HyperVImageProfile): string;
    joinPath(...parts: string[]): string;
    resolvePath(...parts: string[]): string;
    capturePreparation(): HyperVImagePreparationEffects | null;
    assertDeadline(deadlineAt: number): undefined;
    remainingTimeout(deadlineAt: number, limitMs: number): number;
    deadlineExpired(deadlineAt: number): boolean;
    isDeadlineError(error: unknown): boolean;
    deadlineError(): Error;
    boundedErrorCode(error: unknown, fallback: string): string;
    boundedErrorDetail(error: unknown, fallback: string): string;
    exists(path: string): boolean;
    manifestPresent(path: string): boolean;
    inspectFile(root: string, path: string, label: string): { size: number };
    hashFile(root: string, path: string, label: string, deadlineAt: number): Promise<string>;
    stageFile(projectRoot: string, path: string, destinationRoot: string, label: string, deadlineAt: number): Promise<string>;
    fileIdentity(path: string): Promise<HyperVImageFileIdentity>;
    linkFile(source: string, destination: string): Promise<void>;
    unlinkFile(path: string): Promise<void>;
    manifestTemporaryPath(root: string): string;
    writeManifestTemporary(path: string, bytes: string): Promise<HyperVImageFileIdentity>;
    publishManifest(path: string, manifest: HyperVImageManifest): undefined;
    readManifest(privateRoot: string, profile: HyperVImageProfile, root: string, allowUserProvided: boolean, deadlineAt: number): Promise<HyperVImageManifest>;
    readManifestMetadata(privateRoot: string, profile: HyperVImageProfile, root: string, allowUserProvided: boolean): HyperVImageManifest;
    ensurePreparationRoot(root: string): undefined;
    assertSafePath(path: string, label: string): undefined;
    withPreparationLock<T>(path: string, action: () => Promise<T>, options: { waitMs: number; staleMs: number }): Promise<T>;
    licenseAccepted(setupRoot: string): boolean;
    artifactIdentity(path: string): HyperVAutomaticArtifactIdentity | null;
    assertFileIdentity(path: string, expected: HyperVAutomaticArtifactIdentity, label: string): undefined;
    cleanupOwnedArtifacts(root: string, owned: Map<string, HyperVAutomaticArtifactIdentity>): undefined;
    quarantineUncertainArtifact(root: string, path: string, label: string): boolean;
    knownPriorImage(profile: HyperVImageProfile, root: string, deadlineAt: number): Promise<HyperVPriorImage | null>;
    recoverPriorImage(root: string, deadlineAt: number): Promise<void>;
    retirePriorImage(root: string, prior: HyperVPriorImage, deadlineAt: number): Promise<HyperVPriorImageIdentities>;
    discardPriorImage(root: string, prior: HyperVPriorImage, identities: HyperVPriorImageIdentities, deadlineAt: number): Promise<void>;
}

/** Captured native connection; no executable or command recipe enters the core. */
export interface HyperVImagePreparationEffects {
    getVhd(path: string, timeoutMs: () => number): Promise<HyperVImageVhd>;
    mountReadOnly(path: string, timeoutMs: () => number): Promise<void>;
    dismount(path: string, timeoutMs: number): Promise<void>;
    convertVhd(sourcePath: string, destinationPath: string, timeoutMs: number, remainingTimeout: () => number): Promise<void>;
    resizeVhd(path: string, sizeBytes: number, timeoutMs: number, remainingTimeout: () => number): Promise<void>;
    storage(root: string, path: string, readPartitionStyle: boolean, timeoutMs: number): Promise<HyperVImageNativeObservation<{readonly attached: boolean; readonly partitionStyle: string | null}>>;
    prepareAcquisition(options: {profile: "windows-server" | "ubuntu-lts"; imageRoot: string; expectedGeneration: 2}, timeoutMs: number): Promise<HyperVImageNativeObservation<HyperVImagePreparedObservation>>;
    finalizeAcquisition(options: HyperVImageFinalizeRequest, timeoutMs: number): Promise<HyperVImageNativeObservation<HyperVBaseImageObservation>>;
}
