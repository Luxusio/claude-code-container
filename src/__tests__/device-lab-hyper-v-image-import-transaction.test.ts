import { createHash } from "crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hyperVOwnerImageProfileRoot, readHyperVImageManifestMetadata, resolveHyperVImageForCreate, type HyperVImageStoreRuntime } from "@ccc/device-lab/device-lab/broker/hyper-v/image-store.js";
import { HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP } from "@ccc/hyper-v/low-level/powershell-transport.js";

type Variant = "normal" | "fixed" | "mbr" | "mount-response-lost" | "dismount-malformed" | "detach-unconfirmed" | "readback-failed" | "hash-changed" | "unsupported-partition" | "invalid-vhd" | "unsupported-vhd-type" | "deadline-expire" | "manifest-created-race" | "final-clock-change";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(variant: Variant = "normal", now?: () => number, finalInspection: () => void = () => {}) {
    const root = mkdtempSync(join(tmpdir(), "hyper-v-import-"));
    roots.push(root);
    const cwd = join(root, "project");
    const privateRoot = join(root, "private");
    mkdirSync(cwd);
    const sourceImage = join(cwd, "source.vhdx");
    writeFileSync(sourceImage, "source-vhdx-bytes");
    const profileRoot = hyperVOwnerImageProfileRoot(privateRoot, "owner", "windows-11");
    const imagePath = join(profileRoot, "base.vhdx");
    const manifestPath = join(profileRoot, "manifest.json");
    const operations: Array<{ operation: string; path?: string }> = [];
    let attached = false;
    let storageReads = 0;
    const runtime: HyperVImageStoreRuntime = {
        cwd, privateRoot,
        ...(now ? { now } : {}),
        resolveExecutable: () => "/fake/powershell.exe",
        limits: { acquireTimeoutMs: 30_000, prepareTimeoutMs: 30_000, lockWaitMs: 30_000, commandOutputBytes: 64 * 1024 },
        async run(command) {
            const script = Buffer.from(command.args.at(-1) || "", "base64").toString("utf16le");
            if (script.includes("Storage\\Get-DiskImage -ImagePath $VhdPath")) {
                storageReads += 1;
                if (variant === "readback-failed" && storageReads === 3) {
                    return { mode: "exec", provider: "hyper-v", status: 0, stdout: "malformed" };
                }
                const path = script.match(/\$VhdPath = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                const readPartitionStyle = script.includes("$ReadPartitionStyle = $true");
                return { mode: "exec", provider: "hyper-v", status: 0, stdout: JSON.stringify({
                    ok: true, path, attached,
                    partitionStyle: readPartitionStyle ? variant === "unsupported-partition" ? "RAW" : variant === "mbr" ? "MBR" : "GPT" : null,
                }) };
            }
            if (command.args.at(-1) === HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP && command.input) {
                const envelope = JSON.parse(Buffer.from(command.input, "base64").toString("utf8")) as { input: string };
                const request = JSON.parse(envelope.input) as { operation: string; path?: string };
                operations.push(request);
                const success = (items: unknown[] = []) => ({ mode: "exec", provider: "hyper-v", status: 0,
                    stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items }) });
                if (request.operation === "Get-VHD") {
                    if (variant === "final-clock-change" && request.path === imagePath) finalInspection();
                    if (variant === "manifest-created-race" && request.path === imagePath) {
                        writeFileSync(manifestPath, "foreign-manifest");
                    }
                    if (variant === "deadline-expire" && request.path === imagePath) {
                        await new Promise((resolve) => setTimeout(resolve, 4500));
                    }
                    return success([{
                    path: request.path, vhdFormat: "VHDX", vhdType: variant === "invalid-vhd" ? "Differencing" : variant === "unsupported-vhd-type" ? "FutureType" : variant === "fixed" ? "Fixed" : "Dynamic",
                    parentPath: null, virtualSizeBytes: variant === "fixed" ? 8 : 64 * 1024 * 1024 * 1024,
                    fileSizeBytes: readFileSync(request.path || "").length,
                    }]);
                }
                if (request.operation === "Mount-VHD") {
                    attached = true;
                    if (variant === "mount-response-lost") return { mode: "exec", provider: "hyper-v", status: 0, stdout: "lost" };
                    return success();
                }
                if (request.operation === "Dismount-VHD") {
                    if (variant !== "detach-unconfirmed") attached = false;
                    if (variant === "hash-changed") writeFileSync(request.path || "", "changed-vhdx-bytes");
                    if (variant === "dismount-malformed") return { mode: "exec", provider: "hyper-v", status: 0, stdout: "malformed" };
                    return success();
                }
            }
            throw new Error("unexpected-provider-call");
        },
    };
    const prepare = (deadlineAt = Number.POSITIVE_INFINITY) => resolveHyperVImageForCreate("owner", {
        backend: "windows-vm", dryRun: false, create: { profile: "windows-11", sourceImage },
    }, {}, runtime, deadlineAt);
    return { privateRoot, sourceImage, profileRoot, imagePath, manifestPath, operations, prepare };
}

