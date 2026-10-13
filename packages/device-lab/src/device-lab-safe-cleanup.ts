import { readDeviceLabFileIdentity } from './device-lab-file-identity.js';
import { randomBytes } from "crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, type BigIntStats } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { withSharedMutationLock } from "./device-lab-shared-state.js";

function cleanupFileIdentity(path: string, label: string, expected?: BigIntStats): BigIntStats {
    try { return readDeviceLabFileIdentity(path, label, expected); }
    catch (error) {
        if (error instanceof Error && error.message === `${label}-identity-changed`) {
            throw new Error("quarantined-cleanup-target-invalid");
        }
        throw error;
    }
}

export type QuarantinedCleanupError = Error & { quarantineRoot?: string };
type QuarantineCleanupOperations = {
    rename?: typeof renameSync;
    beforeRemove?: (quarantineRoot: string) => void;
    beforeRemoveEntry?: (entry: string) => void;
    beforeDeleteEntry?: (entry: string) => void;
    beforeDeleteRoot?: (root: string) => void;
};

function safeCleanupMutationLockFile(): string {
    const identity = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    const root = join(tmpdir(), `ccc-device-lab-safe-cleanup-${identity}`);
    try {
        mkdirSync(root, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = lstatSync(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()
        || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
        throw new Error("safe-cleanup-lock-directory-invalid");
    }
    try { chmodSync(root, 0o700); } catch { /* Windows ACLs govern the per-user temp directory. */ }
    return join(root, "mutation.lock");
}

function sameEntryIdentity(original: BigIntStats, quarantined: BigIntStats): boolean {
    if (original.dev !== quarantined.dev || original.ino !== quarantined.ino
        || (original.mode & BigInt(fsConstants.S_IFMT)) !== (quarantined.mode & BigInt(fsConstants.S_IFMT))) return false;
    return original.isDirectory() === quarantined.isDirectory()
        && original.isSymbolicLink() === quarantined.isSymbolicLink();
}

function sameDirectoryIdentity(original: BigIntStats, quarantined: BigIntStats): boolean {
    return original.isDirectory() && quarantined.isDirectory()
        && !original.isSymbolicLink() && !quarantined.isSymbolicLink()
        && sameEntryIdentity(original, quarantined);
}

function removeBoundDirectory(
    path: string,
    expected: BigIntStats,
    beforeRemove?: (path: string) => void,
    beforeRemoveEntry?: (entry: string) => void,
    beforeDeleteEntry?: (entry: string) => void,
    beforeDeleteRoot?: (root: string) => void,
): void {
    let descriptor: number | null = null;
    try {
        descriptor = openSync(path, fsConstants.O_RDONLY | (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0));
    } catch {
        // Windows does not consistently expose directory descriptors through
        // fs.open; the identity checks below remain mandatory on that path.
    }
    const anchored = descriptor !== null && process.platform === "linux" ? `/proc/self/fd/${descriptor}` : path;
    const assertBound = () => {
        const observed = descriptor !== null ? fstatSync(descriptor, { bigint: true }) : cleanupFileIdentity(path, "quarantined-cleanup-target", expected);
        const named = cleanupFileIdentity(path, "quarantined-cleanup-target", expected);
        if (!sameDirectoryIdentity(expected, observed) || !sameDirectoryIdentity(expected, named)) {
            throw new Error("quarantined-cleanup-target-invalid");
        }
    };
    try {
        assertBound();
        beforeRemove?.(path);
        for (const entry of readdirSync(anchored)) {
            assertBound();
            const child = join(anchored, entry);
            const childPathStats = lstatSync(child, { bigint: true });
            const childStats = childPathStats.isFile() || childPathStats.isDirectory()
                ? cleanupFileIdentity(child, "quarantined-cleanup-target") : childPathStats;
            beforeRemoveEntry?.(child);
            assertBound();
            const stagedChild = join(anchored, `.ccc-entry-${randomBytes(16).toString("hex")}`);
            renameSync(child, stagedChild);
            assertBound();
            const stagedStats = childStats.isFile() || childStats.isDirectory() ? cleanupFileIdentity(stagedChild, "quarantined-cleanup-target", childStats) : lstatSync(stagedChild, { bigint: true });
            if (!sameEntryIdentity(childStats, stagedStats)) {
                throw new Error("quarantined-cleanup-target-invalid");
            }
            beforeDeleteEntry?.(stagedChild);
            assertBound();
            const deleteStats = stagedStats.isFile() || stagedStats.isDirectory() ? cleanupFileIdentity(stagedChild, "quarantined-cleanup-target", stagedStats) : lstatSync(stagedChild, { bigint: true });
            if (!sameEntryIdentity(stagedStats, deleteStats)) throw new Error("quarantined-cleanup-target-invalid");
            if (childStats.isSymbolicLink() || !childStats.isDirectory()) unlinkSync(stagedChild);
            else removeBoundDirectory(stagedChild, deleteStats, undefined, undefined, beforeDeleteEntry, beforeDeleteRoot);
        }
        assertBound();
    } finally {
        if (descriptor !== null) closeSync(descriptor);
    }
    const emptyPath = join(dirname(path), `.ccc-empty-${randomBytes(16).toString("hex")}`);
    renameSync(path, emptyPath);
    const emptyStats = cleanupFileIdentity(emptyPath, "quarantined-cleanup-target", expected);
    if (!sameDirectoryIdentity(expected, emptyStats)) throw new Error("quarantined-cleanup-target-invalid");
    beforeDeleteRoot?.(emptyPath);
    const deleteStats = cleanupFileIdentity(emptyPath, "quarantined-cleanup-target", emptyStats);
    if (!sameDirectoryIdentity(emptyStats, deleteStats)) throw new Error("quarantined-cleanup-target-invalid");
    rmdirSync(emptyPath);
}

function quarantineAndRemoveDirectoryUnlocked(
    target: string,
    validate: (path: string) => void,
    operations: QuarantineCleanupOperations = {},
): { quarantineRoot: string } {
    const quarantineParent = join(dirname(target), `.ccc-cleanup-${randomBytes(16).toString("hex")}`);
    const quarantineRoot = join(quarantineParent, basename(target));
    validate(target);
    const original = cleanupFileIdentity(target, "quarantined-cleanup-target");
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("quarantined-cleanup-target-invalid");
    mkdirSync(quarantineParent, { mode: 0o700 });
    try {
        (operations.rename ?? renameSync)(target, quarantineRoot);
        validate(quarantineParent);
        validate(quarantineRoot);
        const quarantined = cleanupFileIdentity(quarantineRoot, "quarantined-cleanup-target", original);
        if (!quarantined.isDirectory() || quarantined.isSymbolicLink() || !sameDirectoryIdentity(original, quarantined)) {
            throw new Error("quarantined-cleanup-target-invalid");
        }
        removeBoundDirectory(
            quarantineRoot,
            quarantined,
            operations.beforeRemove,
            operations.beforeRemoveEntry,
            operations.beforeDeleteEntry,
            operations.beforeDeleteRoot,
        );
        if (existsSync(quarantineRoot)) throw new Error("quarantined-cleanup-target-remains");
        rmdirSync(quarantineParent);
        return { quarantineRoot };
    } catch (error) {
        if (!existsSync(quarantineRoot)) {
            try { rmdirSync(quarantineParent); } catch { /* preserve the primary failure */ }
        }
        const cleanupError = (error instanceof Error ? error : new Error(String(error))) as QuarantinedCleanupError;
        cleanupError.quarantineRoot = quarantineRoot;
        throw cleanupError;
    }
}

export function quarantineAndRemoveDirectory(
    target: string,
    validate: (path: string) => void,
    operations: QuarantineCleanupOperations = {},
): { quarantineRoot: string } {
    return withSharedMutationLock(
        safeCleanupMutationLockFile(),
        () => quarantineAndRemoveDirectoryUnlocked(target, validate, operations),
        { waitMs: 5 * 60 * 1000, staleMs: 10 * 60 * 1000 },
    );
}
