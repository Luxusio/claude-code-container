import { fileSymlinkOrSkip } from "./helpers/file-symlink-fixture.js";
import { createHash } from "crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { promises as fsPromises } from "fs";
import { join } from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    assertHyperVDiskCapacity,
    assertHyperVHostCapacity,
    assertClonedDiskMatches,
    cloneHyperVBaseImage,
    hyperVHostCapacityRefusal,
    hyperVSourceIdentityRefusal,
} from "@ccc/device-lab/device-lab/broker/hyper-v/vm-create-preflight.js";

// The clone and its rollback have only ever been provable on Windows: the one test that
// executes them is skipIf(platform !== "win32") and has never run in this repo's CI or on a
// developer machine. Everything below runs here, on a real filesystem, which is the point of
// moving this work out of the generated PowerShell.

let root = "";

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccc-hyperv-create-"));
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 40 * 1024 ** 3, bsize: 1 } as Awaited<ReturnType<typeof fsPromises.statfs>>);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function sha256Of(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function writeBaseImage(bytes: Buffer): { imageRoot: string; imagePath: string; sha256: string } {
    const imageRoot = join(root, "images");
    mkdirSync(imageRoot, { recursive: true });
    const imagePath = join(imageRoot, "base.vhdx");
    writeFileSync(imagePath, bytes);
    return { imageRoot, imagePath, sha256: sha256Of(bytes) };
}

function devicePaths(): { deviceRoot: string; diskPath: string } {
    const deviceRoot = join(root, "devices", "device-1");
    const diskPath = join(deviceRoot, "disks", "root.vhdx");
    mkdirSync(join(deviceRoot, "disks"), { recursive: true });
    return { deviceRoot, diskPath };
}

async function withWindowsFileObservations<T>(source: string, fault: "none" | "volume" | "inode" | "open" | "path-swap" | "admitted-volume", body: (live: Set<Awaited<ReturnType<typeof fsPromises.open>>>) => Promise<T>): Promise<T> {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const realOpen = fsPromises.open.bind(fsPromises), realLstat = fsPromises.lstat.bind(fsPromises);
    const live = new Set<Awaited<ReturnType<typeof fsPromises.open>>>();
    let sourceOpens = 0;
    let admittedObserved = false;
    const metadata = (stat: any, pathname: boolean, fresh = false) => {
        const bigint = typeof stat.ino === "bigint";
        const inode = BigInt(stat.ino) + 2n ** 60n + (fresh && fault === "inode" ? 1n : 0n);
        const volume = 574283787n + (fresh && fault === "volume" ? 1n : 0n);
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
            dev: bigint ? (pathname ? 0n : volume) : Number(pathname ? 0n : volume),
            ino: bigint ? inode : Number(inode),
        });
    };
    vi.spyOn(fsPromises, "lstat").mockImplementation((async (path: Parameters<typeof fsPromises.lstat>[0], ...args: any[]) => {
        const stat = await realLstat(path, ...args);
        const observed = metadata(stat, true);
        if (path === source && typeof stat.ino === "bigint" && !admittedObserved) {
            admittedObserved = true;
            if (fault === "admitted-volume") observed.dev = 574283788n;
        }
        if (path === source && sourceOpens >= 2 && fault === "path-swap") observed.ino = typeof observed.ino === "bigint" ? observed.ino + 1n : observed.ino + 1;
        return observed;
    }) as typeof fsPromises.lstat);
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
        const fresh = args[0] === source && ++sourceOpens >= 2;
        if (fresh && fault === "open") throw Object.assign(new Error("fresh open denied"), { code: "EACCES" });
        const handle = await realOpen(...args);
        live.add(handle);
        const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation((async (...statArgs: any[]) => metadata(await stat(...statArgs), false, fresh)) as typeof handle.stat);
        vi.spyOn(handle, "close").mockImplementation(async () => { await close(); live.delete(handle); });
        return handle;
    });
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try { return await body(live); }
    finally { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); }
}

