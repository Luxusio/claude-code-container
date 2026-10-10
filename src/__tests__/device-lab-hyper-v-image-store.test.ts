import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { createHash } from "crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { describe, expect, it, vi } from "vitest";
import {
    cleanupIncompleteHyperVImageArtifacts,
    hyperVImageProfile,
    hyperVImageProfileRoot,
    hyperVImageRoot,
    hyperVOwnerImageProfileRoot,
    inspectHyperVUbuntuImageCache,
    readHyperVImageManifestMetadata,
    resolveHyperVImageForCreate,
    type HyperVImageCommandResult,
    type HyperVImageStoreRuntime,
    type HyperVUbuntuImageCacheInspection,
} from "@ccc/device-lab/device-lab/broker/hyper-v/image-store.js";
import { createHyperVImagePreparation } from "@ccc/device-lab/device-lab/application/hyper-v-image-preparation.js";
import type { HyperVImagePreparationPorts } from "@ccc/device-lab/device-lab/ports/hyper-v-image-preparation.js";
import { HYPER_V_IMAGE_CATALOG } from "@ccc/device-lab/device-lab/hyper-v-images.js";
import { HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP, type HyperVWindowsExecutionRequest } from "@ccc/hyper-v/index.js";

// Compile-only controls: import cleanup and automatic finalization are required capabilities,
// and synchronous publication/root admission cannot silently accept asynchronous substitutions.
function imagePreparationCapabilityContracts(ports: HyperVImagePreparationPorts): void {
    createHyperVImagePreparation(ports);
    const { dismount: _dismount, ...withoutDismount } = ports;
    // @ts-expect-error Detaching an owner-staged mounted image is mandatory.
    createHyperVImagePreparation(withoutDismount);
    const { finalizeAcquisition: _finalize, ...withoutFinalizer } = ports;
    // @ts-expect-error Automatic acquisition needs its guarded native finalizer.
    createHyperVImagePreparation(withoutFinalizer);
    // @ts-expect-error Publication must complete before the application reports success.
    const asynchronousPublication: HyperVImagePreparationPorts["publishManifest"] = async () => undefined;
    // @ts-expect-error Root admission must finish before the preparation lock is entered.
    const asynchronousRootAdmission: HyperVImagePreparationPorts["ensurePreparationRoot"] = async () => undefined;
    void [_dismount, _finalize, asynchronousPublication, asynchronousRootAdmission];
}
void imagePreparationCapabilityContracts;

// Pass-through record of every hash the image store starts, so the readiness cache inspection
// can prove it never hashes the multi-gigabyte base image.
const hashing = vi.hoisted(() => ({ algorithms: [] as string[] }));
vi.mock("crypto", async (importOriginal) => {
    const actual = await importOriginal<typeof import("crypto")>();
    return {
        ...actual,
        createHash: (...args: Parameters<typeof actual.createHash>) => {
            hashing.algorithms.push(args[0]);
            return actual.createHash(...args);
        },
    };
});