describe("imported Hyper-V image transaction", () => {
    it("validates and detaches the staged VHDX before publishing a base and manifest", async () => {
        const test = fixture();
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: true, prepared: true, imagePath: test.imagePath }));
        expect(readFileSync(test.imagePath, "utf8")).toBe("source-vhdx-bytes");
        expect(JSON.parse(readFileSync(test.manifestPath, "utf8"))).toEqual(expect.objectContaining({
            version: 3, catalogId: "user-provided-vhdx", generation: 2,
            sha256: createHash("sha256").update("source-vhdx-bytes").digest("hex"),
        }));
        expect(test.operations.map(({ operation }) => operation)).toEqual([
            "Get-VHD", "Mount-VHD", "Dismount-VHD", "Get-VHD", "Get-VHD",
        ]);
        expect(test.operations[1]?.path).toBe(test.operations[2]?.path);
        expect(test.operations[1]?.path).toMatch(/\.source-[a-f0-9]{24}\.vhdx$/);
        expect(readdirSync(test.profileRoot).filter((name) => name.startsWith(".source-"))).toEqual([]);
    });

    it("dismounts a transaction-owned image after losing the mount response", async () => {
        const test = fixture("mount-response-lost");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: false, status: 422, error: "hyper-v-base-image-prepare-failed" }));
        expect(test.operations.map(({ operation }) => operation)).toEqual(["Get-VHD", "Mount-VHD", "Dismount-VHD"]);
        expect(existsSync(test.imagePath)).toBe(false);
        expect(existsSync(test.manifestPath)).toBe(false);
        expect(readdirSync(test.profileRoot).filter((name) => name.startsWith(".source-"))).toEqual([]);
    });

    it("retains the staged image when detach cannot be confirmed", async () => {
        const test = fixture("detach-unconfirmed");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: false, status: 422, detail: "hyper-v-base-image-dismount-failed" }));
        expect(existsSync(test.imagePath)).toBe(false);
        expect(existsSync(test.manifestPath)).toBe(false);
        expect(readdirSync(test.profileRoot).filter((name) => name.startsWith(".source-"))).toHaveLength(1);
    });

    it("rejects a malformed typed dismount response even when Storage reports detached", async () => {
        const test = fixture("dismount-malformed");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: false, status: 422, detail: "hyper-v-base-image-dismount-failed" }));
        expect(existsSync(test.imagePath)).toBe(false);
        expect(existsSync(test.manifestPath)).toBe(false);
        expect(readdirSync(test.profileRoot).filter((name) => name.startsWith(".source-"))).toEqual([]);
    });

    it("preserves a foreign base and manifest on a profile conflict", async () => {
        const test = fixture();
        mkdirSync(test.profileRoot, { recursive: true });
        writeFileSync(test.imagePath, "foreign-image");
        writeFileSync(test.manifestPath, "foreign-manifest");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: "hyper-v-base-image-profile-conflict" }));
        expect(test.operations.map(({ operation }) => operation)).toEqual([]);
        expect(readFileSync(test.imagePath, "utf8")).toBe("foreign-image");
        expect(readFileSync(test.manifestPath, "utf8")).toBe("foreign-manifest");
    });

    it("reuses a matching base after validating the staged source", async () => {
        const test = fixture();
        mkdirSync(test.profileRoot, { recursive: true });
        writeFileSync(test.imagePath, "source-vhdx-bytes");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: true, prepared: false, imagePath: test.imagePath }));
        expect(readFileSync(test.imagePath, "utf8")).toBe("source-vhdx-bytes");
        expect(JSON.parse(readFileSync(test.manifestPath, "utf8"))).toEqual(expect.objectContaining({
            catalogId: "user-provided-vhdx", generation: 2,
        }));
        expect(test.operations.map(({ operation }) => operation)).toEqual([
            "Get-VHD", "Mount-VHD", "Dismount-VHD", "Get-VHD",
        ]);
    });

    it("maps an MBR image to generation one", async () => {
        const test = fixture("mbr");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: true, prepared: true }));
        expect(JSON.parse(readFileSync(test.manifestPath, "utf8"))).toEqual(expect.objectContaining({ generation: 1 }));
    });

    it("accepts a fixed VHDX whose format metadata extends beyond its virtual size", async () => {
        const test = fixture("fixed");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: true, prepared: true }));
        expect(readHyperVImageManifestMetadata(test.privateRoot, "windows-11", test.profileRoot, true)).toEqual(expect.objectContaining({
            vhdType: "Fixed", virtualSizeBytes: 8, sizeBytes: "source-vhdx-bytes".length,
        }));
    });

    it.each([0, -1])("rejects a fixed-image manifest with nonpositive virtual size %s", async (virtualSizeBytes) => {
        const test = fixture("fixed");
        expect((await test.prepare()).ok).toBe(true);
        const manifest = JSON.parse(readFileSync(test.manifestPath, "utf8")) as Record<string, unknown>;
        writeFileSync(test.manifestPath, JSON.stringify({ ...manifest, virtualSizeBytes }));
        expect(() => readHyperVImageManifestMetadata(test.privateRoot, "windows-11", test.profileRoot, true))
            .toThrow("hyper-v-base-image-manifest-state-invalid");
    });

    it("does not publish when final VHD inspection returns after the deadline", async () => {
        const test = fixture("deadline-expire");
        await expect(test.prepare(Date.now() + 1000)).rejects.toThrow();
        expect(test.operations.at(-1)).toEqual(expect.objectContaining({ operation: "Get-VHD", path: test.imagePath }));
        expect(existsSync(test.imagePath)).toBe(false);
        expect(existsSync(test.manifestPath)).toBe(false);
    }, 10_000);

    it("refuses late import publication despite a backward wall jump during final VHD inspection", async () => {
        let wallNow = 1000;
        let monotonicNow = 1000;
        vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        const test = fixture("final-clock-change", () => monotonicNow, () => {
            wallNow = 500;
            monotonicNow = 2001;
        });

        await expect(test.prepare(2000)).rejects.toThrow("hyper-v-operation-deadline-exceeded");

        expect(test.operations.at(-1)).toEqual(expect.objectContaining({ operation: "Get-VHD", path: test.imagePath }));
        expect(existsSync(test.imagePath)).toBe(false);
        expect(existsSync(test.manifestPath)).toBe(false);
        expect(readFileSync(test.sourceImage, "utf8")).toBe("source-vhdx-bytes");
    });

    it("publishes a detached verified import when only the wall clock passes its local deadline", async () => {
        let wallNow = 1000;
        let monotonicNow = 1000;
        vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        const test = fixture("final-clock-change", () => monotonicNow, () => {
            wallNow = 10_000;
            monotonicNow = 1001;
        });

        await expect(test.prepare(2000)).resolves.toEqual(expect.objectContaining({ ok: true, prepared: true, imagePath: test.imagePath }));

        expect(readFileSync(test.imagePath, "utf8")).toBe("source-vhdx-bytes");
        expect(JSON.parse(readFileSync(test.manifestPath, "utf8"))).toEqual(expect.objectContaining({
            sha256: createHash("sha256").update("source-vhdx-bytes").digest("hex"),
        }));
        expect(test.operations.map(({ operation }) => operation)).toEqual([
            "Get-VHD", "Mount-VHD", "Dismount-VHD", "Get-VHD", "Get-VHD",
        ]);
        expect(readdirSync(test.profileRoot).filter((name) => name.startsWith(".source-"))).toEqual([]);
    });

    it("never overwrites a manifest created while the staged image is being inspected", async () => {
        const test = fixture("manifest-created-race");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: false, status: 422 }));
        expect(readFileSync(test.manifestPath, "utf8")).toBe("foreign-manifest");
        expect(existsSync(test.imagePath)).toBe(false);
    });

    it("keeps a staged image when detached readback fails", async () => {
        const test = fixture("readback-failed");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: false, status: 422, detail: "hyper-v-base-image-dismount-failed" }));
        expect(existsSync(test.imagePath)).toBe(false);
        expect(existsSync(test.manifestPath)).toBe(false);
        expect(readdirSync(test.profileRoot).filter((name) => name.startsWith(".source-"))).toHaveLength(1);
    });

    it("reports a profile conflict before inspecting an invalid different source", async () => {
        const test = fixture("invalid-vhd");
        mkdirSync(test.profileRoot, { recursive: true });
        writeFileSync(test.imagePath, "foreign-image");
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: "hyper-v-base-image-profile-conflict" }));
        expect(test.operations).toEqual([]);
    });

    it.each(["hash-changed", "unsupported-partition", "invalid-vhd", "unsupported-vhd-type"] as const)("withholds publication for %s", async (variant) => {
        const test = fixture(variant);
        const result = await test.prepare();
        expect(result).toEqual(expect.objectContaining({ ok: false, status: 422, error: "hyper-v-base-image-prepare-failed" }));
        expect(existsSync(test.imagePath)).toBe(false);
        expect(existsSync(test.manifestPath)).toBe(false);
    });
});
