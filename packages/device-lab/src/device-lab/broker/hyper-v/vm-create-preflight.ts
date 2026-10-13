import { readDeviceLabFileIdentityAsync } from '../../../device-lab-file-identity.js';
import { createHash } from "crypto";
import { constants as fsConstants, promises as fsPromises } from "fs";
import { dirname, resolve } from "path";
import { cpus, totalmem } from "os";

import { assertDeviceLabPathWithinRoot } from "../../../device-lab-state-file.js";
import { assertHyperVOperationDeadline } from "./deadline.js";
import { assertNoSymlinkPathComponents } from "./image-store.js";

/**
 * The non-Hyper-V half of VM creation, moved out of the generated PowerShell.
 *
 * None of this is a Hyper-V operation, which is why it does not live in `hyper-v-windows/`:
 * host capacity, free space, hashing and a byte copy are things any process can do. They were
 * in the script only because the script was the only place that ran on the host.
 *
 * Moving them is not tidying. The create script runs under a single 120 s clamp, and inside
 * that clamp it reads the base image four times, writes the destination once and reads it
 * back once. For a 16 GB image that is roughly 96 GB of I/O in two minutes -- about 800 MB/s
 * sustained, which a real host is unlikely to deliver. What follows does three passes instead
 * of six and is bounded by the create deadline rather than by the per-command clamp.
 */

// Hyper-V's own floor for a usable host, matching the PowerShell this replaces: keep at least
// 10% of physical memory, and never less than 2 GB, out of the guest's reach.
const MEMORY_RESERVE_FLOOR_MB = 2048;
const MEMORY_RESERVE_FRACTION = 0.10;
// The copy needs room for the disk plus headroom the host itself needs to stay usable.
const DISK_RESERVE_BYTES = 10 * 1024 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;

export type HyperVHostCapacityRequest = {
    readonly memoryMb: number;
    readonly cpus: number;
};

export type HyperVHostCapacity = {
    readonly totalMemoryBytes: number;
    readonly logicalProcessors: number;
};

/**
 * The arithmetic, separated from the reading of it.
 *
 * Split because the reading is not the part that can be wrong. Nothing pinned these two
 * comparisons while they were strings inside a generated script, so a drift during the move
 * would have been invisible; as a pure function they are a table test.
 */
export function hyperVHostCapacityRefusal(
    request: HyperVHostCapacityRequest,
    host: HyperVHostCapacity,
): string | null {
    const totalMemoryMb = Math.floor(host.totalMemoryBytes / (1024 * 1024));
    const reserveMb = Math.max(MEMORY_RESERVE_FLOOR_MB, Math.floor(totalMemoryMb * MEMORY_RESERVE_FRACTION));
    if (request.memoryMb > totalMemoryMb - reserveMb) return "hyper-v-host-memory-capacity-exceeded";
    if (request.cpus > host.logicalProcessors * 2) return "hyper-v-host-cpu-capacity-exceeded";
    return null;
}

/**
 * Reads the host and applies the arithmetic.
 *
 * Two measurable drifts from the PowerShell come with the move, recorded rather than
 * discovered later. `os.totalmem()` reads `GlobalMemoryStatusEx`, which reports slightly less
 * than `Win32_ComputerSystem.TotalPhysicalMemory` because firmware-reserved ranges are
 * excluded -- marginally more conservative, which is the safe direction. And
 * `os.cpus().length` can report only the calling process's processor group on a host with more
 * than 64 logical processors, which would refuse a request the host could in fact serve. Both
 * are accepted; the second is worth revisiting if such a host ever appears.
 */
export function assertHyperVHostCapacity(request: HyperVHostCapacityRequest): void {
    const refusal = hyperVHostCapacityRefusal(request, {
        totalMemoryBytes: totalmem(),
        logicalProcessors: cpus().length,
    });
    if (refusal !== null) throw new Error(refusal);
}

/**
 * Checks the bytes this copy will allocate, not the dynamic VHDX virtual capacity.
 * Retains headroom for the host and subsequent guest writes.
 *
 * `statfs` is not identical to `Get-PSDrive`: on NTFS the latter reports the quota-aware free
 * space for the calling user where `statfs` reports the volume's. On a host with per-user
 * quotas this is the more permissive of the two, so the copy can still fail on space after
 * passing here -- which the copy handles, because a short write is an error rather than a
 * truncation.
 */
