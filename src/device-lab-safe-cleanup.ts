import { randomBytes } from "crypto";
import { existsSync, lstatSync, renameSync, rmSync, type Stats } from "fs";
import { basename, dirname, join } from "path";

export type QuarantinedCleanupError = Error & { quarantineRoot?: string };
type QuarantineCleanupOperations = { rename?: typeof renameSync };

function sameDirectoryIdentity(original: Stats, quarantined: Stats): boolean {
    if (original.dev !== quarantined.dev || original.ino !== quarantined.ino) return false;
    if (original.ino !== 0 || quarantined.ino !== 0) return true;
    return original.birthtimeMs === quarantined.birthtimeMs && original.ctimeMs === quarantined.ctimeMs;
}

export function quarantineAndRemoveDirectory(
    target: string,
    validate: (path: string) => void,
    operations: QuarantineCleanupOperations = {},
): { quarantineRoot: string } {
    const quarantineRoot = join(dirname(target), `.${basename(target)}.${randomBytes(16).toString("hex")}.cleanup`);
    validate(target);
    const original = lstatSync(target);
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("quarantined-cleanup-target-invalid");
    (operations.rename ?? renameSync)(target, quarantineRoot);
    try {
        validate(quarantineRoot);
        const quarantined = lstatSync(quarantineRoot);
        if (!quarantined.isDirectory() || quarantined.isSymbolicLink() || !sameDirectoryIdentity(original, quarantined)) {
            throw new Error("quarantined-cleanup-target-invalid");
        }
        rmSync(quarantineRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (existsSync(quarantineRoot)) throw new Error("quarantined-cleanup-target-remains");
        return { quarantineRoot };
    } catch (error) {
        const cleanupError = (error instanceof Error ? error : new Error(String(error))) as QuarantinedCleanupError;
        cleanupError.quarantineRoot = quarantineRoot;
        throw cleanupError;
    }
}
