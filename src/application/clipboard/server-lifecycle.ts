import {
    STARTUP_LOCK_TIMEOUT_MS, STARTUP_POLL_INTERVAL_MS, STARTUP_POLL_TIMEOUT_MS,
    type ClipboardPortRecord, type ClipboardSelection, type ClipboardHealthResult,
    type ClipboardSessionPresence, type ClipboardUpgradeDeferral, type ClipboardUpgradeDeferralReason,
} from "../../domain/clipboard/server-lifecycle.js";
import type { ClipboardServerLifecyclePorts } from "../../ports/clipboard/server-lifecycle.js";

export function createClipboardServerLifecycle<Lock, Child, Guard, Requester>(
    ports: ClipboardServerLifecyclePorts<Lock, Child, Guard, Requester>,
    serverVersion: string,
) {
    const generation = ports.generation === serverVersion && /^[a-f0-9]{12}$/.test(serverVersion) ? serverVersion : undefined;
    const selection = (record: ClipboardPortRecord, portFile = ports.portFilePath(), current = false): ClipboardSelection =>
        Object.freeze({ ...record, portFile, ...(current && generation ? { generation } : {}) });
    const sessionPresence = (requester?: Requester): ClipboardSessionPresence =>
        ports.observeOtherSessions?.(requester) ?? (ports.hasOtherSessions(requester) ? "unknown" : "absent");
    const sessionReason = (presence: ClipboardSessionPresence): "session-active" | "session-unknown" =>
        presence === "active" ? "session-active" : "session-unknown";
    async function selectClipboard(requester?: Requester,
        onDeferred?: (detail: ClipboardUpgradeDeferral) => void): Promise<ClipboardSelection | null> {
        const bindAddr = "127.0.0.1";
        const existing = ports.readPortFile();
        if (existing && !existing.retired) {
            const health = await ports.checkHealth(existing.port, existing.token, bindAddr);
            if (health.alive && health.version === serverVersion && ports.portRecordMatches(existing, ports.portFilePath())) return selection(existing, ports.portFilePath(), true);
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
                    if (health.alive && health.version === serverVersion && ports.portRecordMatches(info, ports.portFilePath())) return selection(info, ports.portFilePath(), true);
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
                let health: ClipboardHealthResult = current && !current.retired ? await ports.checkHealth(current.port, current.token, bindAddr) : { alive: false };
                let retired = current?.retired === true;
                const defer = (reason: ClipboardUpgradeDeferralReason, mayReuse = true) => {
                    const available = !!(mayReuse && current && !retired && health.alive && ports.portRecordMatches(current, path));
                    const detail: ClipboardUpgradeDeferral = { reason, existingBridgeAvailable: available };
                    ports.warnUpgradeDeferred(detail);
                    onDeferred?.(detail);
                    return available ? selection(current!, path) : null;
                };
                if (current && !ports.portRecordMatches(current, path)) return defer("writer-changed", false);
                if (current && !retired && health.alive && health.version === serverVersion) return selection(current, path, true);
                // Only native admission of a fresh, disjoint generation can coexist
                // with other sessions. Existing writers retain every original veto.
                const concurrentCreation = !!generation && current === null;
                let presence = concurrentCreation ? "absent" as const : sessionPresence(requester);
                if (presence !== "absent") return defer(sessionReason(presence));
                let prepared = ports.preparePublication(path, guard);
                if (prepared.kind === "deferred") return defer(prepared.reason);
                let publish = prepared.publish;
                try {
                    if (current && !retired) {
                        // Silence and a legacy HTTP 200 do not settle a previous writer.
                        if (!health.alive) return defer("writer-unavailable", false);
                        if (health.retirement !== "writer-settlement-v1") return defer("writer-unsupported");
                        if (!ports.portRecordMatches(current, path)) return defer("writer-changed", false);
                        presence = sessionPresence(requester);
                        if (presence !== "absent") return defer(sessionReason(presence));
                        let settled = false;
                        try { settled = await ports.requestShutdown(current.port, current.token); }
                        catch { /* Only authenticated health can establish a usable fallback after failed shutdown. */ }
                        if (!settled) {
                            try { health = await ports.checkHealth(current.port, current.token, bindAddr); }
                            catch { health = { alive: false }; }
                            return defer("writer-shutdown-failed");
                        }
                        ports.markRetired(current, path, guard);
                        retired = true;
                        presence = sessionPresence(requester);
                        if (presence !== "absent") return defer(sessionReason(presence), false);
                        publish.dispose?.();
                        prepared = ports.preparePublication(path, guard);
                        if (prepared.kind === "deferred") return defer(prepared.reason, false);
                        publish = prepared.publish;
                    }
                    presence = concurrentCreation ? "absent" : sessionPresence(requester);
                    if (presence !== "absent") return defer(sessionReason(presence));
                    const publishRecord = publish;
                    const child = await ports.launchDaemon(ports.daemonScriptPath(), record => {
                        const presence = concurrentCreation ? "absent" : sessionPresence(requester);
                        if (presence !== "absent") throw new Error(`Clipboard session ownership changed before publication (${sessionReason(presence)})`);
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
                            if (observed.alive && observed.version === serverVersion && ports.portRecordMatches(info, path)) return selection(info, path, true);
                        }
                    }
                    throw new Error("Clipboard server failed to start within timeout");
                } finally { publish?.dispose?.(); }
            });
        } finally {
            ports.releaseStartupLock(lock);
        }
    }
    async function ensureClipboardSelection(requester?: Requester): Promise<ClipboardSelection | null> {
        return selectClipboard(requester);
    }
    async function ensureClipboardServer(requester?: Requester): Promise<number> {
        let reason: ClipboardUpgradeDeferralReason = "publication-unverified";
        const selected = await selectClipboard(requester, detail => { reason = detail.reason; });
        if (!selected) throw new Error(`Clipboard unavailable (${reason}).`);
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
