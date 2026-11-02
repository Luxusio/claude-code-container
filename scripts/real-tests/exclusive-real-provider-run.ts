import { homedir } from "os";
import { join } from "path";
import {
    withSharedMutationLock,
    withSharedMutationLockAsync,
} from "#device-lab/providers/state/shared-mutation-lock.mjs";

const DEFAULT_WAIT_MS = 15_000;
// A live process on this host or boot owns the lock regardless of run length.
// Dead local PIDs and prior-boot locks are recovered by the shared lock layer.
const DEFAULT_STALE_MS = Number.MAX_SAFE_INTEGER;

export function realProviderRunLockPath(options: any = {}) {
    return join(options.home || homedir(), ".ccc", "devices", "test-runs", "real-provider.lock");
}

function exclusiveRunError(file, label, error) {
    if (error?.code !== "shared-mutation-lock-timeout") return error;
    const conflict = new Error(
        `cannot start ${label}: the real-provider test lock could not be acquired. `
        + "Retry after checking for other real-provider runs; test:level3 and real-provider durability runs must not overlap.",
        { cause: error },
    );
    Object.assign(conflict, { code: "real-provider-test-lock-unavailable", lockPath: file });
    return conflict;
}

export function withExclusiveRealProviderRunSync(label, operation, options: any = {}) {
    const file = realProviderRunLockPath(options);
    let entered = false;
    try {
        return (options.withLock || withSharedMutationLock)(file, () => {
            entered = true;
            return operation();
        }, {
            waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
            staleMs: options.staleMs ?? DEFAULT_STALE_MS,
        });
    } catch (error) {
        throw entered ? error : exclusiveRunError(file, label, error);
    }
}

export async function withExclusiveRealProviderRun(label, operation, options: any = {}) {
    const file = realProviderRunLockPath(options);
    let entered = false;
    try {
        return await (options.withLockAsync || withSharedMutationLockAsync)(file, () => {
            entered = true;
            return operation();
        }, {
            waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
            staleMs: options.staleMs ?? DEFAULT_STALE_MS,
        });
    } catch (error) {
        throw entered ? error : exclusiveRunError(file, label, error);
    }
}