export async function assertHyperVDiskCapacity(diskPath: string, copyBytes: number): Promise<void> {
    if (!Number.isSafeInteger(copyBytes) || copyBytes <= 0) {
        throw new Error("hyper-v-host-disk-capacity-invalid");
    }
    // Neither the disk nor its directory necessarily exists: this decides whether to create
    // them, and it has to answer before anything is made. The PowerShell asked `Get-PSDrive`
    // about the path's drive for the same reason. Walking up to the nearest existing ancestor
    // reaches the same volume, which is the only thing the answer depends on.
    let probe = resolve(diskPath);
    while (true) {
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
        try {
            await fsPromises.stat(probe);
            break;
        } catch { /* keep walking toward the volume root */ }
    }
    const stats = await fsPromises.statfs(probe);
    const freeBytes = stats.bavail * stats.bsize;
    if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
        throw new Error("hyper-v-host-disk-capacity-invalid");
    }
    if (copyBytes > freeBytes - DISK_RESERVE_BYTES) throw new Error("hyper-v-host-disk-capacity-exceeded");
}

export type HyperVDiskCloneRequest = {
    readonly baseImageRoot: string;
    readonly baseImagePath: string;
    readonly expectedSha256: string;
    readonly deviceRoot: string;
    readonly diskPath: string;
    readonly deadlineAt?: number;
    // The caller records the file-created effect at the only unambiguous point: after
    // O_EXCL succeeds and before a copy, hash, or read-back can fail.
    readonly onDestinationCreated?: (path: string) => void;
};

export type HyperVDiskCloneResult = {
    readonly bytes: number;
};

/**
 * The identity comparison, separated from the handles it compares.
 *
 * Split for the same reason as the clone verification: the window it guards cannot be hit
 * deterministically from a test. A swap has to land strictly between the open and the end of
 * the copy, and on a real filesystem a copy fast enough to run in a test is also fast enough
 * to finish before any swap arrives -- so a test driving it through the copy proves only that
 * some earlier check fired. As a function over three stat readings it is decidable.
 *
 * What it is for: the hash proves which bytes were read, and this proves which file they were
 * read from. Identical bytes in a different file pass every hash and fail here.
 */
export function hyperVSourceIdentityRefusal(
    opened: { dev: number | bigint; ino: number | bigint; size: number | bigint; nlink: number | bigint },
    final: { dev: number | bigint; ino: number | bigint; size: number | bigint; nlink: number | bigint },
    finalPath: { dev: number | bigint; ino: number | bigint; size: number | bigint; nlink: number | bigint; isSymbolicLink(): boolean },
): string | null {
    if ((final.nlink !== 1 && final.nlink !== 1n) || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size) {
        return "hyper-v-base-image-identity-changed";
    }
    if (finalPath.isSymbolicLink() || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino) {
        return "hyper-v-base-image-identity-changed";
    }
    return null;
}

/**
 * Proves the disk that now exists is the image, by reading it rather than by trusting the write.
 *
 * Separate from the copy because it is the one guard in this file whose failure a test cannot
 * provoke through the copy: the bytes written come from the bytes read, so making them differ
 * needs the destination corrupted underneath. As its own function it takes a handle and an
 * expectation, and a test can hand it a file that simply does not match.
 *
 * It catches what the write loop structurally cannot: a short write reported as complete, and
 * storage that acknowledged bytes it did not keep.
 */
export async function assertClonedDiskMatches(
    target: Awaited<ReturnType<typeof fsPromises.open>>,
    expectedBytes: number,
    expectedSha256: string,
    deadlineAt: number = Number.POSITIVE_INFINITY,
): Promise<void> {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const clonedHash = createHash("sha256");
    let verified = 0;
    while (verified < expectedBytes) {
        assertHyperVOperationDeadline(deadlineAt);
        const { bytesRead } = await target.read(buffer, 0, Math.min(buffer.length, expectedBytes - verified), verified);
        if (bytesRead <= 0) throw new Error("hyper-v-created-disk-short-read");
        clonedHash.update(buffer.subarray(0, bytesRead));
        verified += bytesRead;
    }
    if (clonedHash.digest("hex") !== expectedSha256) throw new Error("hyper-v-created-disk-hash-mismatch");
    const finalTarget = await target.stat({ bigint: true });
    if (finalTarget.size !== BigInt(expectedBytes)) throw new Error("hyper-v-created-disk-length-mismatch");
}

/**
 * Copies the base image to the device's disk and proves the copy, in three passes.
 *
 * The PowerShell did six, and the extra three bought nothing: it hashed the source, hashed it
 * again through a second handle, copied it through a third read, read the destination back to
 * hash it, then re-opened and re-hashed the source once more to catch a mutation during the
 * copy.
 *
 * Hashing the bytes as they are read collapses that. The hash and the copy see the same bytes
 * through the same handle, so a source mutated mid-copy produces a hash that does not match
 * the manifest -- which is what the sixth pass existed to catch, obtained for free. Reading
 * the destination back is kept, because it is the only thing that proves what actually landed
 * on disk rather than what was handed to `write`.
 *
 * The handle identity checks are the same ones `stageLargeRegularFileFromProject` makes, and
 * they are load-bearing for a different reason than the hash: the hash proves the bytes, the
 * identity checks prove nobody swapped the file under the open handle while they were read.
 */
