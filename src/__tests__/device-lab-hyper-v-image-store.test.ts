import { createHash } from "crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
    cleanupIncompleteHyperVImageArtifacts,
    hyperVImageProfile,
    hyperVImageProfileRoot,
    hyperVImageRoot,
    hyperVOwnerImageProfileRoot,
    readHyperVImageManifestMetadata,
    resolveHyperVImageForCreate,
} from "../device-lab/broker/hyper-v/image-store.js";
import { HYPER_V_IMAGE_CATALOG } from "../device-lab/hyper-v-images.js";

describe("Hyper-V image store module", () => {
    it("uses Canonical's Hyper-V documented VMDK source instead of the QEMU QCOW image", () => {
        const ubuntu = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];

        expect(ubuntu.sourceUrl).toContain("cloud-images.ubuntu.com/releases/noble/release-20260801/");
        expect(ubuntu.sourceUrl).toMatch(/server-cloudimg-amd64\.vmdk$/);
        expect(ubuntu.sourceUrl).not.toContain("azure.vhd");
        expect(ubuntu.sourceUrl).not.toContain("ubuntu-desktop-hyperv");
        expect(ubuntu.sourceFormat).toBe("vmdk");
        expect(ubuntu.sourceSha256).toBe("8fdafa961e9de4f26747e89a122093ed772565e80bddb45bc39e2eb57df07988");
        expect(ubuntu.virtualSizeBytes).toBe(32 * 1024 * 1024 * 1024);
        expect(ubuntu.generation).toBe(2);
    });

    it("keeps image cache paths below the injected private root", () => {
        const privateRoot = "/private/device-broker";

        expect(hyperVImageRoot(privateRoot)).toBe("/private/device-broker/images/hyper-v");
        expect(hyperVImageProfileRoot(privateRoot, "ubuntu-lts"))
            .toBe("/private/device-broker/images/hyper-v/ubuntu-lts");
        expect(hyperVOwnerImageProfileRoot(privateRoot, "owner-a", "windows-11"))
            .toBe("/private/device-broker/owners/owner-a/images/hyper-v/windows-11");
    });

    it("accepts only supported image profiles", () => {
        expect(hyperVImageProfile("windows-11")).toBe("windows-11");
        expect(hyperVImageProfile("windows-server")).toBe("windows-server");
        expect(hyperVImageProfile("ubuntu-lts")).toBe("ubuntu-lts");
        expect(hyperVImageProfile("custom")).toBeNull();
    });

    it("does not import the broker facade", () => {
        const source = readFileSync(
            new URL("../device-lab/broker/hyper-v/image-store.ts", import.meta.url),
            "utf8",
        );

        expect(source).not.toContain("device-lab-broker");
    });

    it("preserves a regular retry-cache candidate for checksum verification on the next attempt", () => {
        const profileRoot = join(tmpdir(), `ccc-hyper-v-image-cleanup-${process.pid}-${Date.now()}`);
        mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
        writeFileSync(join(profileRoot, "source.vmdk"), "verified-source");
        writeFileSync(join(profileRoot, "base.partial.vhdx"), "partial-image");

        try {
            cleanupIncompleteHyperVImageArtifacts(profileRoot);

            expect(readFileSync(join(profileRoot, "source.vmdk"), "utf8")).toBe("verified-source");
            expect(existsSync(join(profileRoot, "base.partial.vhdx"))).toBe(false);
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
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
            const sourceArchivePath = join(profileRoot, "source.vmdk");
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

    it("retains the bounded cloud image and removes transient work after committing an automatic image manifest", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-image-success-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const sourceArchivePath = join(profileRoot, "source.vmdk");
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
                    run: async () => {
                        mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
                        writeFileSync(join(profileRoot, ".acquire-work", "extracted.vhdx"), "temporary");
                        writeFileSync(imagePath, image);
                        writeFileSync(sourceArchivePath, "verified-source");
                        return {
                            mode: "exec",
                            provider: "hyper-v",
                            status: 0,
                            stdout: JSON.stringify({
                                ok: true,
                                profile: "ubuntu-lts",
                                imagePath,
                                sha256,
                                sizeBytes: image.length,
                                virtualSizeBytes: 32 * 1024 * 1024 * 1024,
                                vhdType: "Dynamic",
                                generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
                                reused: false,
                            }),
                            stderr: "",
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

    it("rejects a cached Ubuntu image produced by the pre-native-finalization catalog", () => {
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
            catalogId: "canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-20260801-v2",
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
            expect(catalog.catalogId).toBe("canonical-ubuntu-24.04-lts-server-cloudimg-vmdk-hyper-v-20260801-v2");
            expect(() => readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts"))
                .toThrow("hyper-v-base-image-manifest-provenance-mismatch");
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("rejects an automatic provider observation whose generation differs from the catalog", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-generation-observation-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const image = Buffer.from("automatic-hyper-v-image");
        const sha256 = createHash("sha256").update(image).digest("hex");

        try {
            const result = await resolveHyperVImageForCreate(
                "0123456789abcdef",
                { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
                {},
                {
                    cwd: privateRoot,
                    privateRoot,
                    resolveExecutable: () => "powershell.exe",
                    run: async () => {
                        mkdirSync(profileRoot, { recursive: true });
                        writeFileSync(imagePath, image);
                        return {
                            mode: "exec",
                            provider: "hyper-v",
                            status: 0,
                            stdout: JSON.stringify({
                                ok: true,
                                profile: "ubuntu-lts",
                                imagePath,
                                sha256,
                                sizeBytes: image.length,
                                virtualSizeBytes: 32 * 1024 * 1024 * 1024,
                                vhdType: "Dynamic",
                                generation: 1,
                                reused: false,
                            }),
                            stderr: "",
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
                detail: "hyper-v-base-image-acquire-invalid-result",
            }));
            expect(existsSync(imagePath)).toBe(false);
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });
});
