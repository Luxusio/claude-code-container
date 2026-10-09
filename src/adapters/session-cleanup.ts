import { spawnSync } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { runtimeCli } from "../container-runtime.js";
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

export function stopNativeSessionContainer(readContainerId: () => string | null): undefined {
    const result = spawnSync(runtimeCli(), ["stop", readContainerId()!], {
        stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL",
    });
    if (result.error || result.signal || result.status !== 0) {
        const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
        const errorCode = typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown";
        throw new Error(`Container shutdown failed (status=${result.status ?? "unknown"}, signal=${result.signal ?? "none"}, error=${errorCode}); session cleanup remains incomplete.`);
    }
}

export function setupNativeSessionCleanupSignals(cleanupSession: () => void): void {
    const cleanup = () => {
        cleanupSession();
        process.exit(process.exitCode ?? 0);
    };

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.once("SIGHUP", cleanup);
}