function automaticUbuntuStep(
    command: Parameters<HyperVImageStoreRuntime["run"]>[0],
    profileRoot: string,
    image: Buffer,
    onPrepare?: () => void,
    finalizeOverrides: Record<string, unknown> = {},
): HyperVImageCommandResult {
    const imagePath = join(profileRoot, "base.vhdx");
    const partialPath = join(profileRoot, "base.partial.vhdx");
    const sourceVhdPath = join(profileRoot, ".acquire-work", "converted.normalized.fixed.vhd");
    const success = (operation: HyperVWindowsExecutionRequest["operation"], items: readonly unknown[] = []) => ({
        ...command, status: 0, stderr: "",
        stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }),
    });
    if (command.args.at(-1) === HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP) {
        const envelope = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
        const request = JSON.parse(envelope.input) as HyperVWindowsExecutionRequest;
        if (request.operation === "Convert-VHD") {
            expect(request).toMatchObject({ sourcePath: sourceVhdPath, destinationPath: partialPath, vhdType: "Dynamic" });
            writeFileSync(partialPath, image);
            return success(request.operation);
        }
        if (request.operation === "Resize-VHD") return success(request.operation);
        if (request.operation === "Get-VHD") {
            const file = readFileSync(request.path);
            return success(request.operation, [{
                path: request.path,
                vhdFormat: request.path === sourceVhdPath ? "VHD" : "VHDX",
                vhdType: request.path === sourceVhdPath ? "Fixed" : "Dynamic",
                parentPath: null,
                virtualSizeBytes: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes,
                fileSizeBytes: file.length,
            }]);
        }
        throw new Error(`unexpected typed image operation: ${request.operation}`);
    }
    const script = Buffer.from(command.input || "", "base64").toString("utf8");
    const marker = (observation: unknown) => `CCC_HYPER_V_RESULT_B64:${Buffer.from(JSON.stringify(observation)).toString("base64")}`;
    if (script.includes("function Save-BoundedDownload")) {
        onPrepare?.();
        mkdirSync(dirname(sourceVhdPath), { recursive: true });
        writeFileSync(sourceVhdPath, image);
        writeFileSync(join(profileRoot, "source.qcow2"), "verified-source");
        return {
            ...command, status: 0, stderr: "",
            stdout: marker({ ok: true, profile: "ubuntu-lts", imagePath, partialPath, sourceVhdPath,
                sourceVhdSha256: createHash("sha256").update(image).digest("hex"),
                sourceVirtualSizeBytes: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes,
                qemuSha256: "a".repeat(64) }),
        };
    }
    if (script.includes("$ExpectedPartialHash =")) {
        writeFileSync(imagePath, readFileSync(partialPath));
        return {
            ...command, status: 0, stderr: "",
            stdout: marker({ ok: true, profile: "ubuntu-lts", imagePath,
                sha256: createHash("sha256").update(image).digest("hex"), sizeBytes: image.length,
                virtualSizeBytes: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes,
                vhdType: "Dynamic", generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, reused: false,
                ...finalizeOverrides }),
        };
    }
    throw new Error("unexpected automatic image command");
}

