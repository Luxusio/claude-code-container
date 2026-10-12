import { closeSync, constants, fstatSync, lstatSync, openSync, promises as fsPromises, type BigIntStats } from 'fs';

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
    return left.dev > 0n && left.ino > 0n && left.dev === right.dev && left.ino === right.ino
        && left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory()
        && !left.isSymbolicLink() && !right.isSymbolicLink()
        && (!left.isFile() || (left.nlink === 1n && right.nlink === 1n && left.size === right.size));
}
function namedObject(opened: BigIntStats, named: BigIntStats): boolean {
    return !named.isSymbolicLink() && opened.ino === named.ino
        && opened.isFile() === named.isFile() && opened.isDirectory() === named.isDirectory()
        && (!opened.isFile() || (named.nlink === 1n && opened.size === named.size))
        && (named.dev === opened.dev || (process.platform === 'win32' && named.dev === 0n));
}
function assertIdentity(opened: BigIntStats, named: BigIntStats, expected: BigIntStats | undefined, label: string): void {
    if (opened.dev <= 0n || opened.ino <= 0n || (!opened.isFile() && !opened.isDirectory())
        || (opened.isFile() && opened.nlink !== 1n) || !namedObject(opened, named)
        || (expected && !sameObject(expected, opened))) throw new Error(`${label}-identity-changed`);
}
const readFlags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0);

/** Qualifies pathname observations against positive, exact native handle identity. */
export function readDeviceLabFileIdentity(path: string, label: string, expected?: BigIntStats): BigIntStats {
    const initial = lstatSync(path, { bigint: true });
    if (initial.isSymbolicLink()) throw new Error(`${label}-identity-changed`);
    const descriptor = openSync(path, readFlags);
    try {
        const opened = fstatSync(descriptor, { bigint: true });
        assertIdentity(opened, initial, expected, label);
        {
            const verification = openSync(path, readFlags);
            try {
                if (!sameObject(opened, fstatSync(verification, { bigint: true }))) throw new Error(`${label}-identity-changed`);
                assertIdentity(opened, lstatSync(path, { bigint: true }), expected, label);
            } finally { closeSync(verification); }
        }
        return opened;
    } finally { closeSync(descriptor); }
}

export async function readDeviceLabFileIdentityAsync(path: string, label: string, expected?: BigIntStats): Promise<BigIntStats> {
    const initial = await fsPromises.lstat(path, { bigint: true });
    if (initial.isSymbolicLink()) throw new Error(`${label}-identity-changed`);
    const descriptor = await fsPromises.open(path, readFlags);
    try {
        const opened = await descriptor.stat({ bigint: true });
        assertIdentity(opened, initial, expected, label);
        {
            const verification = await fsPromises.open(path, readFlags);
            try {
                if (!sameObject(opened, await verification.stat({ bigint: true }))) throw new Error(`${label}-identity-changed`);
                assertIdentity(opened, await fsPromises.lstat(path, { bigint: true }), expected, label);
            } finally { await verification.close(); }
        }
        return opened;
    } finally { await descriptor.close(); }
}
