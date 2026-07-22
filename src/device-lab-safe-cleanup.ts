import { randomBytes } from "crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, type Stats } from "fs";
import { basename, dirname, join } from "path";

export type QuarantinedCleanupError = Error & { quarantineRoot?: string };
type QuarantineCleanupOperations = { rename?: typeof renameSync; beforeRemove?: (quarantineRoot: string) => void };

function sameDirectoryIdentity(original: Stats, quarantined: Stats): boolean {
    if (original.dev !== quarantined.dev || original.ino !== quarantined.ino) return false;
    if (original.ino !== 0 || quarantined.ino !== 0) return true;
    return original.birthtimeMs === quarantined.birthtimeMs && original.ctimeMs === quarantined.ctimeMs;
}

function removeBoundDirectory(path: string, expected: Stats, beforeRemove?: (path: string) => void): void {
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
            if (childStats.isSymbolicLink() || !childStats.isDirectory()) unlinkSync(child);
            else removeBoundDirectory(child, childStats);
        }
        assertBound();
    } finally {
        if (descriptor !== null) closeSync(descriptor);
    }
    rmdirSync(path);
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
        removeBoundDirectory(quarantineRoot, quarantined, operations.beforeRemove);
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