describe("Hyper-V host capacity", () => {
    const host = { totalMemoryBytes: 64 * 1024 * 1024 * 1024, logicalProcessors: 8 };
    const totalMb = 64 * 1024;
    // max(2048, floor(65536 * 0.10)) = 6553
    const reserveMb = 6553;

    // Nothing pinned this arithmetic before. It was a string inside a generated script, so a
    // drift during the move would have been invisible in both languages.
    it.each([
        ["memory exactly at the reserve boundary", { memoryMb: totalMb - reserveMb, cpus: 1 }, null],
        ["one megabyte past it", { memoryMb: totalMb - reserveMb + 1, cpus: 1 }, "hyper-v-host-memory-capacity-exceeded"],
        ["cpus at twice the logical count", { memoryMb: 1024, cpus: 16 }, null],
        ["one cpu past twice the logical count", { memoryMb: 1024, cpus: 17 }, "hyper-v-host-cpu-capacity-exceeded"],
    ] as const)("refuses %s", (_label, request, expected) => {
        expect(hyperVHostCapacityRefusal(request, host)).toBe(expected);
    });

    // The floor matters on a small host: a tenth of 8 GB is 819 MB, well under the 2 GB the
    // host needs to stay usable while a guest runs.
    it("keeps a 2 GB floor under the ten percent reserve", () => {
        const small = { totalMemoryBytes: 8 * 1024 * 1024 * 1024, logicalProcessors: 4 };
        expect(hyperVHostCapacityRefusal({ memoryMb: 8192 - 2048, cpus: 1 }, small)).toBe(null);
        expect(hyperVHostCapacityRefusal({ memoryMb: 8192 - 2048 + 1, cpus: 1 }, small))
            .toBe("hyper-v-host-memory-capacity-exceeded");
    });

    it("reads the real host without throwing for a modest request", () => {
        expect(() => assertHyperVHostCapacity({ memoryMb: 1, cpus: 1 })).not.toThrow();
    });
});

describe("Hyper-V disk capacity", () => {
    it("uses copy bytes and keeps exactly 10 GiB of reserve", async () => {
        const { diskPath } = devicePaths();
        await expect(assertHyperVDiskCapacity(diskPath, 30 * 1024 ** 3)).resolves.toBeUndefined();
        await expect(assertHyperVDiskCapacity(diskPath, 30 * 1024 ** 3 + 1))
            .rejects.toThrow("hyper-v-host-disk-capacity-exceeded");
    });

    it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid copy size %s", async (size) => {
        await expect(assertHyperVDiskCapacity(join(root, "disk.vhdx"), size))
            .rejects.toThrow("hyper-v-host-disk-capacity-invalid");
    });

    it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid available space %s", async (free) => {
        vi.mocked(fsPromises.statfs).mockResolvedValue({ bavail: free, bsize: 1 } as Awaited<ReturnType<typeof fsPromises.statfs>>);
        await expect(assertHyperVDiskCapacity(join(root, "disk.vhdx"), 1))
            .rejects.toThrow("hyper-v-host-disk-capacity-invalid");
    });

    it("queries the existing ancestor of a destination not yet created", async () => {
        const unborn = join(root, "not", "yet", "made", "root.vhdx");
        await expect(assertHyperVDiskCapacity(unborn, 1)).resolves.toBeUndefined();
        expect(fsPromises.statfs).toHaveBeenCalledWith(root);
    });
});

