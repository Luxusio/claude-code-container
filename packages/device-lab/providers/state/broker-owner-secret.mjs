import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

const AUTH_FILE_LIMIT_BYTES = 4096;

/** @param {number} descriptor @param {number} limitBytes @returns {string} */
function readBoundedUtf8Descriptor(descriptor, limitBytes) {
    const buffer = Buffer.allocUnsafe(limitBytes + 1);
    let total = 0;
    while (total <= limitBytes) {
        const count = readSync(descriptor, buffer, total, buffer.length - total, null);
        if (count === 0) return buffer.subarray(0, total).toString("utf8");
        total += count;
    }
    throw new Error("control-state-file-too-large");
}

/**
 * @param {string} file
 * @param {string} ownerId
 * @param {(descriptor: number) => void} [onVerifiedDescriptor]
 * @returns {string | null}
 */
export function readBrokerOwnerSecret(file, ownerId, onVerifiedDescriptor) {
    let fd = null;
    try {
        const before = lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) return null;
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
        const readFlags = fsConstants.O_RDONLY | noFollow | nonBlock;
        fd = openSync(file, readFlags);
        const stat = fstatSync(fd, { bigint: true });
        const pathStat = lstatSync(file, { bigint: true });
        if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
            || stat.nlink !== 1n || pathStat.nlink !== 1n || stat.dev === 0n || stat.ino <= 0n
            || stat.ino !== pathStat.ino) return null;
        if (stat.dev !== pathStat.dev) {
            // Some supported Windows Node versions omit the pathname's volume ID.
            // Prove it with another opened handle; a zero pathname ID is not proof.
            if (process.platform !== "win32" || pathStat.dev !== 0n || stat.dev === 0n) return null;
            const verificationFd = openSync(file, readFlags);
            try {
                const verification = fstatSync(verificationFd, { bigint: true });
                const currentPath = lstatSync(file, { bigint: true });
                if (!verification.isFile() || verification.nlink !== 1n
                    || verification.dev !== stat.dev || verification.ino !== stat.ino
                    || !currentPath.isFile() || currentPath.isSymbolicLink() || currentPath.nlink !== 1n
                    || currentPath.ino !== verification.ino
                    || (currentPath.dev !== 0n && currentPath.dev !== verification.dev)) return null;
            } finally {
                closeSync(verificationFd);
            }
        }
        if (stat.size > BigInt(AUTH_FILE_LIMIT_BYTES)) return null;
        const parsed = JSON.parse(readBoundedUtf8Descriptor(fd, AUTH_FILE_LIMIT_BYTES));
        if (parsed?.ownerId !== ownerId || typeof parsed.secret !== "string" || !/^[a-f0-9]{64}$/.test(parsed.secret)) return null;
        onVerifiedDescriptor?.(fd);
        return parsed.secret;
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try { closeSync(fd); } catch { /* best effort after a read failure */ }
        }
    }
}

