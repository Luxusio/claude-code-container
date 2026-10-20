import { ownedCleanupRuntimes, lifecycleActive, lifecycleStopRequired, cleanedDevice, shouldCleanupDevice } from "../domain/device-admin-cleanup.js";
import type { CleanupBackend, CleanupRecord as DeviceRecord, CleanupCommandResult as CommandResult, CleanupDeviceResult, CleanupStopEffect, CleanupAllProjectsResult } from "../domain/device-admin-cleanup.js";
import type { DeviceAdminCleanupPorts, DeviceAdminAllProjectCleanupPorts } from "../ports/device-admin-cleanup.js";
export function createDeviceAdminCleanup<Backend extends CleanupBackend>(ports: DeviceAdminCleanupPorts<Backend>) {
    function stopOwnedDevice(ownerId: string, match: { backend: Backend; device: DeviceRecord }, timeoutMs = 5000): { commands: CommandResult[]; ok: boolean; reason?: string } {
        const results: CommandResult[] = [];
        const runtimes = ownedCleanupRuntimes(match.device);
        for (const runtime of runtimes) {
            if (!runtime.signalDirectly || ports.runtimeExited(runtime)) continue;
            const signal = ports.signalRuntime(runtime.runtime, runtime.signal);
            if (!signal.ok) return { commands: results, ok: false, reason: `${runtime.label}-process-signal-failed` };
        }

        const effects: CleanupStopEffect[] = [];
        const active = lifecycleActive(match.device);
        if (match.backend.stateKey === "android" || match.backend.stateKey === "android-device") {
            if (match.device.recording) effects.push({ kind: "android-recording-stop", device: match.device });
            if (match.backend.stateKey === "android" && active) effects.push({ kind: "android-emulator-stop", device: match.device });
        } else if (match.backend.stateKey === "ios" && active) {
            effects.push({ kind: "ios-simulator-stop", device: match.device });
        } else if (match.backend.stateKey === "windows" && active) {
            effects.push({ kind: "windows-sandbox-stop", ownerId, device: match.device });
        } else if (match.backend.stateKey === "macos" && active) {
            effects.push({ kind: "macos-instance-stop", device: match.device });
        }
        const stopped = ports.executeStopEffects(effects, timeoutMs);
        results.push(...stopped.commands);
        for (const runtime of runtimes) {
            if (!ports.waitForRuntimeExit(runtime, timeoutMs)) {
                return { commands: results, ok: stopped.ok, reason: `${runtime.label}-process-still-active` };
            }
        }
        return { commands: results, ok: stopped.ok };
    }

    function commitCleanedDevice(
        ownerId: string,
        backend: Backend,
        current: DeviceRecord,
        releaseWindowsClaim: boolean,
    ): boolean {
        if (!ports.hardwareId(backend, current)) {
            const matched = ports.transitionRecord(ownerId, backend, current, { ...cleanedDevice(backend, current), updatedAt: ports.timestamp() }).matched;
            if (matched && releaseWindowsClaim) ports.releaseWindowsClaim(ownerId, backend, current);
            return matched;
        }
        return ports.transitionPhysicalRecord(ownerId, backend, current, { ...cleanedDevice(backend, current), updatedAt: ports.timestamp() });
    }

    function stopRecord(
        ownerId: string,
        backend: Backend,
        expected: DeviceRecord,
        timeoutMs?: number,
        releaseWindowsClaim = false,
    ): CleanupDeviceResult {
        const id = expected.id || "(unknown)";
        if (!expected.id) {
            return { id, backend: backend.name, previousStatus: expected.status || "unknown", status: "failed", commands: [], reason: "owner-device-id-missing" };
        }
        return ports.withRecordLock(ownerId, backend.stateKey, expected.id, () => {
            const current = ports.readDevices(ownerId, backend.stateKey).find((candidate) => candidate.id === expected.id);
            if (!current || !ports.sameRecord(current, expected)) {
                return { id, backend: backend.name, previousStatus: expected.status || "unknown", status: "failed", commands: [], reason: "owner-device-state-conflict" };
            }
            const appiumBlock = ports.appiumCleanupBlock(current);
            if (appiumBlock) {
                return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands: [], reason: appiumBlock };
            }
            const ownedRuntimeBlock = ports.runtimeCleanupBlock(current);
            if (ownedRuntimeBlock) {
                return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands: [], reason: ownedRuntimeBlock };
            }
            const stopped = stopOwnedDevice(ownerId, { backend, device: current }, timeoutMs);
            const commands = stopped.commands;
            if (stopped.reason) {
                return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands, reason: stopped.reason };
            }
            if (lifecycleStopRequired(backend, current) && !stopped.ok) {
                return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands, reason: "provider-stop-failed" };
            }
            if (!commitCleanedDevice(ownerId, backend, current, releaseWindowsClaim)) {
                return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands, reason: "owner-device-state-conflict" };
            }
            return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "stopped", commands };
        });
    }

    function owner(cwd: string, timeoutMs = 5000, profile?: string): { ownerId: string; results: CleanupDeviceResult[] } {
        const ownerId = ports.resolveOwnerId(cwd, profile);
        const results: CleanupDeviceResult[] = [];
        for (const backend of ports.backends) {
            const devices = ports.readDevices(ownerId, backend.stateKey);
            devices.forEach((device) => {
                if (!device.id || !shouldCleanupDevice(backend, device)) {
                    results.push({
                        id: device.id || "(unknown)",
                        backend: backend.name,
                        previousStatus: device.status || "unknown",
                        status: "skipped",
                        commands: [],
                    });
                    return;
                }

                results.push(stopRecord(ownerId, backend, device, timeoutMs, true));
            });
        }
        return { ownerId, results };
    }
    return { owner, stopRecord };
}
export function createDeviceAdminAllProjectCleanup<Backend extends CleanupBackend>(ports: DeviceAdminAllProjectCleanupPorts<Backend>) {
     const cleanup = createDeviceAdminCleanup(ports);
    function allProjects(timeoutMs = 5000): CleanupAllProjectsResult {
        const projects: CleanupAllProjectsResult["projects"] = [];
        let ok = true;
        for (const ownerId of ports.enumerateOwnerIds()) {
            const results: CleanupDeviceResult[] = [];
            for (const backend of ports.backends) {
                for (const device of ports.readDevices(ownerId, backend.stateKey)) {
                    if (!device.id || !shouldCleanupDevice(backend, device)) {
                        results.push({
                            id: device.id || "(unknown)",
                            backend: backend.name,
                            previousStatus: device.status || "unknown",
                            status: "skipped",
                            commands: [],
                        });
                        continue;
                    }
                    const result = cleanup.stopRecord(ownerId, backend, device, timeoutMs);
                    if (result.status !== "stopped") ok = false;
                    results.push(result);
                }
            }
            projects.push({ ownerId, results });
        }
        return { ok, projects };
    }

    return { allProjects };
}
