import { existsSync, unlinkSync } from "fs";
import { bindNativeRuntimeInvocation } from "./container-runtime-invocation.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import { cleanupOwnerDevices } from "../device-lab-cleanup.js";

export function removeNativeSessionClaim(lockFile: string): undefined {
    try {
        if (existsSync(lockFile)) {
            unlinkSync(lockFile);
        }
    } catch {
        // Ignore errors during cleanup
    }
}

export function cleanupNativeSessionDevices(projectPath: string, timeoutMs: number, profile?: string): undefined {
    cleanupOwnerDevices(projectPath, timeoutMs, profile);
}

export function removeNativeOwnedSessionClaim(lockFile: string): undefined {
    try { unlinkSync(lockFile); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return undefined;
}

export function reportNativeSessionDeviceCleanupFailure(error: unknown): undefined {
    console.error(`[ccc] device cleanup failed during session cleanup: ${error instanceof Error ? error.message : String(error)}`);
}

export function stopNativeSessionContainer(readContainerId: () => string | null, runtimeInvocation: NativeRuntimeInvocation): undefined {
    const runner = bindNativeRuntimeInvocation(runtimeInvocation);
    const result = runner.spawnSync(["stop", readContainerId()!], {
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
