import { createHash } from "crypto";
import nativeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { promises as fsPromises } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hyperVImageProfileRoot, resolveHyperVImageForCreate, type HyperVImageStoreRuntime } from "@ccc/device-lab/device-lab/broker/hyper-v/image-store.js";
import { HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP } from "@ccc/hyper-v/low-level/powershell-transport.js";
import { acceptHyperVWindowsEvaluationLicense, HYPER_V_IMAGE_CATALOG } from "@ccc/device-lab/device-lab/hyper-v-images.js";

type Profile = "ubuntu-lts" | "windows-server";
type Variant = "normal" | "already-sized" | "prepare-failed" | "prepare-response-lost" | "convert-response-lost" | "resize-response-lost" | "source-mutated" | "source-replaced-same-bytes" | "partial-mutated" | "partial-vhd-invalid" | "final-vhd-invalid" | "finalize-response-lost" | "final-hash-acquire-timeout" | "convert-acquire-timeout";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function hash(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }
function marker(value: unknown): string { return `CCC_HYPER_V_RESULT_B64:${Buffer.from(JSON.stringify(value)).toString("base64")}`; }

function fixture(profile: Profile, variant: Variant = "normal", acquireTimeoutMs = 60_000, advancePastAcquireDeadline: () => void = () => {}, now?: () => number) {
    const root = mkdtempSync(join(tmpdir(), "hyper-v-auto-"));
    roots.push(root);
    const privateRoot = join(root, "private");
    if (profile === "windows-server") {
        mkdirSync(join(privateRoot, "setup"), { recursive: true });
        acceptHyperVWindowsEvaluationLicense(join(privateRoot, "setup"));
    }
    const profileRoot = hyperVImageProfileRoot(privateRoot, profile);
    const workRoot = join(profileRoot, ".acquire-work");
    const imagePath = join(profileRoot, "base.vhdx");
    const partialPath = join(profileRoot, "base.partial.vhdx");
    const sourceVhdPath = join(workRoot, "converted.normalized.fixed.vhd");
    const sourceBytes = "verified-fixed-vhd";
    const windowsBytes = "downloaded-windows-vhdx";
    const convertedBytes = "converted-dynamic-vhdx";
    const targetSize = HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes;
    const sourceSize = variant === "already-sized" ? targetSize : targetSize / 2;
    const operations: string[] = [];
    let prepareAttempts = 0;
    let partialVirtualSize = sourceSize;
    const runtime: HyperVImageStoreRuntime = {
        cwd: root, privateRoot,
        ...(now ? { now } : {}),
        resolveExecutable: () => "/fake/powershell.exe",
        limits: { acquireTimeoutMs, prepareTimeoutMs: 60_000, lockWaitMs: 60_000, commandOutputBytes: 64 * 1024 },
        async run(command) {
            const encodedScript = command.args.at(-1) || "";
            const script = command.input && encodedScript !== HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP
                ? Buffer.from(command.input, "base64").toString("utf8")
                : Buffer.from(encodedScript, "base64").toString("utf16le");
            const success = (stdout: string) => ({ mode: "exec", provider: "hyper-v", status: 0, stdout, stderr: "" });
            if (script.includes("$CccAcquirePhase = 'prepare'")) {
                operations.push("prepare");
                prepareAttempts += 1;
                if (variant === "prepare-failed") return { mode: "exec", provider: "hyper-v", status: 1, stdout: "", stderr: "hyper-v-base-image-download-failed" };
                mkdirSync(workRoot, { recursive: true });
                if (profile === "ubuntu-lts") {
                    writeFileSync(sourceVhdPath, sourceBytes);
                    writeFileSync(join(profileRoot, "source.qcow2"), "verified-source-cache");
                    if (variant === "prepare-response-lost" && prepareAttempts === 1) return success("lost");
                    return success(marker({ ok: true, profile, imagePath, partialPath, sourceVhdPath,
                        sourceVhdSha256: hash(sourceBytes), sourceVirtualSizeBytes: sourceSize,
                        qemuSha256: hash("trusted-qemu") }));
                }
                writeFileSync(partialPath, windowsBytes);
                if (variant === "prepare-response-lost" && prepareAttempts === 1) return success("lost");
                return success(marker({ ok: true, profile, imagePath, partialPath,
                    partialSha256: hash(windowsBytes), partialSizeBytes: windowsBytes.length }));
            }
            if (script.includes("$CccAcquirePhase = 'finalize'")) {
                operations.push("finalize");
                expect(script).toContain(`$ExpectedPartialFileId = '${statSync(partialPath, { bigint: true }).ino}'`);
                if (profile === "ubuntu-lts") {
                    expect(script).toContain(`$ExpectedSourceFileId = '${statSync(sourceVhdPath, { bigint: true }).ino}'`);
                }
                if (variant === "partial-mutated") {
                    writeFileSync(partialPath, "changed-partial-vhdx");
                    return { mode: "exec", provider: "hyper-v", status: 1, stdout: "", stderr: "hyper-v-base-image-partial-mutated" };
                }
                const bytes = readFileSync(partialPath);
                writeFileSync(imagePath, bytes);
                if (variant === "finalize-response-lost") return success("lost");
                return success(marker({ ok: true, profile, imagePath, sha256: createHash("sha256").update(bytes).digest("hex"),
                    sizeBytes: bytes.length, virtualSizeBytes: profile === "ubuntu-lts" ? targetSize : 64 * 1024 * 1024 * 1024,
                    vhdType: profile === "ubuntu-lts" ? "Dynamic" : "Fixed", generation: 2, reused: false }));
            }
            if (command.args.at(-1) === HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP && command.input) {
                const outer = JSON.parse(Buffer.from(command.input, "base64").toString("utf8")) as { input: string };
                const request = JSON.parse(outer.input) as { operation: string; path?: string; sourcePath?: string; destinationPath?: string; vhdType?: string; sizeBytes?: number };
                operations.push(request.operation);
                const typed = (items: unknown[] = []) => success(JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items }));
                if (request.operation === "Get-VHD") {
                    const path = request.path || "";
                    const source = path === sourceVhdPath;
                    const final = path === imagePath;
                    const vhdFormat = source ? "VHD" : "VHDX";
                    const vhdType = source ? "Fixed" : profile === "windows-server" ? "Fixed" : "Dynamic";
                    if (final && variant === "final-hash-acquire-timeout") advancePastAcquireDeadline();
                    return typed([{ path, vhdFormat, vhdType: (final && variant === "final-vhd-invalid") || (path === partialPath && variant === "partial-vhd-invalid") ? "Differencing" : vhdType,
                        parentPath: null, virtualSizeBytes: source ? sourceSize : profile === "ubuntu-lts" ? partialVirtualSize : 64 * 1024 * 1024 * 1024,
                        fileSizeBytes: readFileSync(path).length }]);
                }
                if (request.operation === "Convert-VHD") {
                    expect(request).toMatchObject({ sourcePath: sourceVhdPath, destinationPath: partialPath, vhdType: "Dynamic" });
                    writeFileSync(request.destinationPath || "", convertedBytes);
                    if (variant === "source-mutated") writeFileSync(sourceVhdPath, "changed-source-vhd");
                    if (variant === "source-replaced-same-bytes") {
                        const replacement = join(workRoot, "replacement.vhd");
                        writeFileSync(replacement, sourceBytes);
                        renameSync(replacement, sourceVhdPath);
                    }
                    if (variant === "convert-response-lost") return success("lost");
                    if (variant === "convert-acquire-timeout") {
                        advancePastAcquireDeadline();
                        return { mode: "exec", provider: "hyper-v", status: null, stdout: "", stderr: "", timedOut: true };
                    }
                    return typed();
                }
                if (request.operation === "Resize-VHD") {
                    expect(request).toMatchObject({ path: partialPath, sizeBytes: targetSize });
                    partialVirtualSize = request.sizeBytes || 0;
                    if (variant === "resize-response-lost") return success("lost");
                    return typed();
                }
            }
            throw new Error("unexpected-provider-call");
        },
    };
    const prepare = () => resolveHyperVImageForCreate("owner", {
        backend: profile === "ubuntu-lts" ? "linux-vm" : "windows-vm", dryRun: false, create: { profile },
    }, {}, runtime);
    return { profileRoot, imagePath, partialPath, sourceVhdPath, operations, prepare, runtime };
}

