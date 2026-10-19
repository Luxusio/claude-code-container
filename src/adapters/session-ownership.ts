import { spawn } from "child_process";
import { closeSync, fstatSync, openSync, readSync, unlinkSync, lstatSync } from "fs";
import { fileURLToPath } from "url";
import { sessionLockOwner } from "../domain/session-lock.js";
import type { SessionOwnershipChannel, SessionOwnershipReceipt } from "../ports/session-ownership.js";
import type { NativeSessionFileReceipt } from "../ports/session-claim-observation.js";

export { validateNativeRuntimeInvocation as decodeNativeSessionRuntimeInvocation } from "./container-runtime-invocation.js";

export function captureNativeSessionFile(path: string, maximumBytes: number): NativeSessionFileReceipt {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > 65536) {
        throw new TypeError("Invalid session file byte limit.");
    }
    const named = lstatSync(path, { bigint: true });
    if (!named.isFile()) throw new Error("Invalid session ownership receipt.");
    const fd = openSync(path, "r");
    try {
        const stat = fstatSync(fd, { bigint: true });
        const windowsUnnamedDevice = process.platform === "win32" && named.dev === 0n;
        if (!stat.isFile() || stat.size > BigInt(maximumBytes) || stat.ino !== named.ino || stat.birthtimeNs !== named.birthtimeNs
            || (!windowsUnnamedDevice && stat.dev !== named.dev)) throw new Error("Invalid session ownership receipt.");
        if (windowsUnnamedDevice) {
            // Some Windows libuv versions omit the volume from path stats. Two
            // opened handles must still prove the exact volume and file identity.
            if (stat.dev <= 0n || stat.ino <= 0n) throw new Error("Invalid session ownership receipt.");
            const secondFd = openSync(path, "r");
            try {
                const second = fstatSync(secondFd, { bigint: true });
                if (!second.isFile() || second.size > BigInt(maximumBytes) || second.size !== stat.size
                    || second.dev !== stat.dev || second.ino !== stat.ino
                    || second.birthtimeNs !== stat.birthtimeNs) throw new Error("Invalid session ownership receipt.");
                const currentNamed = lstatSync(path, { bigint: true });
                if (!currentNamed.isFile() || currentNamed.ino !== stat.ino || currentNamed.birthtimeNs !== stat.birthtimeNs
                    || (currentNamed.dev !== 0n && currentNamed.dev !== stat.dev)) throw new Error("Invalid session ownership receipt.");
            } finally {
                closeSync(secondFd);
            }
        }
        const buffer = Buffer.alloc(maximumBytes + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length, length);
            if (count === 0) break;
            length += count;
        }
        const after = fstatSync(fd, { bigint: true });
        const current = lstatSync(path, { bigint: true });
        if (length > maximumBytes || BigInt(length) !== stat.size || after.size !== stat.size || after.ino !== stat.ino
            || after.dev !== stat.dev || after.birthtimeNs !== stat.birthtimeNs || after.mtimeNs !== stat.mtimeNs
            || after.ctimeNs !== stat.ctimeNs || !current.isFile() || current.ino !== stat.ino
            || current.birthtimeNs !== stat.birthtimeNs || (!windowsUnnamedDevice && current.dev !== stat.dev)
            || (windowsUnnamedDevice && current.dev !== 0n && current.dev !== stat.dev)) {
            throw new Error("Session file changed while being captured.");
        }
        return Object.freeze({
            path, bytes: buffer.subarray(0, length).toString("base64"), device: String(stat.dev), inode: String(stat.ino),
            birthtime: String(stat.birthtimeNs),
        });
    } finally {
        closeSync(fd);
    }
}

export function captureNativeSessionOwnership(path: string): SessionOwnershipReceipt {
    const file = captureNativeSessionFile(path, 4096);
    const owner = sessionLockOwner(Buffer.from(file.bytes, "base64").toString("utf8"));
    if (!owner) throw new Error("Invalid session ownership record.");
    return { ...file, ownerPid: owner.pid };
}

export function nativeSessionOwnershipMatches(receipt: SessionOwnershipReceipt): boolean {
    try {
        const current = captureNativeSessionOwnership(receipt.path);
        return current.bytes === receipt.bytes && current.device === receipt.device
            && current.inode === receipt.inode && current.birthtime === receipt.birthtime
            && current.ownerPid === receipt.ownerPid;
    } catch {
        // Missing, unreadable, and replacement files cannot authorize effects.
        return false;
    }
}

export function removeCapturedNativeSessionOwnership(receipt: SessionOwnershipReceipt): undefined {
    if (!nativeSessionOwnershipMatches(receipt)) throw new Error("Session ownership receipt changed before removal.");
    unlinkSync(receipt.path);
}

export function launchNativeSessionOwnership(): SessionOwnershipChannel {
    const child = spawn(process.execPath, [
        fileURLToPath(new URL("../session-ownership-guardian.js", import.meta.url)), String(process.pid),
    ], {
        detached: true, windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "json",
    });
    return {
        pid: child.pid,
        send(message) {
            return new Promise((resolve, reject) => {
                if (!child.connected) { reject(new Error("Session ownership guardian IPC is closed.")); return; }
                child.send(message, (error) => error ? reject(error) : resolve());
            });
        },
        onMessage(listener) {
            child.on("message", listener);
            return () => { child.off("message", listener); };
        },
        onLoss(listener) {
            const exit = () => listener(new Error("Session ownership guardian exited unexpectedly."));
            const disconnect = () => listener(new Error("Session ownership guardian IPC disconnected unexpectedly."));
            child.on("error", listener);
            child.on("exit", exit);
            child.on("disconnect", disconnect);
            return () => {
                child.off("error", listener);
                child.off("exit", exit);
                child.off("disconnect", disconnect);
            };
        },
        unref() { child.unref(); child.channel?.unref(); },
        close() {
            // Leave an error sink for a queued native spawn/send error after disposal.
            child.on("error", () => undefined);
            if (child.connected) child.disconnect();
            child.kill();
            child.unref();
            child.channel?.unref();
        },
    };
}
