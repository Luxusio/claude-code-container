import { randomBytes } from "crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, type Stats } from "fs";
import { basename, dirname, join } from "path";

export type QuarantinedCleanupError = Error & { quarantineRoot?: string };
type QuarantineCleanupOperations = {
    rename?: typeof renameSync;
    beforeRemove?: (quarantineRoot: string) => void;
    beforeRemoveEntry?: (entry: string) => void;
};

function sameEntryIdentity(original: Stats, quarantined: Stats): boolean {
    if (original.dev !== quarantined.dev || original.ino !== quarantined.ino) return false;
    if (original.ino !== 0 || quarantined.ino !== 0) return original.isDirectory() === quarantined.isDirectory()
        && original.isSymbolicLink() === quarantined.isSymbolicLink();
    return original.birthtimeMs === quarantined.birthtimeMs && original.ctimeMs === quarantined.ctimeMs
        && original.isDirectory() === quarantined.isDirectory()
        && original.isSymbolicLink() === quarantined.isSymbolicLink();
}

function sameDirectoryIdentity(original: Stats, quarantined: Stats): boolean {
    return original.isDirectory() && quarantined.isDirectory()
        && !original.isSymbolicLink() && !quarantined.isSymbolicLink()
        && sameEntryIdentity(original, quarantined);
}

function removeBoundDirectory(
    path: string,
    expected: Stats,
    beforeRemove?: (path: string) => void,
    beforeRemoveEntry?: (entry: string) => void,
): void {
    let descriptor: number | null = null;
    try {
        descriptor = openSync(path, fsConstants.O_RDONLY);
    } catch {
        // Windows does not consistently expose directory descriptors through
        // fs.open; the identity checks below remain mandatory on that path.
    }
    const anchored = descriptor !== null && process.platform === "linux" ? `/proc/self/fd/${descriptor}` : path;
    const assertBound = () => {
        const observed = descriptor !== null ? fstatSync(descriptor) : lstatSync(path);
        const named = lstatSync(path);
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
            const childStats = lstatSync(child);
            beforeRemoveEntry?.(child);
            assertBound();
            const stagedChild = join(anchored, `.ccc-entry-${randomBytes(16).toString("hex")}`);
            renameSync(child, stagedChild);
            assertBound();
            const stagedStats = lstatSync(stagedChild);
            if (!sameEntryIdentity(childStats, stagedStats)) {
                throw new Error("quarantined-cleanup-target-invalid");
            }
            if (childStats.isSymbolicLink() || !childStats.isDirectory()) unlinkSync(stagedChild);
            else removeBoundDirectory(stagedChild, stagedStats);
        }
        assertBound();
    } finally {
        if (descriptor !== null) closeSync(descriptor);
    }
    const emptyPath = join(dirname(path), `.ccc-empty-${randomBytes(16).toString("hex")}`);
    renameSync(path, emptyPath);
    const emptyStats = lstatSync(emptyPath);
    if (!sameDirectoryIdentity(expected, emptyStats)) throw new Error("quarantined-cleanup-target-invalid");
    rmdirSync(emptyPath);
}

export function quarantineAndRemoveDirectory(
    target: string,
    validate: (path: string) => void,
    operations: QuarantineCleanupOperations = {},
): { quarantineRoot: string } {
    const quarantineParent = join(dirname(target), `.ccc-cleanup-${randomBytes(16).toString("hex")}`);
    const quarantineRoot = join(quarantineParent, basename(target));
    validate(target);
    const original = lstatSync(target);
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("quarantined-cleanup-target-invalid");
    mkdirSync(quarantineParent, { mode: 0o700 });
    try {
        (operations.rename ?? renameSync)(target, quarantineRoot);
        validate(quarantineParent);
        validate(quarantineRoot);
        const quarantined = lstatSync(quarantineRoot);
        if (!quarantined.isDirectory() || quarantined.isSymbolicLink() || !sameDirectoryIdentity(original, quarantined)) {
            throw new Error("quarantined-cleanup-target-invalid");
        }
        removeBoundDirectory(quarantineRoot, quarantined, operations.beforeRemove, operations.beforeRemoveEntry);
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