describe("automatic Hyper-V image typed VHD transaction", () => {
    it("waits for the held profile lock across a forward wall jump within the caller's local budget", async () => {
        const wallStartedAt = Date.now();
        let wallNow = wallStartedAt;
        const monotonicNow = 1000;
        vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        vi.resetModules();
        const { withSharedMutationLockAsync } = await import("@ccc/device-lab/device-lab-shared-state.js");
        const { resolveHyperVImageForCreate: resolveImage } = await import("@ccc/device-lab/device-lab/broker/hyper-v/image-store.js");
        const test = fixture("ubuntu-lts", "normal", 1000, () => {}, () => monotonicNow);
        const lockPath = join(test.profileRoot, "prepare.lock");
        mkdirSync(test.profileRoot, { recursive: true });
        let release!: () => void;
        let entered!: () => void;
        let contended!: () => void;
        const heldUntilReleased = new Promise<void>((resolve) => { release = resolve; });
        const ownerEntered = new Promise<void>((resolve) => { entered = resolve; });
        const claimContended = new Promise<void>((resolve) => { contended = resolve; });
        const owner = withSharedMutationLockAsync(lockPath, async () => { entered(); await heldUntilReleased; });
        try {
            await ownerEntered;
            const realOpen = nativeFs.openSync;
            vi.spyOn(nativeFs, "openSync").mockImplementation((path, flags, mode) => {
                try { return realOpen(path, flags, mode); }
                catch (error) {
                    if (String(path) === lockPath && (error as NodeJS.ErrnoException).code === "EEXIST") {
                        wallNow = wallStartedAt + 60_001;
                        contended();
                    }
                    throw error;
                }
            });
            syncBuiltinESMExports();
            const preparation = resolveImage("owner", {
                backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" },
            }, {}, test.runtime, 2000).then((value) => ({ value }), (error: unknown) => ({ error }));
            await claimContended;
            expect(test.operations).toEqual([]);
            release();
            await owner;
            const result = await preparation;

            expect(result).toEqual({ value: expect.objectContaining({ ok: true, prepared: true, imagePath: test.imagePath }) });
            expect(readFileSync(test.imagePath, "utf8")).toBe("converted-dynamic-vhdx");
            expect(existsSync(join(test.profileRoot, "manifest.json"))).toBe(true);
        } finally {
            release();
            try { await owner; }
            finally { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.resetModules(); }
        }
    });

    it("uses typed Get/Convert/Resize for Ubuntu and publishes only after final readback", async () => {
        const test = fixture("ubuntu-lts");
        const result = await test.prepare();
        expect(result, JSON.stringify(test.operations)).toEqual(expect.objectContaining({ ok: true, prepared: true, imagePath: test.imagePath }));
        expect(test.operations).toEqual(["prepare", "Get-VHD", "Convert-VHD", "Get-VHD", "Resize-VHD", "Get-VHD", "finalize", "Get-VHD"]);
        expect(existsSync(join(test.profileRoot, "manifest.json"))).toBe(true);
    });

    it("uses typed Get-VHD for Windows Server partial and final images", async () => {
        const test = fixture("windows-server");
        const result = await test.prepare();
        expect(result, JSON.stringify(test.operations)).toEqual(expect.objectContaining({ ok: true, prepared: true }));
        expect(test.operations).toEqual(["prepare", "Get-VHD", "finalize", "Get-VHD"]);
    });

    it.each(["ubuntu-lts", "windows-server"] as const)(
        "preserves unknown %s preparation artifacts and permits a guarded retry after response loss", async (profile) => {
            const test = fixture(profile, "prepare-response-lost");
            expect(await test.prepare()).toEqual(expect.objectContaining({ ok: false, status: 422 }));
            expect(existsSync(test.partialPath)).toBe(false);
            expect(existsSync(join(test.profileRoot, ".acquire-work"))).toBe(false);
            expect(readdirSync(test.profileRoot).some((name) => name.includes("-uncertain-"))).toBe(true);
            expect(await test.prepare()).toEqual(expect.objectContaining({ ok: true, prepared: true }));
            expect(test.operations.filter((operation) => operation === "prepare")).toHaveLength(2);
        },
    );

    it("skips Resize-VHD when conversion already has the catalog virtual size", async () => {
        const test = fixture("ubuntu-lts", "already-sized");
        expect(await test.prepare()).toEqual(expect.objectContaining({ ok: true, prepared: true }));
        expect(test.operations).toEqual(["prepare", "Get-VHD", "Convert-VHD", "Get-VHD", "finalize", "Get-VHD"]);
    });

    it("preserves an unmanaged pre-existing base and refuses automatic acquisition", async () => {
        const test = fixture("ubuntu-lts");
        const foreign = "unmanaged-base-image";
        mkdirSync(test.profileRoot, { recursive: true });
        writeFileSync(test.imagePath, foreign);
        expect(await test.prepare()).toEqual(expect.objectContaining({
            ok: false, status: 409, error: "hyper-v-base-image-profile-conflict",
            detail: "hyper-v-base-image-unmanaged-existing",
        }));
        expect(readFileSync(test.imagePath, "utf8")).toBe(foreign);
        expect(test.operations).toEqual([]);
    });

    it.each(["base.partial.vhdx", ".acquire-work"] as const)(
        "preserves a pre-existing %s with unknown ownership", async (name) => {
            const test = fixture("ubuntu-lts");
            const path = join(test.profileRoot, name);
            mkdirSync(test.profileRoot, { recursive: true });
            if (name === ".acquire-work") {
                mkdirSync(path);
                writeFileSync(join(path, "foreign.txt"), "foreign");
            } else {
                writeFileSync(path, "foreign");
            }
            expect(await test.prepare()).toEqual(expect.objectContaining({ ok: false, status: 409 }));
            expect(existsSync(path)).toBe(true);
            expect(test.operations).toEqual([]);
        },
    );

    it.each(["convert-response-lost", "resize-response-lost", "source-mutated", "source-replaced-same-bytes", "partial-mutated", "partial-vhd-invalid"] as const)(
        "withholds the base and manifest after %s", async (variant) => {
            const test = fixture("ubuntu-lts", variant);
            const result = await test.prepare();
            expect(result).toEqual(expect.objectContaining({ ok: false, status: 422 }));
            expect(existsSync(test.imagePath)).toBe(false);
            expect(existsSync(join(test.profileRoot, "manifest.json"))).toBe(false);
            expect(existsSync(test.partialPath)).toBe(false);
            if (variant === "convert-response-lost") {
                expect(readdirSync(test.profileRoot).some((name) => name.startsWith(".partial-uncertain-"))).toBe(true);
            }
        },
    );

    it("withholds the manifest and retains an uncertain base after final typed inspection fails", async () => {
        const test = fixture("ubuntu-lts", "final-vhd-invalid");
        expect(await test.prepare()).toEqual(expect.objectContaining({ ok: false, status: 422 }));
        expect(existsSync(test.imagePath)).toBe(true);
        expect(existsSync(join(test.profileRoot, "manifest.json"))).toBe(false);
        expect(existsSync(test.partialPath)).toBe(false);
    });

    it("retains an unmanifested base for guarded recovery when finalization response is lost", async () => {
        const test = fixture("ubuntu-lts", "finalize-response-lost");
        expect(await test.prepare()).toEqual(expect.objectContaining({ ok: false, status: 422 }));
        expect(existsSync(test.imagePath)).toBe(true);
        expect(existsSync(join(test.profileRoot, "manifest.json"))).toBe(false);
        expect(existsSync(test.partialPath)).toBe(false);
        expect(await test.prepare()).toEqual(expect.objectContaining({ ok: false, status: 409 }));
    });

    it("withholds the manifest when final image hashing crosses the shorter acquisition deadline", async () => {
        const startedAt = 1_000_000;
        let finalInspectionFinished = false;
        let postInspectionClockReads = 0;
        vi.spyOn(Date, "now").mockImplementation(() => {
            if (!finalInspectionFinished) return startedAt;
            postInspectionClockReads += 1;
            return startedAt + (postInspectionClockReads === 1 ? 999 : 1_001);
        });
        const test = fixture("ubuntu-lts", "final-hash-acquire-timeout", 1_000, () => { finalInspectionFinished = true; });
        await expect(test.prepare()).rejects.toThrow("hyper-v-operation-deadline-exceeded");
        expect(test.operations.at(-1)).toBe("Get-VHD");
        expect(postInspectionClockReads).toBeGreaterThanOrEqual(2);
        expect(existsSync(test.imagePath)).toBe(true);
        expect(existsSync(join(test.profileRoot, "manifest.json"))).toBe(false);
    });

    it("withholds the manifest after local final-hash expiry despite a backward wall jump", async () => {
        let wallNow = 1000;
        let monotonicNow = 1000;
        let finalReads = 0;
        vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        const test = fixture("ubuntu-lts", "normal", 1000, () => {}, () => monotonicNow);
        const realOpen = fsPromises.open.bind(fsPromises);
        vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
            const handle = await realOpen(...args);
            if (args[0] === test.imagePath) {
                const read = handle.read.bind(handle);
                vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
                    const result = await read(...readArgs);
                    finalReads += 1;
                    wallNow = 500;
                    monotonicNow = 2001;
                    return result;
                });
            }
            return handle;
        });

        await expect(test.prepare()).rejects.toThrow("hyper-v-operation-deadline-exceeded");

        expect(finalReads).toBeGreaterThan(0);
        expect(test.operations.at(-1)).toBe("Get-VHD");
        expect(readFileSync(test.imagePath, "utf8")).toBe("converted-dynamic-vhdx");
        expect(existsSync(join(test.profileRoot, "manifest.json"))).toBe(false);
        expect(existsSync(test.partialPath)).toBe(false);
    });

    it("completes source hashing and publication across a forward wall jump within the local budget", async () => {
        let wallNow = 1000;
        let monotonicNow = 1000;
        let sourceReads = 0;
        vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        const test = fixture("ubuntu-lts", "normal", 1000, () => {}, () => monotonicNow);
        const realOpen = fsPromises.open.bind(fsPromises);
        vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
            const handle = await realOpen(...args);
            if (args[0] === test.sourceVhdPath) {
                const read = handle.read.bind(handle);
                vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
                    const result = await read(...readArgs);
                    sourceReads += 1;
                    wallNow = 10_000;
                    monotonicNow += 1;
                    return result;
                });
            }
            return handle;
        });
        const beforePreparedAt = new Date().getTime();

        await expect(test.prepare()).resolves.toEqual(expect.objectContaining({ ok: true, prepared: true, imagePath: test.imagePath }));

        expect(sourceReads).toBeGreaterThan(0);
        expect(test.operations).toEqual(["prepare", "Get-VHD", "Convert-VHD", "Get-VHD", "Resize-VHD", "Get-VHD", "finalize", "Get-VHD"]);
        const manifest = JSON.parse(readFileSync(join(test.profileRoot, "manifest.json"), "utf8"));
        expect(manifest.sha256).toBe(hash("converted-dynamic-vhdx"));
        expect(Date.parse(manifest.preparedAt)).toBeGreaterThanOrEqual(beforePreparedAt);
        expect(Date.parse(manifest.preparedAt)).toBeLessThanOrEqual(new Date().getTime());
    });

    it("maps a typed conversion timeout at the acquisition deadline to the deadline error", async () => {
        let now = 1_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const test = fixture("ubuntu-lts", "convert-acquire-timeout", 1_000, () => { now += 1_001; });
        await expect(test.prepare()).rejects.toThrow("hyper-v-operation-deadline-exceeded");
        expect(test.operations).toEqual(["prepare", "Get-VHD", "Convert-VHD"]);
        expect(existsSync(test.imagePath)).toBe(false);
        expect(existsSync(test.partialPath)).toBe(false);
        expect(readdirSync(test.profileRoot).some((name) => name.startsWith(".partial-uncertain-"))).toBe(true);
        expect(existsSync(join(test.profileRoot, ".acquire-work"))).toBe(false);
        expect(existsSync(join(test.profileRoot, "manifest.json"))).toBe(false);
    });

    it("preserves an unmanaged base beside a foreign malformed manifest", async () => {
        const test = fixture("ubuntu-lts");
        const baseBytes = "foreign-base-image";
        const manifestBytes = '{"catalogId":"foreign","imagePath":"/elsewhere/base.vhdx"}';
        const manifestPath = join(test.profileRoot, "manifest.json");
        mkdirSync(test.profileRoot, { recursive: true });
        writeFileSync(test.imagePath, baseBytes);
        writeFileSync(manifestPath, manifestBytes);
        expect(await test.prepare()).toEqual(expect.objectContaining({
            ok: false, status: 409, error: "hyper-v-base-image-profile-conflict",
        }));
        expect(readFileSync(test.imagePath, "utf8")).toBe(baseBytes);
        expect(readFileSync(manifestPath, "utf8")).toBe(manifestBytes);
        expect(test.operations).toEqual([]);
    });

    it.each([
        ["virtualSizeBytes", 1],
        ["vhdType", "Differencing"],
        ["licenseId", "foreign"],
        ["secureBootTemplate", "MicrosoftWindows"],
        ["preparedAt", "not-a-date"],
    ] as const)("preserves a prior base when manifest %s is malformed", async (field, value) => {
        const test = fixture("ubuntu-lts");
        const baseBytes = "prior-base-image";
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        mkdirSync(test.profileRoot, { recursive: true });
        writeFileSync(test.imagePath, baseBytes);
        const prior = {
            version: 3, profile: "ubuntu-lts",
            catalogId: "canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-native-vhdx-20260725-v1",
            sourceUrl: catalog.sourceUrl, sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256, licenseId: catalog.licenseId,
            generation: catalog.generation, secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1, imagePath: test.imagePath, sha256: hash(baseBytes),
            sizeBytes: Buffer.byteLength(baseBytes), virtualSizeBytes: catalog.virtualSizeBytes,
            vhdType: "Dynamic", preparedAt: new Date().toISOString(),
            [field]: value,
        };
        const manifestPath = join(test.profileRoot, "manifest.json");
        const originalManifest = JSON.stringify(prior);
        writeFileSync(manifestPath, originalManifest);
        expect(await test.prepare()).toEqual(expect.objectContaining({ ok: false, status: 409 }));
        expect(readFileSync(test.imagePath, "utf8")).toBe(baseBytes);
        expect(readFileSync(manifestPath, "utf8")).toBe(originalManifest);
        expect(test.operations).toEqual([]);
    });

    it.each([
        [false, "prepare-failed", false],
        [true, "prepare-failed", false],
        [false, "finalize-response-lost", false],
        [false, "prepare-failed", true],
    ] as const)("preserves a prior pair after %s retirement, %s, and preflight conflict %s", async (interrupted, variant, preflightConflict) => {
        const test = fixture("ubuntu-lts", variant);
        const baseBytes = "prior-base-image";
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        const manifestPath = join(test.profileRoot, "manifest.json");
        mkdirSync(test.profileRoot, { recursive: true });
        writeFileSync(test.imagePath, baseBytes);
        const prior = JSON.stringify({
            version: 3, profile: "ubuntu-lts",
            catalogId: "canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-native-vhdx-20260725-v1",
            sourceUrl: catalog.sourceUrl, sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256, licenseId: catalog.licenseId,
            generation: catalog.generation, secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1, imagePath: test.imagePath, sha256: hash(baseBytes),
            sizeBytes: Buffer.byteLength(baseBytes), virtualSizeBytes: catalog.virtualSizeBytes,
            vhdType: "Dynamic", preparedAt: new Date().toISOString(),
        });
        writeFileSync(manifestPath, prior);
        if (interrupted) renameSync(manifestPath, join(test.profileRoot, ".manifest-prior-recovery.json"));
        if (preflightConflict) writeFileSync(test.partialPath, "foreign-partial");
        expect(await test.prepare()).toEqual(expect.objectContaining({ ok: false, ...(preflightConflict ? { status: 409 } : {}) }));
        expect(readFileSync(test.imagePath, "utf8")).toBe(baseBytes);
        expect(readFileSync(manifestPath, "utf8")).toBe(prior);
        expect(existsSync(join(test.profileRoot, ".base-prior-recovery.vhdx"))).toBe(false);
        expect(existsSync(join(test.profileRoot, ".manifest-prior-recovery.json"))).toBe(false);
        if (preflightConflict) expect(test.operations).toEqual([]);
        else if (variant === "prepare-failed") expect(test.operations).toEqual(["prepare"]);
        else {
            expect(test.operations).toContain("finalize");
            expect(readdirSync(test.profileRoot).some((name) => name.startsWith(".base-uncertain-"))).toBe(true);
        }
    });
});
