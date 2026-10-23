import { bindNativeRuntimeInvocation } from "./container-runtime-invocation.js";
import { captureNativeSessionOwnership, removeCapturedNativeSessionOwnership } from "./session-ownership.js";
import { sessionLockOwner } from "../domain/session-lock.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import type { SessionOwnershipReceipt } from "../ports/session-ownership.js";
import type { SessionDeviceCleanupCounts, SessionDeviceCleanupFailure } from "../ports/session-cleanup.js";
import { cleanupOwnerDevices } from "../device-lab-cleanup.js";
import { processStartToken } from "../session-lock-liveness.js";

export function removeNativeSessionClaim(lockFile: string): undefined {
    return removeNativeOwnedSessionClaim(lockFile);
}

export function cleanupNativeSessionDevices(projectPath: string, timeoutMs: number, profile?: string): SessionDeviceCleanupCounts {
    const counts = { stopped: 0, skipped: 0, failed: 0 };
    for (const result of cleanupOwnerDevices(projectPath, timeoutMs, profile).results) {
        counts[result.status]++;
    }
    return counts;
}

export function removeNativeOwnedSessionClaim(lockFile: string): undefined {
    let receipt: SessionOwnershipReceipt;
    try { receipt = captureNativeSessionOwnership(lockFile); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
    }
    const owner = sessionLockOwner(Buffer.from(receipt.bytes, "base64").toString("utf8"));
    if (owner?.ownershipKind !== "direct" || owner.pid !== process.pid
        || !owner.startToken || owner.startToken !== processStartToken(process.pid)) {
        throw new Error("session-cleanup-responsibility-incomplete: Raw claim removal requires this process's direct claim; monitored or uncertain responsibility must be settled before retirement.");
    }
    // The public facade or cleanup composition supplies the already-held guard.
    removeCapturedNativeSessionOwnership(receipt);
    return undefined;
}

export function reportNativeSessionDeviceCleanupFailure(failure: SessionDeviceCleanupFailure): undefined {
    if (failure.kind === "reported-failures") {
        console.error("[ccc] device cleanup failed during session cleanup: one or more devices failed to clean up");
        return undefined;
    }
    const { error } = failure;
    console.error(`[ccc] device cleanup failed during session cleanup: ${error instanceof Error ? error.message : String(error)}`);
}

export function stopNativeSessionContainer(readContainerId: () => string | null, runtimeInvocation: NativeRuntimeInvocation): undefined {
    const runner = bindNativeRuntimeInvocation(runtimeInvocation);
    const containerId = readContainerId();
    if (!containerId || !/^[a-f0-9]{64}$/i.test(containerId)) {
        throw new Error("Container shutdown target is not a full container ID; session cleanup remains incomplete.");
    }
    const listed = runner.spawnSync(["ps", "-aq", "--no-trunc", "-f", `id=${containerId}`], {
        encoding: "utf8", stdio: "pipe", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096,
    });
    if (readContainerId() !== containerId) {
        throw new Error("Container shutdown target changed; session cleanup remains incomplete.");
    }
    if (listed.error || listed.signal || listed.status !== 0 || typeof listed.stdout !== "string") {
        throw new Error("Container shutdown state could not be verified; session cleanup remains incomplete.");
    }
    const observedId = listed.stdout.trim();
    if (observedId !== "" && observedId !== containerId) {
        throw new Error("Container shutdown state is ambiguous; session cleanup remains incomplete.");
    }
    if (readContainerId() !== containerId) {
        throw new Error("Container shutdown target changed; session cleanup remains incomplete.");
    }
    if (observedId === "") return undefined;
    const result = runner.spawnSync(["stop", containerId], {
        stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL",
    });
    if (result.error || result.signal || result.status !== 0) {
        const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
        const errorCode = typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown";
        throw new Error(`Container shutdown failed (status=${result.status ?? "unknown"}, signal=${result.signal ?? "none"}, error=${errorCode}); session cleanup remains incomplete.`);
    }
}

export function setupNativeSessionCleanupSignals(cleanupSession: () => void | Promise<void>): () => void {
    let completion: Promise<void> | null = null;
    let finished = false;
    let disposed = false;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    const exit = () => {
        finished = true;
        dispose();
        process.exit(process.exitCode ?? 0);
    };
    const fail = (error: unknown) => {
        process.exitCode = 1;
        try { console.error("[ccc] Session signal cleanup failed:", error); }
        catch { /* Reporting must not interrupt controlled cleanup completion. */ }
        exit();
    };
    const cleanup = (signal: NodeJS.Signals) => {
        if (finished || disposed) return;
        if (completion) {
            process.once(signal, handlers.get(signal)!);
            return;
        }
        let result: void | Promise<void>;
        try { result = cleanupSession(); }
        catch (error) { return fail(error); }
        if (!result) return exit();
        if (!disposed) process.once(signal, handlers.get(signal)!);
        completion = result.then(exit, fail);
    };

    for (const signal of signals) {
        const handler = () => cleanup(signal);
        handlers.set(signal, handler);
        process.once(signal, handler);
    }
    return dispose;
}