export async function cloneHyperVBaseImage(request: HyperVDiskCloneRequest): Promise<HyperVDiskCloneResult> {
    const deadlineAt = request.deadlineAt ?? Number.POSITIVE_INFINITY;
    const label = "hyper-v-base-image";
    assertNoSymlinkPathComponents(request.baseImageRoot, label);
    assertNoSymlinkPathComponents(request.baseImagePath, label);
    assertDeviceLabPathWithinRoot(request.baseImageRoot, request.baseImagePath, label);
    assertNoSymlinkPathComponents(request.deviceRoot, "hyper-v-device-root");
    assertNoSymlinkPathComponents(request.diskPath, "hyper-v-disk");
    assertDeviceLabPathWithinRoot(request.deviceRoot, request.diskPath, "hyper-v-disk");

    let sourceStat = await fsPromises.lstat(request.baseImagePath, { bigint: true }).catch(() => null);
    if (sourceStat === null) throw new Error("hyper-v-base-image-not-found");
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1n || sourceStat.size <= 0n) {
        throw new Error("hyper-v-base-image-invalid");
    }

    sourceStat = await readDeviceLabFileIdentityAsync(request.baseImagePath, label);

    // Absent on Windows, where it resolves to 0 and the open stops being NOFOLLOW. That is why
    // `Assert-NoReparsePath` stays in the PowerShell prologue: it is the only check in this
    // codebase that sees a reparse tag libuv does not map to a symlink.
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let source: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
    let target: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
    try {
        source = await fsPromises.open(request.baseImagePath, fsConstants.O_RDONLY | noFollow | (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0));
        const openedSource = await source.stat({ bigint: true });
        if (!openedSource.isFile() || openedSource.nlink !== 1n
            || openedSource.dev !== sourceStat.dev
            || openedSource.ino !== sourceStat.ino
            || openedSource.size !== sourceStat.size) {
            throw new Error("hyper-v-base-image-identity-changed");
        }

        // A dynamic disk's virtual capacity is not preallocated. Check the exact bytes
        // read from this validated handle before creating a destination or recording effects.
        await assertHyperVDiskCapacity(request.diskPath, Number(openedSource.size));
        assertHyperVOperationDeadline(deadlineAt);

        // O_EXCL, so a disk that is already there is a refusal rather than an overwrite. The
        // legacy used FileMode::CreateNew for the same reason.
        target = await fsPromises.open(
            request.diskPath,
            fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
            0o600,
        );
        request.onDestinationCreated?.(request.diskPath);
        const openedTarget = await target.stat({ bigint: true });
        const targetPathStat = await readDeviceLabFileIdentityAsync(request.diskPath, "hyper-v-disk", openedTarget);
        if (!openedTarget.isFile() || openedTarget.nlink !== 1n
            || targetPathStat.isSymbolicLink()
            || targetPathStat.dev !== openedTarget.dev
            || targetPathStat.ino !== openedTarget.ino) {
            throw new Error("hyper-v-disk-identity-changed");
        }

        const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
        const sourceHash = createHash("sha256");
        let copied = 0;
        while (copied < Number(openedSource.size)) {
            assertHyperVOperationDeadline(deadlineAt);
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, Number(openedSource.size) - copied), null);
            if (bytesRead <= 0) throw new Error("hyper-v-base-image-copy-short-read");
            const chunk = buffer.subarray(0, bytesRead);
            sourceHash.update(chunk);
            let offset = 0;
            while (offset < bytesRead) {
                const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, null);
                if (bytesWritten <= 0) throw new Error("hyper-v-base-image-copy-short-write");
                offset += bytesWritten;
            }
            copied += bytesRead;
        }
        // The bytes that were copied are the bytes that were hashed. A source mutated during
        // the copy fails here, which is the check the legacy spent a whole extra pass on.
        if (sourceHash.digest("hex") !== request.expectedSha256) throw new Error("hyper-v-base-image-hash-mismatch");
        await target.sync();

        const identityRefusal = hyperVSourceIdentityRefusal(
            openedSource,
            await source.stat({ bigint: true }),
            await readDeviceLabFileIdentityAsync(request.baseImagePath, label, openedSource),
        );
        if (identityRefusal !== null) throw new Error(identityRefusal);

        // Read back what landed rather than trusting what was written.
        await assertClonedDiskMatches(target, Number(openedSource.size), request.expectedSha256, deadlineAt);

        return { bytes: Number(openedSource.size) };
    } finally {
        // Disposed before any caller can compensate. The disk is opened without sharing, so a
        // delete attempted while a handle is still open takes a sharing violation on Windows --
        // which makes this ordering a precondition of the compensation, not just tidiness.
        if (target !== null) await target.close();
        if (source !== null) await source.close();
    }
}
