import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";
import { processStartToken, sessionLockLiveness } from "./session-lock-liveness.js";

interface LockSnapshot { dev: number; ino: number; content: string }
export interface ClipboardStartupLock extends LockSnapshot { path: string; fd: number }
const noFollow = constants.O_NOFOLLOW ?? 0;

function snapshot(path: string): LockSnapshot | null {
    let fd: number | undefined;
    try {
        fd = openSync(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
        const s = fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || s.size > 4096 || (process.getuid && s.uid !== process.getuid())) return null;
        return { dev: s.dev, ino: s.ino, content: readFileSync(fd, "utf-8") };
    } catch { return null; }
    finally { if (fd !== undefined) closeSync(fd); }
}
function matches(path: string, expected: LockSnapshot): boolean {
    const current = snapshot(path);
    return current !== null && current.dev === expected.dev && current.ino === expected.ino && current.content === expected.content;
}

export function tryAcquireClipboardStartupLock(path: string): ClipboardStartupLock | null {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let fd: number;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
        throw error;
    }
    try {
        const s = fstatSync(fd);
        const content = JSON.stringify({ version: 2, pid: process.pid, startToken: processStartToken(process.pid), nonce: randomBytes(16).toString("hex") });
        writeFileSync(fd, content);
        return { path, fd, content, dev: s.dev, ino: s.ino };
    } catch (error) {
        closeSync(fd); // An incomplete record remains unknown, never age-reclaimed.
        throw error;
    }
}

export function releaseClipboardStartupLock(lock: ClipboardStartupLock): void {
    try { if (matches(lock.path, lock)) unlinkSync(lock.path); }
    finally { closeSync(lock.fd); }
}

function isDeadOwner(existing: LockSnapshot): boolean {
    let record: { version?: unknown; pid?: unknown; startToken?: unknown; nonce?: unknown };
    try { record = JSON.parse(existing.content); } catch { return false; }
    if (!record || record.version !== 2 || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
        || typeof record.nonce !== "string" || !/^[a-f0-9]{32}$/.test(record.nonce)
        || (record.startToken !== null && typeof record.startToken !== "string")) return false;
    const ownership = typeof record.startToken === "string" ? existing.content : String(record.pid);
    return sessionLockLiveness(ownership) === "stale";
}

/** Serializes stale removal so two waiters cannot unlink each other's new lock. */
export function recoverDeadClipboardStartupLock(path: string): boolean {
    const guard = `${path}.recovery`;
    const refusal = () => new Error(`Clipboard lock recovery is already owned or cannot be verified: ${guard}. Retry after its owner exits; inspect leftover ownership before removing it.`);
    try { lstatSync(guard); throw refusal(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const existing = snapshot(path);
    if (!existing || !isDeadOwner(existing)) return false;
    try { mkdirSync(guard, { mode: 0o700 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw refusal();
        throw error;
    }
    const held = lstatSync(guard);
    try {
        if (!matches(path, existing) || !isDeadOwner(existing)) return false;
        unlinkSync(path);
        return true;
    } finally {
        const current = lstatSync(guard);
        if (current.dev === held.dev && current.ino === held.ino) rmdirSync(guard);
    }
}
