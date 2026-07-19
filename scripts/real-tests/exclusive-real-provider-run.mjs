import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
    withSharedMutationLock,
    withSharedMutationLockAsync,
} from "../../device-lab-mcp/src/state/shared-mutation-lock.mjs";

const DEFAULT_WAIT_MS = 100;
// A live process on this host or boot owns the lock regardless of run length.
// Dead local PIDs and prior-boot locks are recovered by the shared lock layer.
const DEFAULT_STALE_MS = Number.MAX_SAFE_INTEGER;

export function realProviderRunLockPath(options = {}) {
    return join(options.home || homedir(), ".ccc", "devices", "test-runs", "real-provider.lock");
}

function currentLockSummary(file) {
    try {
        const lock = JSON.parse(readFileSync(file, "utf8"));
        return [
            Number.isInteger(lock?.pid) ? `pid=${lock.pid}` : null,
            typeof lock?.host === "string" ? `host=${lock.host}` : null,
            typeof lock?.createdAt === "string" ? `startedAt=${lock.createdAt}` : null,
        ].filter(Boolean).join(", ");
    } catch {
        return "owner metadata unavailable";
    }
}

function exclusiveRunError(file, label, error) {
    if (error?.code !== "shared-mutation-lock-timeout") return error;
    const conflict = new Error(
        `cannot start ${label}: another real-provider test is already running (${currentLockSummary(file)}). `
        + "Wait for it to finish; test:level3 and real-provider durability runs must not overlap.",
    );
    conflict.code = "real-provider-test-already-running";
    conflict.lockPath = file;
    return conflict;
}

export function withExclusiveRealProviderRunSync(label, operation, options = {}) {
    const file = realProviderRunLockPath(options);
    try {
        return (options.withLock || withSharedMutationLock)(file, operation, {
            waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
            staleMs: options.staleMs ?? DEFAULT_STALE_MS,
        });
    } catch (error) {
        throw exclusiveRunError(file, label, error);
    }
}

export async function withExclusiveRealProviderRun(label, operation, options = {}) {
    const file = realProviderRunLockPath(options);
    try {
        return await (options.withLockAsync || withSharedMutationLockAsync)(file, operation, {
            waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
            staleMs: options.staleMs ?? DEFAULT_STALE_MS,
        });
    } catch (error) {
        throw exclusiveRunError(file, label, error);
    }
}
