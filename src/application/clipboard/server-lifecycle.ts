import {
    STARTUP_LOCK_TIMEOUT_MS, STARTUP_POLL_INTERVAL_MS, STARTUP_POLL_TIMEOUT_MS,
    type ClipboardPortRecord, type ClipboardSelection, type ClipboardHealthResult,
} from "../../domain/clipboard/server-lifecycle.js";
import type { ClipboardServerLifecyclePorts } from "../../ports/clipboard/server-lifecycle.js";

export function createClipboardServerLifecycle<Lock, Child, Guard, Requester>(
    ports: ClipboardServerLifecyclePorts<Lock, Child, Guard, Requester>,
    serverVersion: string,
) {
    const selection = (record: ClipboardPortRecord, portFile = ports.portFilePath()): ClipboardSelection =>
        Object.freeze({ ...record, portFile });
    async function ensureClipboardSelection(requester?: Requester): Promise<ClipboardSelection | null> {
        const bindAddr = "127.0.0.1";
        const existing = ports.readPortFile();
        if (existing && !existing.retired) {
            const health = await ports.checkHealth(existing.port, existing.token, bindAddr);
            if (health.alive && health.version === serverVersion && ports.portRecordMatches(existing, ports.portFilePath())) return selection(existing);
        }
        const lockPath = ports.startupLockPath();
        let lock = ports.tryAcquireStartupLock(lockPath);
        if (!lock) {
            const deadline = ports.now() + STARTUP_LOCK_TIMEOUT_MS;
            while (ports.now() < deadline) {
                await ports.sleep(Math.min(STARTUP_POLL_INTERVAL_MS, deadline - ports.now()));
                if (ports.now() >= deadline) break;
                const info = ports.readPortFile();
                if (info && !info.retired && info.token !== existing?.token) {
                    const health = await ports.checkHealth(info.port, info.token, bindAddr);
                    if (ports.now() >= deadline) break;
                    if (health.alive && health.version === serverVersion && ports.portRecordMatches(info, ports.portFilePath())) return selection(info);
                }
                lock = ports.tryAcquireStartupLock(lockPath);
                if (lock) break;
                if (ports.now() >= deadline) break;
                if (ports.recoverDeadStartupLock(lockPath)) {
                    lock = ports.tryAcquireStartupLock(lockPath);
                    if (lock) break;
                }
            }
            if (!lock) throw new Error(`Clipboard startup is still owned or its owner cannot be verified: ${lockPath}. Retry after the owner finishes; inspect empty or malformed legacy locks before removing them.`);
        }
        try {
            return await ports.withGlobalGuard(async guard => {
                const path = ports.portFilePath();
                const current = ports.readPortFile(path);
                const health: ClipboardHealthResult = current && !current.retired ? await ports.checkHealth(current.port, current.token, bindAddr) : { alive: false };
                if (current && !ports.portRecordMatches(current, path)) return null;
                if (current && !current.retired && health.alive && health.version === serverVersion) return selection(current, path);
                const defer = () => {
                    ports.warnUpgradeDeferred();
                    return current && !current.retired && health.alive ? selection(current, path) : null;
                };
                if (ports.hasOtherSessions(requester)) return defer();
                let publish = ports.preparePublication(path, guard);
                if (!publish) return defer();
                if (current && !current.retired) {
                    // Silence and a legacy HTTP 200 do not settle a previous writer.
                    if (!health.alive || health.retirement !== "writer-settlement-v1" || !ports.portRecordMatches(current, path)
                        || ports.hasOtherSessions(requester)) return defer();
                    if (!await ports.requestShutdown(current.port, current.token)) return defer();
                    ports.markRetired(current, path, guard);
                    if (ports.hasOtherSessions(requester)) return null;
                    publish = ports.preparePublication(path, guard);
                    if (!publish) return null;
                }
                if (ports.hasOtherSessions(requester)) return null;
                const publishRecord = publish;
                const child = await ports.launchDaemon(ports.daemonScriptPath(), record => {
                    if (ports.hasOtherSessions(requester)) throw new Error("Clipboard session ownership changed before publication");
                    return publishRecord(record);
                });
                ports.unrefDaemon(child);
                const deadline = ports.now() + STARTUP_POLL_TIMEOUT_MS;
                while (ports.now() < deadline) {
                    await ports.sleep(Math.min(STARTUP_POLL_INTERVAL_MS, deadline - ports.now()));
                    if (ports.now() >= deadline) break;
                    const info = ports.readPortFile(path);
                    if (info && !info.retired && info.token !== current?.token) {
                        const observed = await ports.checkHealth(info.port, info.token, bindAddr);
                        if (ports.now() >= deadline) break;
                        if (observed.alive && observed.version === serverVersion && ports.portRecordMatches(info, path)) return selection(info, path);
                    }
                }
                throw new Error("Clipboard server failed to start within timeout");
            });
        } finally {
            ports.releaseStartupLock(lock);
        }
    }
    async function ensureClipboardServer(requester?: Requester): Promise<number> {
        const selected = await ensureClipboardSelection(requester);
        if (!selected) throw new Error("Clipboard publication deferred because shared ownership could not be excluded");
        return selected.port;
    }
    async function retireClipboardServerFromPortFile(portFile: string): Promise<void> {
        if (!ports.readPortFile(portFile)) return;
        const lock = ports.tryAcquireStartupLock(ports.startupLockPath());
        if (!lock) return;
        try {
            await ports.withGlobalGuard(async guard => {
                if (ports.hasOtherSessions()) return;
                const info = ports.readPortFile(portFile);
                if (!info || info.retired || ports.portMayHaveBindUsers(portFile, guard)) return;
                const health = await ports.checkHealth(info.port, info.token, "127.0.0.1");
                if (!health.alive || health.retirement !== "writer-settlement-v1" || !ports.portRecordMatches(info, portFile) || ports.hasOtherSessions()) return;
                if (await ports.requestShutdown(info.port, info.token)) ports.markRetired(info, portFile, guard);
            });
        } finally { ports.releaseStartupLock(lock); }
    }
    async function stopClipboardServerIfLast(hasOtherActiveSessions: boolean): Promise<void> {
        if (!hasOtherActiveSessions) await retireClipboardServerFromPortFile(ports.portFilePath());
    }
    return { ensureClipboardSelection, ensureClipboardServer, stopClipboardServerIfLast, retireClipboardServerFromPortFile };
}
