import {
    STARTUP_LOCK_TIMEOUT_MS, STARTUP_POLL_INTERVAL_MS, STARTUP_POLL_TIMEOUT_MS,
    UPGRADE_SHUTDOWN_GRACE_MS,
} from "../../domain/clipboard/server-lifecycle.js";
import type { ClipboardServerLifecyclePorts } from "../../ports/clipboard/server-lifecycle.js";

export function createClipboardServerLifecycle<Lock, Child>(
    ports: ClipboardServerLifecyclePorts<Lock, Child>,
    serverVersion: string,
) {
    async function ensureClipboardServer(): Promise<number> {
        const bindAddr = "127.0.0.1";
        let existing = ports.readPortFile();
        if (existing) {
            const health = await ports.checkHealth(existing.port, existing.token, bindAddr);
            if (health.alive && health.version === serverVersion) return existing.port;
        }
        const lockPath = ports.startupLockPath();
        let lock = ports.tryAcquireStartupLock(lockPath);
        if (!lock) {
            const deadline = ports.now() + STARTUP_LOCK_TIMEOUT_MS;
            while (ports.now() < deadline) {
                await ports.sleep(STARTUP_POLL_INTERVAL_MS);
                const info = ports.readPortFile();
                if (info && info.token !== existing?.token) {
                    const health = await ports.checkHealth(info.port, info.token, bindAddr);
                    if (health.alive && health.version === serverVersion) return info.port;
                }
                lock = ports.tryAcquireStartupLock(lockPath);
                if (lock) break;
                if (ports.recoverDeadStartupLock(lockPath)) {
                    lock = ports.tryAcquireStartupLock(lockPath);
                    if (lock) {
                        await ports.sleep(UPGRADE_SHUTDOWN_GRACE_MS);
                        break;
                    }
                }
            }
            if (!lock) throw new Error(`Clipboard startup is still owned or its owner cannot be verified: ${lockPath}. Retry after the owner finishes; inspect empty or malformed legacy locks before removing them.`);
        }
        try {
            const current = ports.readPortFile();
            if (current) {
                const health = await ports.checkHealth(current.port, current.token, bindAddr);
                if (health.alive) {
                    if (health.version === serverVersion) return current.port;
                    if (health.version !== serverVersion) {
                        if (ports.portMayHaveBindUsers(ports.portFilePath())) {
                            ports.warnUpgradeDeferred();
                            return current.port;
                        }
                        if (!await ports.requestShutdown(current.port, current.token)) {
                            throw new Error("Failed to acknowledge clipboard server shutdown for upgrade");
                        }
                        await ports.sleep(UPGRADE_SHUTDOWN_GRACE_MS);
                    }
                }
            }
            existing = current;
            const serverScript = ports.daemonScriptPath();
            const child = ports.launchDaemon(serverScript);
            ports.unrefDaemon(child);
            const deadline = ports.now() + STARTUP_POLL_TIMEOUT_MS;
            while (ports.now() < deadline) {
                await ports.sleep(STARTUP_POLL_INTERVAL_MS);
                const info = ports.readPortFile();
                if (info && info.token !== existing?.token) {
                    const health = await ports.checkHealth(info.port, info.token, bindAddr);
                    if (health.alive && health.version === serverVersion) return info.port;
                }
            }
            throw new Error("Clipboard server failed to start within timeout");
        } finally {
            ports.releaseStartupLock(lock);
        }
    }
    function stopClipboardServerIfLast(hasOtherActiveSessions: boolean): void {
        if (hasOtherActiveSessions) return;
        const info = ports.readPortFile();
        if (!info) return;
        if (ports.portMayHaveBindUsers(ports.portFilePath())) return;
        ports.requestShutdown(info.port, info.token);
    }
    function retireClipboardServerFromPortFile(portFile: string): void {
        const info = ports.readPortFile(portFile);
        if (info && !ports.portMayHaveBindUsers(portFile)) ports.requestShutdown(info.port, info.token);
    }
    return { ensureClipboardServer, stopClipboardServerIfLast, retireClipboardServerFromPortFile };
}