describe("cloning the base image", () => {
    for (const fault of ["growth", "empty", "replacement"] as const) it.skipIf(fault === "growth" && process.platform === "win32")(`refuses changed initial source admission before clone I/O (${fault})`, async () => {
        const bytes = Buffer.from("original admitted clone source");
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();
        const retained = join(imageRoot, "retained.vhdx");
        const realLstat = fsPromises.lstat.bind(fsPromises), realOpen = fsPromises.open.bind(fsPromises);
        const live = new Set<Awaited<ReturnType<typeof fsPromises.open>>>();
        let mutated = false, reads = 0;
        const created = vi.fn();
        vi.spyOn(fsPromises, "lstat").mockImplementation((async (...args: Parameters<typeof fsPromises.lstat>) => {
            const stat = await realLstat(...args);
            if (String(args[0]) === imagePath && typeof stat?.ino === "bigint" && !mutated) {
                mutated = true;
                if (fault === "replacement") { renameSync(imagePath, retained); writeFileSync(imagePath, bytes); }
                else truncateSync(imagePath, fault === "empty" ? 0 : 64 * 1024 ** 3 + 1);
            }
            return stat;
        }) as typeof fsPromises.lstat);
        vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
            const handle = await realOpen(...args); live.add(handle);
            const close = handle.close.bind(handle);
            vi.spyOn(handle, "close").mockImplementation(async () => { await close(); live.delete(handle); });
            if (String(args[0]) === imagePath) vi.spyOn(handle, "read").mockImplementation(async () => { reads++; throw new Error("unexpected source read"); });
            return handle;
        });
        await expect(cloneHyperVBaseImage({ baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256, deviceRoot, diskPath, onDestinationCreated: created })).rejects.toThrow();
        expect(mutated).toBe(true);
        expect(reads).toBe(0);
        expect(created).not.toHaveBeenCalled();
        expect(() => statSync(diskPath)).toThrow();
        expect(live.size).toBe(0);
        if (fault === "replacement") expect(readFileSync(retained)).toEqual(bytes);
        expect(statSync(imagePath).size).toBe(fault === "empty" ? 0 : fault === "growth" ? 64 * 1024 ** 3 + 1 : bytes.length);
    });
    it.skipIf(process.platform === "win32")("refuses a real FIFO substituted before opening the qualified clone source", () => {
        const source = fileURLToPath(new URL("../../packages/device-lab/dist/device-lab/broker/hyper-v/vm-create-preflight.js", import.meta.url));
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import fs from 'node:fs';
            import { execFileSync } from 'node:child_process';
            import { createHash } from 'node:crypto';
            import { join } from 'node:path';
            import { pathToFileURL } from 'node:url';
            const { cloneHyperVBaseImage } = await import(pathToFileURL(process.argv[1]).href);
            const root = process.argv[2], image = join(root, 'base.vhdx'), retained = join(root, 'retained.vhdx');
            const deviceRoot = join(root, 'device'), diskPath = join(deviceRoot, 'disk.vhdx');
            fs.mkdirSync(deviceRoot);
            const bytes = Buffer.from('clone source bytes');
            fs.writeFileSync(image, bytes);
            const open = fs.promises.open.bind(fs.promises), live = new Set();
            let sourceOpens = 0, refused = false, destinationCreated = false;
            fs.promises.open = async (...args) => {
                if (String(args[0]) === image && ++sourceOpens === 3) {
                    fs.renameSync(image, retained);
                    execFileSync('mkfifo', [image]);
                }
                const handle = await open(...args); live.add(handle);
                const close = handle.close.bind(handle);
                handle.close = async () => { await close(); live.delete(handle); };
                return handle;
            };
            try { await cloneHyperVBaseImage({ baseImageRoot: root, baseImagePath: image, expectedSha256: createHash('sha256').update(bytes).digest('hex'), deviceRoot, diskPath, onDestinationCreated: () => { destinationCreated = true; } }); }
            catch { refused = true; }
            console.log(JSON.stringify({ refused, live: live.size, swapped: sourceOpens === 3, destinationCreated, destinationExists: fs.existsSync(diskPath), fifoRetained: fs.lstatSync(image).isFIFO(), bytes: fs.readFileSync(retained, 'utf8') }));
        `, source, root], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout.trim())).toEqual({ refused: true, live: 0, swapped: true, destinationCreated: false, destinationExists: false, fifoRetained: true, bytes: "clone source bytes" });
    });
    it("copies and verifies actual bytes despite Windows pathname dev0 and precise bigint inode", async () => {
        const bytes = Buffer.alloc(1024 * 1024 + 17, 7);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();
        await withWindowsFileObservations(imagePath, "none", async live => {
            await expect(cloneHyperVBaseImage({ baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256, deviceRoot, diskPath })).resolves.toEqual({ bytes: bytes.length });
            expect(readFileSync(diskPath)).toEqual(bytes);
            expect(live.size).toBe(0);
        });
    });
    it.each(["volume", "inode", "open", "path-swap", "admitted-volume"] as const)("refuses unsafe Windows source qualification (%s) and closes every handle", async fault => {
        const bytes = Buffer.from("source must remain untouched");
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();
        const created = vi.fn();
        await withWindowsFileObservations(imagePath, fault, async live => {
            await expect(cloneHyperVBaseImage({ baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256, deviceRoot, diskPath, onDestinationCreated: created })).rejects.toThrow();
            expect(created).not.toHaveBeenCalled();
            expect(() => statSync(diskPath)).toThrow();
            expect(readFileSync(imagePath)).toEqual(bytes);
            expect(live.size).toBe(0);
        });
    });
    it("copies the image and proves what landed on disk", async () => {
        const bytes = Buffer.alloc(3 * 1024 * 1024 + 517, 7);
        bytes.write("vhdxfile", 0);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: imagePath,
            expectedSha256: sha256,
            deviceRoot,
            diskPath,
        })).resolves.toEqual({ bytes: bytes.length });

        expect(readFileSync(diskPath).equals(bytes)).toBe(true);
    });

    it("refuses insufficient copy space before creating any destination", async () => {
        const bytes = Buffer.alloc(4096, 1);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();
        const created = vi.fn();
        vi.mocked(fsPromises.statfs).mockResolvedValue({ bavail: 10 * 1024 ** 3 + bytes.length - 1, bsize: 1 } as Awaited<ReturnType<typeof fsPromises.statfs>>);
        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256,
            deviceRoot, diskPath, onDestinationCreated: created,
        })).rejects.toThrow("hyper-v-host-disk-capacity-exceeded");
        expect(created).not.toHaveBeenCalled();
        expect(() => statSync(diskPath)).toThrow();
    });

    it("refuses a base image whose bytes do not match the manifest", async () => {
        const { imageRoot, imagePath } = writeBaseImage(Buffer.alloc(4096, 1));
        const { deviceRoot, diskPath } = devicePaths();
        const created: string[] = [];

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: imagePath,
            expectedSha256: "b".repeat(64),
            deviceRoot,
            diskPath,
            onDestinationCreated: (path) => { created.push(path); },
        })).rejects.toThrow(/hyper-v-base-image-hash-mismatch/);
        expect(created).toEqual([diskPath]);
    });

    it("refuses a missing base image before creating anything", async () => {
        const imageRoot = join(root, "images");
        mkdirSync(imageRoot, { recursive: true });
        const { deviceRoot, diskPath } = devicePaths();

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: join(imageRoot, "absent.vhdx"),
            expectedSha256: "a".repeat(64),
            deviceRoot,
            diskPath,
        })).rejects.toThrow(/hyper-v-base-image-not-found/);
        expect(() => statSync(diskPath)).toThrow();
    });

    // The destination is opened O_EXCL, matching the legacy FileMode::CreateNew. An existing
    // disk is a refusal, never an overwrite -- a device's disk is not something creation may
    // silently replace.
    it("refuses to overwrite a disk that is already there", async () => {
        const bytes = Buffer.alloc(4096, 3);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();
        writeFileSync(diskPath, "occupied");
        const created: string[] = [];

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256, deviceRoot, diskPath,
            onDestinationCreated: (path) => { created.push(path); },
        })).rejects.toThrow(/EEXIST/);
        expect(created).toEqual([]);
        expect(readFileSync(diskPath, "utf8")).toBe("occupied");
    });

    it("refuses a symlinked base image", async (context) => {
        const bytes = Buffer.alloc(4096, 5);
        const { imageRoot, sha256 } = writeBaseImage(bytes);
        const realPath = join(root, "outside.vhdx");
        writeFileSync(realPath, bytes);
        const linkPath = join(imageRoot, "link.vhdx");
        fileSymlinkOrSkip(context, realPath, linkPath);
        const { deviceRoot, diskPath } = devicePaths();

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: linkPath, expectedSha256: sha256, deviceRoot, diskPath,
        })).rejects.toThrow();
        expect(() => statSync(diskPath)).toThrow();
    });

    // The legacy needed a whole extra read of the base image to catch this. Hashing the bytes
    // as they are copied catches it for free, because the hash and the copy see the same
    // bytes through the same handle.
    it("detects a base image mutated in place while it is being copied", async () => {
        const bytes = Buffer.alloc(8 * 1024 * 1024, 9);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();

        // Mutate after the source handle is open but before copying starts. No timer race
        // or floating clone Promise may outlive this test's temporary directory.
        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256, deviceRoot, diskPath,
            onDestinationCreated: () => {
                const descriptor = openSync(imagePath, "r+");
                try { writeSync(descriptor, Buffer.alloc(1024, 42), 0, 1024, bytes.length - 1024); }
                finally { closeSync(descriptor); }
            },
        })).rejects.toThrow(/hyper-v-base-image-hash-mismatch/);
    });

    it("stops before the first chunk when the deadline has already passed", async () => {
        const bytes = Buffer.alloc(4096, 2);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: imagePath,
            expectedSha256: sha256,
            deviceRoot,
            diskPath,
            deadlineAt: Date.now() - 1,
        })).rejects.toThrow(/hyper-v-operation-deadline-exceeded/);
    });

    // The copy left the 120 s per-command clamp when it left PowerShell, so without a check
    // inside its own loop it would be bounded by nothing -- a hang rather than an error.
    //
    // Asserting that it throws is not enough: the read-back loop checks the deadline too, so
    // a copy that ignored the deadline entirely would still fail, just after writing every
    // byte. The partial destination is what proves the copy itself stopped.
    it("stops the copy itself when the deadline expires part way through", async () => {
        const bytes = Buffer.alloc(24 * 1024 * 1024, 4);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();

        // Expire after the first source read, independent of scheduling or disk speed.
        let now = 1000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const realOpen = fsPromises.open.bind(fsPromises);
        vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
            const handle = await realOpen(...args);
            if (args[0] === imagePath) {
                const read = handle.read.bind(handle);
                vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
                    const result = await read(...readArgs);
                    now = 1002;
                    return result;
                });
            }
            return handle;
        });

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: imagePath,
            expectedSha256: sha256,
            deviceRoot,
            diskPath,
            deadlineAt: 1001,
        })).rejects.toThrow(/hyper-v-operation-deadline-exceeded/);

        expect(statSync(diskPath).size).toBeLessThan(bytes.length);
    });

    it("stops an expired local copy budget despite the wall clock moving backward", async () => {
        const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 4);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();
        let wallNow = 1000;
        let monotonicNow = 1000;
        let sourceReads = 0;
        const created = vi.fn();
        vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        const realOpen = fsPromises.open.bind(fsPromises);
        vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
            const handle = await realOpen(...args);
            if (args[0] === imagePath) {
                const read = handle.read.bind(handle);
                vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
                    const result = await read(...readArgs);
                    sourceReads += 1;
                    wallNow = 500;
                    monotonicNow = 1002;
                    return result;
                });
            }
            return handle;
        });

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256,
            deviceRoot, diskPath, deadlineAt: 1001, now: () => monotonicNow,
            onDestinationCreated: created,
        })).rejects.toThrow("hyper-v-operation-deadline-exceeded");

        expect(sourceReads).toBeGreaterThan(0);
        expect(created).toHaveBeenCalledWith(diskPath);
        expect(statSync(diskPath).size).toBeLessThan(bytes.length);
        expect(readFileSync(imagePath)).toEqual(bytes);
    });

    // A swap the hash cannot see: same bytes, different file. Only the handle identity check
    // catches it, and it is the case the check exists for -- the bytes that were read came
    // from a file nobody verified.
    it("detects the base image being replaced by an identical-looking file mid-copy", async () => {
        const bytes = Buffer.alloc(16 * 1024 * 1024, 8);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();
        const impostor = join(imageRoot, "impostor.vhdx");
        writeFileSync(impostor, bytes);

        // Windows can refuse rename-over-open-file. Model the changed path observation
        // with a real, identical-content second inode while retaining real copy/readback IO.
        const realLstat = fsPromises.lstat.bind(fsPromises);
        let destinationCreated = false;
        vi.spyOn(fsPromises, "lstat").mockImplementation(((path: Parameters<typeof fsPromises.lstat>[0], ...args: any[]) =>
            realLstat(path === imagePath && destinationCreated ? impostor : path, ...args)) as typeof fsPromises.lstat);
        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256, deviceRoot, diskPath,
            onDestinationCreated: () => { destinationCreated = true; },
        })).rejects.toThrow(/hyper-v-base-image-identity-changed/);
    });
});

// The copy writes what it read, so these three failures cannot be provoked through the copy:
// the bytes would have to be corrupted underneath it. Driven directly instead, which is the
// reason the verification is its own function.
describe("proving what landed on disk", () => {
    async function withOpenFile<T>(bytes: Buffer, body: (handle: Awaited<ReturnType<typeof fsPromises.open>>) => Promise<T>): Promise<T> {
        const path = join(root, "landed.vhdx");
        writeFileSync(path, bytes);
        const handle = await fsPromises.open(path, "r+");
        try { return await body(handle); } finally { await handle.close(); }
    }

    it("accepts a disk whose bytes are the image", async () => {
        const bytes = Buffer.alloc(2 * 1024 * 1024 + 11, 6);
        await withOpenFile(bytes, async (handle) => {
            await expect(assertClonedDiskMatches(handle, bytes.length, sha256Of(bytes))).resolves.toBeUndefined();
        });
    });

    it("verifies actual disk bytes while the wall clock moves forward within a local budget", async () => {
        const bytes = Buffer.alloc(2 * 1024 * 1024 + 11, 6);
        let wallNow = 1000;
        let monotonicNow = 1000;
        vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        await withOpenFile(bytes, async (handle) => {
            const read = handle.read.bind(handle);
            let reads = 0;
            vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
                const result = await read(...args);
                reads += 1;
                wallNow = 10_000;
                monotonicNow += 1;
                return result;
            });

            await expect(assertClonedDiskMatches(handle, bytes.length, sha256Of(bytes), 2000, () => monotonicNow))
                .resolves.toBeUndefined();
            expect(reads).toBeGreaterThan(0);
        });
    });

    it("refuses a disk whose content differs from the image", async () => {
        const bytes = Buffer.alloc(4096, 6);
        const corrupted = Buffer.from(bytes);
        corrupted[2048] = 200;
        await withOpenFile(corrupted, async (handle) => {
            await expect(assertClonedDiskMatches(handle, bytes.length, sha256Of(bytes)))
                .rejects.toThrow(/hyper-v-created-disk-hash-mismatch/);
        });
    });

    it("refuses a disk longer than the image even when the prefix matches", async () => {
        const bytes = Buffer.alloc(4096, 6);
        await withOpenFile(Buffer.concat([bytes, Buffer.alloc(16, 0)]), async (handle) => {
            await expect(assertClonedDiskMatches(handle, bytes.length, sha256Of(bytes)))
                .rejects.toThrow(/hyper-v-created-disk-length-mismatch/);
        });
    });

    it("refuses a disk shorter than the image rather than hashing past its end", async () => {
        const bytes = Buffer.alloc(4096, 6);
        await withOpenFile(bytes.subarray(0, 2048), async (handle) => {
            await expect(assertClonedDiskMatches(handle, bytes.length, sha256Of(bytes)))
                .rejects.toThrow(/hyper-v-created-disk-short-read/);
        });
    });
});

// The swap window cannot be hit deterministically through the copy: any file small enough for
// a fast test is copied before a swap can land, so a test driving this through cloneHyperVBaseImage
// proves only that some earlier check fired. Driven directly.
describe("proving which file the bytes came from", () => {
    const opened = { dev: 10, ino: 20, size: 4096, nlink: 1 };
    const path = (over: Partial<typeof opened> & { link?: boolean } = {}) => ({
        ...opened, ...over, isSymbolicLink: () => over.link === true,
    });

    it("accepts a handle and a path that still name the same file", () => {
        expect(hyperVSourceIdentityRefusal(opened, { ...opened }, path())).toBe(null);
    });

    it.each([
        ["the file was replaced under the handle", { ...opened }, path({ ino: 21 })],
        ["the path moved to another device", { ...opened }, path({ dev: 11 })],
        ["the path became a symlink", { ...opened }, path({ link: true })],
        ["the open file grew", { ...opened, size: 8192 }, path()],
        ["the open file gained a hard link", { ...opened, nlink: 2 }, path()],
        ["the open file changed inode", { ...opened, ino: 99 }, path()],
    ] as const)("refuses when %s", (_label, final, finalPath) => {
        expect(hyperVSourceIdentityRefusal(opened, final, finalPath))
            .toBe("hyper-v-base-image-identity-changed");
    });

    // The case the hash cannot see: same size, same content, different file.
    it("refuses an identical-looking file at a different inode", () => {
        expect(hyperVSourceIdentityRefusal(opened, { ...opened }, path({ ino: 777 })))
            .toBe("hyper-v-base-image-identity-changed");
    });
});
