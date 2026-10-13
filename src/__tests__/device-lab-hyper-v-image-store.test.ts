import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { createHash } from "crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { promises as fsPromises } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    inspectLargeRegularFile,
    stageLargeRegularFileFromProject,
    sha256LargeRegularFile,
    type HyperVImageCommandResult,
    type HyperVImageStoreRuntime,
    type HyperVUbuntuImageCacheInspection,
} from "@ccc/device-lab/device-lab/broker/hyper-v/image-store.js";
import { createHyperVImagePreparation } from "@ccc/device-lab/device-lab/application/hyper-v-image-preparation.js";
import type { HyperVImagePreparationEffects, HyperVImagePreparationPorts } from "@ccc/device-lab/device-lab/ports/hyper-v-image-preparation.js";
import { HYPER_V_IMAGE_CATALOG } from "@ccc/device-lab/device-lab/hyper-v-images.js";
import { HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP, type HyperVWindowsExecutionRequest } from "@ccc/hyper-v/index.js";

// Compile-only controls: import cleanup and automatic finalization are required capabilities,
// and synchronous publication/root admission cannot silently accept asynchronous substitutions.
function imagePreparationCapabilityContracts(ports: HyperVImagePreparationPorts, effects: HyperVImagePreparationEffects): void {
    createHyperVImagePreparation(ports);
    const { dismount: _dismount, ...withoutDismount } = effects;
    // @ts-expect-error Detaching an owner-staged mounted image is mandatory.
    const missingDismount: HyperVImagePreparationEffects = withoutDismount;
    const { finalizeAcquisition: _finalize, ...withoutFinalizer } = effects;
    // @ts-expect-error Automatic acquisition needs its guarded native finalizer.
    const missingFinalizer: HyperVImagePreparationEffects = withoutFinalizer;
    const { resolvePath: _resolvePath, ...withoutPathResolution } = ports;
    // @ts-expect-error Path resolution requires the native current-directory authority.
    createHyperVImagePreparation(withoutPathResolution);
    // @ts-expect-error Native path resolution must settle synchronously.
    const asynchronousPathResolution: HyperVImagePreparationPorts["resolvePath"] = async () => "image.vhdx";
    // @ts-expect-error Publication must complete before the application reports success.
    const asynchronousPublication: HyperVImagePreparationPorts["publishManifest"] = async () => undefined;
    // @ts-expect-error Root admission must finish before the preparation lock is entered.
    const asynchronousRootAdmission: HyperVImagePreparationPorts["ensurePreparationRoot"] = async () => undefined;
    void [_dismount, _finalize, _resolvePath, missingDismount, missingFinalizer, asynchronousPathResolution, asynchronousPublication, asynchronousRootAdmission];
}
void imagePreparationCapabilityContracts;