describe("Hyper-V image store module", () => {
    it("uses Canonical's generic bootable QCOW2 source instead of its Azure-only VHD", () => {
        const ubuntu = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];

        expect(ubuntu.sourceUrl).toContain("cloud-images.ubuntu.com/releases/noble/release-20260725/");
        expect(ubuntu.sourceUrl).toMatch(/server-cloudimg-amd64\.img$/);
        expect(ubuntu.sourceUrl).not.toContain("-azure.");
        expect(ubuntu.sourceUrl).not.toContain("ubuntu-desktop-hyperv");
        expect(ubuntu.sourceFormat).toBe("qcow2");
        expect(ubuntu.sourceSha256).toBe("d1940f7d69d343355e183dff1e08a59852d32e7309baa7a4bad8365b11b005ac");
        expect(ubuntu.virtualSizeBytes).toBe(32 * 1024 * 1024 * 1024);
        expect(ubuntu.generation).toBe(2);
    });

    it("keeps image cache paths below the injected private root", () => {
        const privateRoot = "/private/device-broker";

        expect(hyperVImageRoot(privateRoot)).toBe(join(privateRoot, "images/hyper-v"));
        expect(hyperVImageProfileRoot(privateRoot, "ubuntu-lts"))
            .toBe(join(privateRoot, "images/hyper-v/ubuntu-lts"));
        expect(hyperVOwnerImageProfileRoot(privateRoot, "owner-a", "windows-11"))
            .toBe(join(privateRoot, "owners/owner-a/images/hyper-v/windows-11"));
    });

    it("accepts only supported image profiles", () => {
        expect(hyperVImageProfile("windows-11")).toBe("windows-11");
        expect(hyperVImageProfile("windows-server")).toBe("windows-server");
        expect(hyperVImageProfile("ubuntu-lts")).toBe("ubuntu-lts");
        expect(hyperVImageProfile("custom")).toBeNull();
    });

    it("does not import the broker facade", () => {
        const source = readFileSync(
            new URL("../../packages/device-lab/src/device-lab/broker/hyper-v/image-store.ts", import.meta.url),
            "utf8",
        );

        expect(source).not.toContain("device-lab-broker");
    });

    it("preserves a regular retry-cache candidate for checksum verification on the next attempt", () => {
        const profileRoot = join(tmpdir(), `ccc-hyper-v-image-cleanup-${process.pid}-${Date.now()}`);
        mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
        writeFileSync(join(profileRoot, "source.qcow2"), "verified-source");
        writeFileSync(join(profileRoot, "base.partial.vhdx"), "partial-image");

        try {
            cleanupIncompleteHyperVImageArtifacts(profileRoot);

            expect(readFileSync(join(profileRoot, "source.qcow2"), "utf8")).toBe("verified-source");
            expect(existsSync(join(profileRoot, "base.partial.vhdx"))).toBe(false);
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
        } finally {
            rmSync(profileRoot, { recursive: true, force: true });
        }
    });

    it("removes legacy Azure VHD caches while preserving the current QCOW2 source", () => {
        const profileRoot = join(tmpdir(), `ccc-hyper-v-image-cache-migration-${process.pid}-${Date.now()}`);
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(join(profileRoot, "source.vmdk"), "legacy-source");
        writeFileSync(join(profileRoot, "source.vhd.tar.gz"), "legacy-azure-vhd");
        writeFileSync(join(profileRoot, "source.qcow2"), "current-source");

        try {
            cleanupIncompleteHyperVImageArtifacts(profileRoot);

            expect(existsSync(join(profileRoot, "source.vmdk"))).toBe(false);
            expect(existsSync(join(profileRoot, "source.vhd.tar.gz"))).toBe(false);
            expect(readFileSync(join(profileRoot, "source.qcow2"), "utf8")).toBe("current-source");
        } finally {
            rmSync(profileRoot, { recursive: true, force: true });
        }
    });

    const invalidCacheKinds = process.platform === "win32"
        ? (["directory", "hardlink", "empty", "oversized"] as const)
        : (["directory", "symlink", "hardlink", "empty", "oversized"] as const);

    it.each(invalidCacheKinds)(
        "removes an invalid %s retry cache during failure cleanup",
        (kind) => {
            const root = join(tmpdir(), `ccc-hyper-v-invalid-cache-${kind}-${process.pid}-${Date.now()}`);
            const profileRoot = join(root, "profile");
            const sourceArchivePath = join(profileRoot, "source.qcow2");
            mkdirSync(profileRoot, { recursive: true });

            try {
                if (kind === "directory") {
                    mkdirSync(sourceArchivePath);
                    writeFileSync(join(sourceArchivePath, "unexpected"), "content");
                } else if (kind === "symlink") {
                    const target = join(root, "outside.zip");
                    writeFileSync(target, "outside");
                    symlinkSync(target, sourceArchivePath);
                } else if (kind === "hardlink") {
                    const target = join(profileRoot, "other.zip");
                    writeFileSync(target, "linked");
                    linkSync(target, sourceArchivePath);
                } else if (kind === "oversized") {
                    writeFileSync(sourceArchivePath, "oversized");
                    truncateSync(sourceArchivePath, (6 * 1024 * 1024 * 1024) + 1);
                } else {
                    writeFileSync(sourceArchivePath, "");
                }

                cleanupIncompleteHyperVImageArtifacts(profileRoot);

                expect(existsSync(sourceArchivePath)).toBe(false);
                if (kind === "symlink") {
                    expect(readFileSync(join(root, "outside.zip"), "utf8")).toBe("outside");
                }
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it("retains the bounded cloud image and removes owned work after committing an automatic image manifest", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-image-success-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const sourceArchivePath = join(profileRoot, "source.qcow2");
        const image = Buffer.from("automatic-hyper-v-image");
        const sha256 = createHash("sha256").update(image).digest("hex");
        mkdirSync(profileRoot, { recursive: true });

        try {
            const result = await resolveHyperVImageForCreate(
                "0123456789abcdef",
                { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
                {},
                {
                    cwd: privateRoot,
                    privateRoot,
                    resolveExecutable: () => "powershell.exe",
                    run: async (command) => automaticUbuntuStep(command, profileRoot, image),
                    limits: {
                        acquireTimeoutMs: 60_000,
                        prepareTimeoutMs: 60_000,
                        lockWaitMs: 60_000,
                        commandOutputBytes: 64 * 1024,
                    },
                },
            );

            expect(result).toEqual(expect.objectContaining({ ok: true, prepared: true }));
            const manifestText = readFileSync(join(profileRoot, "manifest.json"), "utf8");
            expect(manifestText).toContain(sha256);
            expect(manifestText).toContain(HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceSha256);
            expect(readFileSync(sourceArchivePath, "utf8")).toBe("verified-source");
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("does not retry obsolete EFI mutation failures through elevation", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-image-elevated-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const sourceArchivePath = join(profileRoot, "source.qcow2");
        const commands: Array<{ executable?: string }> = [];

        try {
            const result = await resolveHyperVImageForCreate(
                "0123456789abcdef",
                { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
                {},
                {
                    cwd: privateRoot,
                    privateRoot,
                    resolveExecutable: () => "provider-powershell.exe",
                    run: async (providerCommand) => {
                        commands.push(providerCommand);
                        mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
                        writeFileSync(join(profileRoot, ".acquire-work", "converted.qemu.fixed.vhd"), "temporary");
                        writeFileSync(sourceArchivePath, "verified-source");
                        return {
                            mode: "exec",
                            provider: "hyper-v",
                            status: 1,
                            stdout: "",
                            stderr: "hyper-v-base-image-efi-fallback-failed",
                        };
                    },
                    limits: {
                        acquireTimeoutMs: 60_000,
                        prepareTimeoutMs: 60_000,
                        lockWaitMs: 60_000,
                        commandOutputBytes: 64 * 1024,
                    },
                },
            );

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "hyper-v-base-image-prepare-failed",
            }));
            expect(commands).toHaveLength(1);
            expect(commands[0].executable).toBe("provider-powershell.exe");
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
            expect(readdirSync(profileRoot).some((name) => name.startsWith(".work-uncertain-"))).toBe(true);
            expect(readFileSync(sourceArchivePath, "utf8")).toBe("verified-source");
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("rejects an automatic image manifest whose generation differs from the catalog", () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-generation-manifest-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, "automatic-hyper-v-image");
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: catalog.licenseId,
            generation: 1,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: "a".repeat(64),
            sizeBytes: 23,
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));

        try {
            expect(() => readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts"))
                .toThrow("hyper-v-base-image-manifest-provenance-mismatch");
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("rejects an automatic image manifest produced from a different catalog source checksum", () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-checksum-manifest-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        const image = Buffer.from("automatic-hyper-v-image");
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, image);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: "f".repeat(64),
            licenseId: catalog.licenseId,
            generation: catalog.generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(image).digest("hex"),
            sizeBytes: image.length,
            virtualSizeBytes: catalog.virtualSizeBytes,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));

        try {
            expect(() => readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts"))
                .toThrow("hyper-v-base-image-manifest-provenance-mismatch");
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("reacquires the immediately previous Ubuntu catalog after adding native content verification", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-old-finalization-manifest-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        const image = Buffer.from("pre-native-finalization-image");
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, image);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: "canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-native-vhdx-20260725-v1",
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: catalog.licenseId,
            generation: catalog.generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(image).digest("hex"),
            sizeBytes: image.length,
            virtualSizeBytes: catalog.virtualSizeBytes,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));

        try {
            expect(catalog.catalogId).toBe("canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-native-vhdx-20260725-v2");
            let acquisitions = 0;
            const replacement = Buffer.from("content-verified-native-vhdx");
            const replacementSha256 = createHash("sha256").update(replacement).digest("hex");
            const result = await resolveHyperVImageForCreate(
                "0123456789abcdef",
                { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
                {},
                {
                    cwd: privateRoot,
                    privateRoot,
                    resolveExecutable: () => "powershell.exe",
                    run: async (command) => automaticUbuntuStep(command, profileRoot, replacement, () => {
                        acquisitions += 1;
                        expect(existsSync(imagePath)).toBe(false);
                        expect(existsSync(join(profileRoot, "manifest.json"))).toBe(false);
                    }),
                    limits: {
                        acquireTimeoutMs: 60_000,
                        prepareTimeoutMs: 60_000,
                        lockWaitMs: 60_000,
                        commandOutputBytes: 64 * 1024,
                    },
                },
            );
            expect(acquisitions).toBe(1);
            expect(result).toEqual(expect.objectContaining({ ok: true, prepared: true }));
            expect(readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts")).toEqual(expect.objectContaining({
                catalogId: catalog.catalogId,
                sha256: replacementSha256,
            }));
            expect(existsSync(join(profileRoot, ".base-prior-recovery.vhdx"))).toBe(false);
            expect(existsSync(join(profileRoot, ".manifest-prior-recovery.json"))).toBe(false);
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("rejects an automatic provider observation whose generation differs from the catalog", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-generation-observation-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const image = Buffer.from("automatic-hyper-v-image");

        try {
            const result = await resolveHyperVImageForCreate(
                "0123456789abcdef",
                { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
                {},
                {
                    cwd: privateRoot,
                    privateRoot,
                    resolveExecutable: () => "powershell.exe",
                    run: async (command) => automaticUbuntuStep(command, profileRoot, image, undefined, { generation: 1 }),
                    limits: {
                        acquireTimeoutMs: 60_000,
                        prepareTimeoutMs: 60_000,
                        lockWaitMs: 60_000,
                        commandOutputBytes: 64 * 1024,
                    },
                },
            );

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "hyper-v-base-image-prepare-failed",
                detail: "hyper-v-base-image-acquire-invalid-result",
            }));
            expect(readFileSync(imagePath)).toEqual(image);
            expect(existsSync(join(profileRoot, "manifest.json"))).toBe(false);
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });
});

describe("Hyper-V ubuntu-lts image cache inspection", () => {
    const ownerId = "0123456789abcdef";
    const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
    const image = Buffer.from("cached-ubuntu-lts-image");
    const imageSha256 = createHash("sha256").update(image).digest("hex");
    const priorCatalogId = "canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-native-vhdx-20260725-v1";

    function automaticManifest(profileRoot: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: catalog.licenseId,
            generation: catalog.generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath: join(profileRoot, "base.vhdx"),
            sha256: imageSha256,
            sizeBytes: image.length,
            virtualSizeBytes: catalog.virtualSizeBytes,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
            ...overrides,
        };
    }

    function userProvidedManifest(profileRoot: string): Record<string, unknown> {
        return automaticManifest(profileRoot, {
            catalogId: "user-provided-vhdx", sourceUrl: null, sourceFormat: "vhdx", sourceSha256: null, licenseId: null,
        });
    }

    function writeCache(profileRoot: string, manifest: Record<string, unknown> | string | null, imageBytes: Buffer | null = image): void {
        mkdirSync(profileRoot, { recursive: true });
        if (imageBytes) writeFileSync(join(profileRoot, "base.vhdx"), imageBytes);
        if (manifest !== null) writeFileSync(join(profileRoot, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    }

    function treeSnapshot(root: string): Array<[string, string]> {
        if (!existsSync(root)) return [];
        return readdirSync(root, { recursive: true }).map(String).sort().map((name) => {
            const stat = lstatSync(join(root, name));
            const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file";
            const content = kind === "file" ? readFileSync(join(root, name)).toString("base64") : "";
            return [name, `${kind}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${content}`];
        });
    }

    function inspectWithoutSideEffects(privateRoot: string, owner = ownerId): HyperVUbuntuImageCacheInspection {
        const before = treeSnapshot(privateRoot);
        const existed = existsSync(privateRoot);
        hashing.algorithms.length = 0;
        const result = inspectHyperVUbuntuImageCache(privateRoot, owner);
        expect(hashing.algorithms).toEqual([]);
        expect(existsSync(privateRoot)).toBe(existed);
        expect(treeSnapshot(privateRoot)).toEqual(before);
        return result;
    }

    // What create itself decides for the same state, run after the inspection because create mutates:
    // "valid", "acquisition-required" once it starts the first acquisition command, else its detail.
    async function createDecision(privateRoot: string): Promise<string> {
        let acquisitionStarted = false;
        const created = await resolveHyperVImageForCreate(
            ownerId,
            { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
            {},
            {
                cwd: privateRoot,
                privateRoot,
                resolveExecutable: () => "powershell.exe",
                run: async (command) => {
                    acquisitionStarted = true;
                    return { ...command, status: 1, stdout: "", stderr: "" };
                },
                limits: { acquireTimeoutMs: 60_000, prepareTimeoutMs: 60_000, lockWaitMs: 60_000, commandOutputBytes: 64 * 1024 },
            },
        );
        if (acquisitionStarted) return "acquisition-required";
        return created.ok ? "valid" : String(created.detail);
    }

    function withPrivateRoot(label: string, run: (privateRoot: string) => void | Promise<void>): () => Promise<void> {
        return async () => {
            const privateRoot = join(tmpdir(), `ccc-hyper-v-cache-inspection-${label}-${process.pid}-${Date.now()}`);
            try {
                await run(privateRoot);
            } finally {
                rmSync(privateRoot, { recursive: true, force: true });
            }
        };
    }

    it("reports a metadata-valid shared automatic image as a global cache hit", withPrivateRoot("global", (privateRoot) => {
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        writeCache(profileRoot, automaticManifest(profileRoot));

        expect(inspectWithoutSideEffects(privateRoot)).toEqual({ state: "valid", source: "global" });
    }));

    it("prefers the owner's user-provided image, as create does, even beside a shared-cache conflict", withPrivateRoot("owner", async (privateRoot) => {
        const ownerRoot = hyperVOwnerImageProfileRoot(privateRoot, ownerId, "ubuntu-lts");
        writeCache(ownerRoot, userProvidedManifest(ownerRoot));
        writeCache(hyperVImageProfileRoot(privateRoot, "ubuntu-lts"), null);

        expect(inspectWithoutSideEffects(privateRoot)).toEqual({ state: "valid", source: "owner" });
        expect(await createDecision(privateRoot)).toBe("valid");
    }));

    it("does not let an owner image hide a prior-catalog pair create cannot restore first", withPrivateRoot("owner-recovery", async (privateRoot) => {
        const ownerRoot = hyperVOwnerImageProfileRoot(privateRoot, ownerId, "ubuntu-lts");
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        writeCache(ownerRoot, userProvidedManifest(ownerRoot));
        writeCache(profileRoot, null, null);
        writeFileSync(join(profileRoot, ".manifest-prior-recovery.json"), JSON.stringify(automaticManifest(profileRoot, { catalogId: priorCatalogId })));

        expect(inspectWithoutSideEffects(privateRoot)).toEqual({ state: "conflict", code: "hyper-v-base-image-profile-conflict" });
        expect(await createDecision(privateRoot)).toBe("hyper-v-base-image-profile-conflict");
    }));

    it("keeps a valid current pair valid beside backups a finished retirement retained", withPrivateRoot("retained", async (privateRoot) => {
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        writeCache(profileRoot, automaticManifest(profileRoot));
        writeFileSync(join(profileRoot, ".manifest-prior-recovery.json"), JSON.stringify(automaticManifest(profileRoot, { catalogId: priorCatalogId })));
        writeFileSync(join(profileRoot, ".base-prior-recovery.vhdx"), image);

        expect(inspectWithoutSideEffects(privateRoot)).toEqual({ state: "valid", source: "global" });
        expect(await createDecision(privateRoot)).toBe("valid");
    }));

    it("ignores an owner cache for an owner id the broker could not have issued", withPrivateRoot("owner-id", (privateRoot) => {
        const ownerRoot = hyperVOwnerImageProfileRoot(privateRoot, "not-a-broker-owner", "ubuntu-lts");
        writeCache(ownerRoot, userProvidedManifest(ownerRoot));

        expect(inspectWithoutSideEffects(privateRoot, "not-a-broker-owner")).toEqual({ state: "acquisition-required" });
    }));

    it("leaves the full-hash check to create instead of reading the cached image", withPrivateRoot("hash", async (privateRoot) => {
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        writeCache(profileRoot, automaticManifest(profileRoot, { sha256: "0".repeat(64) }));

        expect(inspectWithoutSideEffects(privateRoot)).toEqual({ state: "valid", source: "global" });
        const created = await resolveHyperVImageForCreate(
            ownerId,
            { backend: "linux-vm", dryRun: true, create: { profile: "ubuntu-lts" } },
            {},
            {
                cwd: privateRoot,
                privateRoot,
                resolveExecutable: () => null,
                run: async () => { throw new Error("unexpected provider command"); },
                limits: { acquireTimeoutMs: 60_000, prepareTimeoutMs: 60_000, lockWaitMs: 60_000, commandOutputBytes: 64 * 1024 },
            },
        );
        expect(created).toEqual(expect.objectContaining({ ok: false, detail: "hyper-v-base-image-hash-mismatch" }));
        // The recorder sees the store's own hashing, so its silence during inspection is meaningful.
        expect(hashing.algorithms).toContain("sha256");
    }));

    // Create retires and reacquires only the immediately previous catalog, restoring an interrupted
    // retirement first (recoverPriorAutomaticImage), so these states must reach acquisition.
    const acquisitionRequired: Array<{ name: string; setup: (privateRoot: string) => void }> = [
        { name: "no private root", setup: () => undefined },
        { name: "an empty profile root", setup: (privateRoot) => { mkdirSync(hyperVImageProfileRoot(privateRoot, "ubuntu-lts"), { recursive: true }); } },
        {
            name: "a prior-catalog manifest",
            setup: (privateRoot) => {
                const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
                writeCache(profileRoot, automaticManifest(profileRoot, { catalogId: priorCatalogId }));
            },
        },
        {
            name: "a prior-catalog retirement interrupted after its manifest moved",
            setup: (privateRoot) => {
                const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
                writeCache(profileRoot, null);
                writeFileSync(join(profileRoot, ".manifest-prior-recovery.json"), JSON.stringify(automaticManifest(profileRoot, { catalogId: priorCatalogId })));
            },
        },
        {
            name: "a fully retired prior-catalog pair awaiting recovery",
            setup: (privateRoot) => {
                const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
                writeCache(profileRoot, null, null);
                writeFileSync(join(profileRoot, ".manifest-prior-recovery.json"), JSON.stringify(automaticManifest(profileRoot, { catalogId: priorCatalogId })));
                writeFileSync(join(profileRoot, ".base-prior-recovery.vhdx"), image);
            },
        },
        {
            name: "only a retained source download",
            setup: (privateRoot) => {
                const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
                writeCache(profileRoot, null, null);
                writeFileSync(join(profileRoot, "source.qcow2"), "verified-source");
            },
        },
        {
            name: "an invalid owner manifest and no shared cache",
            setup: (privateRoot) => {
                const ownerRoot = hyperVOwnerImageProfileRoot(privateRoot, ownerId, "ubuntu-lts");
                writeCache(ownerRoot, userProvidedManifest(ownerRoot), Buffer.from("different-size"));
            },
        },
    ];

    it.each(acquisitionRequired)("requires acquisition with $name", ({ setup }) => withPrivateRoot("acquire", async (privateRoot) => {
        setup(privateRoot);

        expect(inspectWithoutSideEffects(privateRoot)).toEqual({ state: "acquisition-required" });
        expect(await createDecision(privateRoot)).toBe("acquisition-required");
    })());

    // Create refuses each of these before acquisition; createDetail is its detail where it differs from code.
    const conflicts: Array<{ name: string; code: string; createDetail?: string; setup: (profileRoot: string) => void }> = [
        {
            name: "a manifest from another catalog",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => writeCache(profileRoot, automaticManifest(profileRoot, { catalogId: "canonical-ubuntu-22.04-lts-server-cloudimg" })),
        },
        {
            name: "a current-catalog manifest with another source checksum",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => writeCache(profileRoot, automaticManifest(profileRoot, { sourceSha256: "f".repeat(64) })),
        },
        {
            name: "a current-catalog manifest whose image size differs",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => writeCache(profileRoot, automaticManifest(profileRoot), Buffer.from("resized")),
        },
        {
            name: "a user-provided manifest in the shared cache",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => writeCache(profileRoot, userProvidedManifest(profileRoot)),
        },
        {
            name: "an unparseable manifest",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => writeCache(profileRoot, "{not json"),
        },
        {
            name: "base.vhdx without a manifest",
            code: "hyper-v-base-image-unmanaged-existing",
            setup: (profileRoot) => writeCache(profileRoot, null),
        },
        {
            name: "a partial image",
            code: "hyper-v-base-image-artifact-owner-unknown",
            setup: (profileRoot) => {
                writeCache(profileRoot, null, null);
                writeFileSync(join(profileRoot, "base.partial.vhdx"), "partial-image");
            },
        },
        {
            name: "acquire work",
            code: "hyper-v-base-image-artifact-owner-unknown",
            setup: (profileRoot) => {
                mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
                writeFileSync(join(profileRoot, ".acquire-work", "converted.normalized.fixed.vhd"), "temporary");
            },
        },
        {
            name: "a prior-catalog manifest beside a partial image",
            code: "hyper-v-base-image-artifact-owner-unknown",
            setup: (profileRoot) => {
                writeCache(profileRoot, automaticManifest(profileRoot, { catalogId: priorCatalogId }));
                writeFileSync(join(profileRoot, "base.partial.vhdx"), "partial-image");
            },
        },
        {
            name: "a restorable prior-catalog retirement beside a partial image",
            code: "hyper-v-base-image-artifact-owner-unknown",
            setup: (profileRoot) => {
                writeCache(profileRoot, null);
                writeFileSync(join(profileRoot, ".manifest-prior-recovery.json"), JSON.stringify(automaticManifest(profileRoot, { catalogId: priorCatalogId })));
                writeFileSync(join(profileRoot, "base.partial.vhdx"), "partial-image");
            },
        },
        {
            name: "a prior-catalog manifest without its image",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => writeCache(profileRoot, automaticManifest(profileRoot, { catalogId: priorCatalogId }), null),
        },
        {
            name: "a prior-catalog manifest whose image size differs",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => writeCache(profileRoot, automaticManifest(profileRoot, { catalogId: priorCatalogId }), Buffer.from("resized")),
        },
        {
            name: "a prior-catalog pair beside backups of an earlier retirement",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => {
                writeCache(profileRoot, automaticManifest(profileRoot, { catalogId: priorCatalogId }));
                writeFileSync(join(profileRoot, ".manifest-prior-recovery.json"), JSON.stringify(automaticManifest(profileRoot, { catalogId: priorCatalogId })));
            },
        },
        {
            name: "only a stale prior-recovery manifest",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => {
                writeCache(profileRoot, null, null);
                writeFileSync(join(profileRoot, ".manifest-prior-recovery.json"), JSON.stringify(automaticManifest(profileRoot, { catalogId: priorCatalogId })));
            },
        },
        {
            name: "a prior-recovery manifest of another catalog",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => {
                writeCache(profileRoot, null);
                writeFileSync(join(profileRoot, ".manifest-prior-recovery.json"), JSON.stringify(automaticManifest(profileRoot, { catalogId: "canonical-ubuntu-22.04-lts-server-cloudimg" })));
            },
        },
        {
            name: "a prior-recovery manifest beside a manifest without its image",
            code: "hyper-v-base-image-profile-conflict",
            setup: (profileRoot) => {
                writeCache(profileRoot, automaticManifest(profileRoot), null);
                writeFileSync(join(profileRoot, ".manifest-prior-recovery.json"), JSON.stringify(automaticManifest(profileRoot, { catalogId: priorCatalogId })));
                writeFileSync(join(profileRoot, ".base-prior-recovery.vhdx"), image);
            },
        },
        {
            name: "a profile root that is not a directory",
            code: "hyper-v-base-image-profile-conflict",
            createDetail: "hyper-v-base-image-prepare-failed",
            setup: (profileRoot) => {
                mkdirSync(dirname(profileRoot), { recursive: true });
                writeFileSync(profileRoot, "not-a-directory");
            },
        },
        ...(process.platform === "win32" ? [] : [{
            name: "a symlinked profile root",
            code: "hyper-v-base-image-profile-conflict",
            createDetail: "hyper-v-base-image-preparation-path-symlink-rejected",
            setup: (profileRoot: string) => {
                const target = join(dirname(profileRoot), "linked-cache");
                writeCache(target, automaticManifest(profileRoot));
                directorySymlink(target, profileRoot);
            },
        }]),
    ];

    it.each(conflicts)("reports $code for $name", ({ code, createDetail, setup }) => withPrivateRoot("conflict", async (privateRoot) => {
        setup(hyperVImageProfileRoot(privateRoot, "ubuntu-lts"));

        expect(inspectWithoutSideEffects(privateRoot)).toEqual({ state: "conflict", code });
        expect(await createDecision(privateRoot)).toBe(createDetail ?? code);
    })());
});