// Pass-through record of every hash the image store starts, so the readiness cache inspection
// can prove it never hashes the multi-gigabyte base image.
const hashing = vi.hoisted(() => ({ algorithms: [] as string[] }));
const windowsImageFs = vi.hoisted(() => ({ enabled: false, tracking: false, afterLstat: null as null | ((path: string, bigint: boolean) => void), target: "", fault: "none", opens: 0, live: new Map<number, boolean>() }));
vi.mock("fs", async importOriginal => {
    const actual = await importOriginal<typeof import("fs")>();
    const metadata = (stat: any, pathname: boolean, fresh = false) => {
        const bigint = typeof stat.ino === "bigint";
        const inode = BigInt(stat.ino) + 2n ** 60n + (fresh && windowsImageFs.fault === "inode" ? 1n : 0n);
        const volume = 574283787n + (fresh && windowsImageFs.fault === "volume" ? 1n : 0n);
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: bigint ? (pathname ? 0n : volume) : Number(pathname ? 0n : volume), ino: bigint ? inode : Number(inode) });
    };
    return { ...actual,
        openSync: (...args: Parameters<typeof actual.openSync>) => {
            const fresh = windowsImageFs.enabled && String(args[0]) === windowsImageFs.target && ++windowsImageFs.opens >= 2;
            if (fresh && windowsImageFs.fault === "open") throw Object.assign(new Error("fresh open denied"), { code: "EACCES" });
            const fd = actual.openSync(...args);
            if (windowsImageFs.enabled || windowsImageFs.tracking) windowsImageFs.live.set(fd, fresh);
            return fd;
        },
        fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
            const stat = actual.fstatSync(...args);
            return windowsImageFs.enabled ? metadata(stat, false, windowsImageFs.live.get(args[0])) : stat;
        },
        lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
            const stat = actual.lstatSync(...args);
            windowsImageFs.afterLstat?.(String(args[0]), typeof stat?.ino === "bigint");
            return windowsImageFs.enabled ? metadata(stat, true) : stat;
        },
        closeSync: (fd: number) => { actual.closeSync(fd); windowsImageFs.live.delete(fd); },
    };
});
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
    for (const fault of ["growth", "empty", "replacement"] as const) it.skipIf(fault === "growth" && process.platform === "win32")(`retains the initial regular-image admission during synchronous inspection (${fault})`, () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-image-admission-sync-"));
        const source = join(root, "source.vhdx"), retained = join(root, "retained.vhdx"), bytes = Buffer.from("original admitted image");
        writeFileSync(source, bytes);
        let mutated = false;
        windowsImageFs.tracking = true;
        windowsImageFs.afterLstat = (path, bigint) => {
            if (path !== source || !bigint || mutated) return;
            mutated = true;
            if (fault === "replacement") { renameSync(source, retained); writeFileSync(source, bytes); }
            else truncateSync(source, fault === "empty" ? 0 : 64 * 1024 ** 3 + 1);
        };
        try {
            expect(() => inspectLargeRegularFile(root, source, "admission")).toThrow();
            expect(mutated).toBe(true);
            expect(windowsImageFs.live.size).toBe(0);
            if (fault === "replacement") expect(readFileSync(retained)).toEqual(bytes);
            expect(existsSync(source)).toBe(true);
        } finally { windowsImageFs.afterLstat = null; windowsImageFs.tracking = false; rmSync(root, { recursive: true, force: true }); }
    });

    for (const [operation, fault] of [
        ["stage", "growth"], ["stage", "empty"], ["stage", "replacement"],
        ["hash", "growth"], ["hash", "empty"], ["hash", "replacement"],
    ] as const) it.skipIf(fault === "growth" && process.platform === "win32")(`refuses changed initial admission before ${operation} source I/O (${fault})`, async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-image-admission-async-"));
        const source = join(root, "source.vhdx"), retained = join(root, "retained.vhdx"), destination = join(root, "staging"), bytes = Buffer.from("original admitted image");
        writeFileSync(source, bytes);
        const realLstat = fsPromises.lstat.bind(fsPromises), realOpen = fsPromises.open.bind(fsPromises);
        const live = new Set<Awaited<ReturnType<typeof fsPromises.open>>>();
        let mutated = false, reads = 0, destinationOpens = 0;
        vi.spyOn(fsPromises, "lstat").mockImplementation((async (...args: Parameters<typeof fsPromises.lstat>) => {
            const stat = await realLstat(...args);
            if (String(args[0]) === source && typeof stat?.ino === "bigint" && !mutated) {
                mutated = true;
                if (fault === "replacement") { renameSync(source, retained); writeFileSync(source, bytes); }
                else truncateSync(source, fault === "empty" ? 0 : 64 * 1024 ** 3 + 1);
            }
            return stat;
        }) as typeof fsPromises.lstat);
        vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
            if (String(args[0]).startsWith(destination)) destinationOpens++;
            const handle = await realOpen(...args); live.add(handle);
            const close = handle.close.bind(handle);
            vi.spyOn(handle, "close").mockImplementation(async () => { await close(); live.delete(handle); });
            if (String(args[0]) === source) vi.spyOn(handle, "read").mockImplementation(async () => { reads++; throw new Error("unexpected source read"); });
            return handle;
        });
        try {
            const pending = operation === "stage" ? stageLargeRegularFileFromProject(root, source, destination, "admission") : sha256LargeRegularFile(root, source, "admission");
            await expect(pending).rejects.toThrow();
            expect(mutated).toBe(true);
            expect(reads).toBe(0);
            expect(destinationOpens).toBe(0);
            expect(existsSync(destination)).toBe(false);
            expect(live.size).toBe(0);
            if (fault === "replacement") expect(readFileSync(retained)).toEqual(bytes);
            expect(existsSync(source)).toBe(true);
        } finally { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
    });
    it.skipIf(process.platform === "win32")("refuses a real regular-to-FIFO replacement before image inspection opens its read descriptor", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-hyper-v-image-fifo-"));
        const source = fileURLToPath(new URL("../../packages/device-lab/src/device-lab/broker/hyper-v/image-store.ts", import.meta.url));
        try {
            const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
                import fs from 'node:fs';
                import { execFileSync } from 'node:child_process';
                import { syncBuiltinESMExports } from 'node:module';
                import { join } from 'node:path';
                import { pathToFileURL } from 'node:url';
                const { inspectLargeRegularFile } = await import(pathToFileURL(process.argv[1]).href);
                const root = process.argv[2], image = join(root, 'image.vhdx'), retained = join(root, 'retained.vhdx');
                fs.writeFileSync(image, 'original image bytes');
                const open = fs.openSync.bind(fs), close = fs.closeSync.bind(fs);
                const live = new Set();
                let sourceOpens = 0, refused = false;
                fs.openSync = (...args) => {
                    if (String(args[0]) === image && ++sourceOpens === 3) {
                        fs.renameSync(image, retained);
                        execFileSync('mkfifo', [image]);
                    }
                    const fd = open(...args); live.add(fd); return fd;
                };
                fs.closeSync = fd => { close(fd); live.delete(fd); };
                syncBuiltinESMExports();
                try { inspectLargeRegularFile(root, image, 'image-probe'); }
                catch { refused = true; }
                console.log(JSON.stringify({ refused, live: live.size, swapped: sourceOpens === 3, fifoRetained: fs.lstatSync(image).isFIFO(), bytes: fs.readFileSync(retained, 'utf8') }));
            `, source, root], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
            expect(child.error, child.stderr).toBeUndefined();
            expect(child.status, child.stderr).toBe(0);
            expect(JSON.parse(child.stdout.trim())).toEqual({ refused: true, live: 0, swapped: true, fifoRetained: true, bytes: "original image bytes" });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it("imports relative project/source paths through native resolution and retains image safety boundaries", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-hyper-v-relative-import-"));
        const projectRoot = join(root, "project"), privateRoot = join(root, "private");
        const ownerId = "0123456789abcdef";
        const profileRoot = hyperVOwnerImageProfileRoot(privateRoot, ownerId, "windows-11");
        const imagePath = join(profileRoot, "base.vhdx"), manifestPath = join(profileRoot, "manifest.json");
        const sourcePath = join(projectRoot, "source.vhdx"), bytes = Buffer.from("relative-import-source");
        mkdirSync(projectRoot);
        writeFileSync(sourcePath, bytes);
        const sourceIdentity = lstatSync(sourcePath);
        let attached = false;
        const run = vi.fn<HyperVImageStoreRuntime["run"]>(async command => {
            const script = Buffer.from(command.args.at(-1) || "", "base64").toString("utf16le");
            if (script.includes("Storage\\Get-DiskImage -ImagePath $VhdPath")) {
                const path = script.match(/\$VhdPath = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'");
                return { mode: "exec", provider: "hyper-v", status: 0, stdout: JSON.stringify({ ok: true, path, attached, partitionStyle: script.includes("$ReadPartitionStyle = $true") ? "GPT" : null }) };
            }
            if (command.args.at(-1) !== HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP || !command.input) throw new Error("unexpected image provider command");
            const envelope = JSON.parse(Buffer.from(command.input, "base64").toString("utf8")) as { input: string };
            const request = JSON.parse(envelope.input) as { operation: string; path: string };
            let items: unknown[] = [];
            if (request.operation === "Get-VHD") items = [{ path: request.path, vhdFormat: "VHDX", vhdType: "Dynamic", parentPath: null, virtualSizeBytes: 64 * 1024 * 1024 * 1024, fileSizeBytes: readFileSync(request.path).length }];
            else if (request.operation === "Mount-VHD") attached = true;
            else if (request.operation === "Dismount-VHD") attached = false;
            else throw new Error(`unexpected image operation: ${request.operation}`);
            return { mode: "exec", provider: "hyper-v", status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items }) };
        });
        const runtime: HyperVImageStoreRuntime = {
            cwd: relative(process.cwd(), projectRoot), privateRoot, run,
            resolveExecutable: () => "/fake/powershell.exe",
            limits: { acquireTimeoutMs: 60_000, prepareTimeoutMs: 60_000, lockWaitMs: 60_000, commandOutputBytes: 64 * 1024 },
        };
        const importSource = (sourceImage: string) => resolveHyperVImageForCreate(ownerId,
            { backend: "windows-vm", dryRun: false, create: { profile: "windows-11", sourceImage } }, {}, runtime);
        try {
            expect(await importSource("source.vhdx")).toMatchObject({ ok: true, prepared: true, imagePath });
            expect(attached).toBe(false);
            expect(readFileSync(imagePath)).toEqual(bytes);
            expect(readFileSync(sourcePath)).toEqual(bytes);
            expect(lstatSync(sourcePath)).toMatchObject({ dev: sourceIdentity.dev, ino: sourceIdentity.ino, nlink: 1, size: bytes.length });
            const manifestText = readFileSync(manifestPath, "utf8");
            expect(Buffer.byteLength(manifestText)).toBeLessThanOrEqual(16 * 1024);
            expect(readHyperVImageManifestMetadata(privateRoot, "windows-11", profileRoot, true)).toMatchObject({
                imagePath, catalogId: "user-provided-vhdx", generation: 2, sizeBytes: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
            });
            expect(readdirSync(profileRoot).sort()).toEqual(["base.vhdx", "manifest.json"]);

            run.mockClear();
            writeFileSync(join(root, "outside.vhdx"), bytes);
            expect(await importSource("../outside.vhdx")).toMatchObject({ ok: false, status: 422, detail: "hyper-v-base-image-source-must-be-project-root-file" });
            expect(readFileSync(join(root, "outside.vhdx"))).toEqual(bytes);
            linkSync(sourcePath, join(projectRoot, "linked.vhdx"));
            expect(await importSource("linked.vhdx")).toMatchObject({ ok: false, status: 422, detail: "hyper-v-base-image-source-invalid" });
            expect(readFileSync(sourcePath)).toEqual(bytes);
            expect(run).not.toHaveBeenCalled();
            expect(readdirSync(profileRoot).sort()).toEqual(["base.vhdx", "manifest.json"]);

            writeFileSync(manifestPath, manifestText + " ".repeat(16 * 1024));
            expect(await resolveHyperVImageForCreate(ownerId,
                { backend: "windows-vm", dryRun: false, create: { profile: "windows-11", image: relative(process.cwd(), imagePath) } }, {}, runtime))
                .toMatchObject({ ok: false, status: 409, error: "hyper-v-base-image-not-prepared" });
            expect(readFileSync(imagePath)).toEqual(bytes);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

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

    it("inspects and hashes real cached bytes with Windows dev0 paths and bigint opened identities", withPrivateRoot("windows-identity", async privateRoot => {
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        writeCache(profileRoot, automaticManifest(profileRoot));
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        const live = new Set<Awaited<ReturnType<typeof fsPromises.open>>>();
        const realOpen = fsPromises.open.bind(fsPromises), realLstat = fsPromises.lstat.bind(fsPromises);
        const metadata = (stat: any, pathname: boolean) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
            dev: typeof stat.ino === "bigint" ? (pathname ? 0n : 574283787n) : pathname ? 0 : 574283787,
            ino: typeof stat.ino === "bigint" ? stat.ino + 2n ** 60n : Number(BigInt(stat.ino) + 2n ** 60n),
        });
        vi.spyOn(fsPromises, "lstat").mockImplementation((async (...args: Parameters<typeof fsPromises.lstat>) => metadata(await realLstat(...args), true)) as typeof fsPromises.lstat);
        vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
            const handle = await realOpen(...args);
            live.add(handle);
            const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
            vi.spyOn(handle, "stat").mockImplementation((async (...statArgs: any[]) => metadata(await stat(...statArgs), false)) as typeof handle.stat);
            vi.spyOn(handle, "close").mockImplementation(async () => { await close(); live.delete(handle); });
            return handle;
        });
        Object.assign(windowsImageFs, { enabled: true, target: join(profileRoot, "base.vhdx"), fault: "none", opens: 0 });
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        try {
            expect(inspectHyperVUbuntuImageCache(privateRoot, ownerId)).toEqual({ state: "valid", source: "global" });
            hashing.algorithms.length = 0;
            expect(await createDecision(privateRoot)).toBe("valid");
            expect(hashing.algorithms).toContain("sha256");
            expect(readFileSync(join(profileRoot, "base.vhdx"))).toEqual(image);
            expect(windowsImageFs.live.size).toBe(0);
            expect(live.size).toBe(0);
        } finally { windowsImageFs.enabled = false; Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); }
    }));

    it.each(["volume", "inode", "open"])("refuses unqualified cached image metadata (%s) and closes descriptors", fault => withPrivateRoot("windows-refusal", privateRoot => {
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        writeCache(profileRoot, automaticManifest(profileRoot));
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.assign(windowsImageFs, { enabled: true, target: join(profileRoot, "base.vhdx"), fault, opens: 0 });
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        try {
            expect(inspectHyperVUbuntuImageCache(privateRoot, ownerId)).toEqual({ state: "conflict", code: "hyper-v-base-image-profile-conflict" });
            expect(readFileSync(join(profileRoot, "base.vhdx"))).toEqual(image);
            expect(windowsImageFs.live.size).toBe(0);
        } finally { windowsImageFs.enabled = false; Object.defineProperty(process, "platform", platform); }
    })());

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
