import { ownedCleanupRuntimes, serialForAndroid, lifecycleActive, simctlTarget, isGuid, stopMacosArgs, lifecycleStopFailed, cleanedDevice, shouldCleanupDevice } from "../domain/device-admin-cleanup.js";
import type { CleanupBackend, CleanupRecord as DeviceRecord, CleanupCommandResult as CommandResult, CleanupDeviceResult } from "../domain/device-admin-cleanup.js";
import type { DeviceAdminCleanupPorts, DeviceAdminAllProjectCleanupPorts } from "../ports/device-admin-cleanup.js";
export function createDeviceAdminCleanup<Backend extends CleanupBackend>(ports: DeviceAdminCleanupPorts<Backend>) {
    function stopOwnedDevice(match: { backend: Backend; device: DeviceRecord }, timeoutMs = 5000): { commands: CommandResult[]; reason?: string } {
        const results: CommandResult[] = [];
        const runtimes = ownedCleanupRuntimes(match.device);
        for (const runtime of runtimes) {
            if (!runtime.signalDirectly || ports.runtimeExited(runtime)) continue;
            const signal = ports.signalRuntime(runtime.runtime, runtime.signal);
            if (!signal.ok) return { commands: results, reason: `${runtime.label}-process-signal-failed` };
        }

        if (match.backend.stateKey === "android") {
            const adb = ports.commandPath("adb");
            const serial = serialForAndroid(match.device);
            if (adb && serial && match.device.recording) {
                const result = ports.runCommand(adb, ["-s", serial, "shell", "pkill", "-2", "screenrecord"], timeoutMs);
                if (result) results.push(result);
            }
            if (adb && serial && lifecycleActive(match.device)) {
                const result = ports.runCommand(adb, ["-s", serial, "emu", "kill"], timeoutMs);
                if (result) results.push(result);
            }
        } else if (match.backend.stateKey === "android-device") {
            const adb = ports.commandPath("adb");
            const serial = serialForAndroid(match.device);
            if (adb && serial && match.device.recording) {
                const result = ports.runCommand(adb, ["-s", serial, "shell", "pkill", "-2", "screenrecord"], timeoutMs);
                if (result) results.push(result);
            }
        } else if (match.backend.stateKey === "ios") {
            const xcrun = ports.commandPath("xcrun");
            const target = simctlTarget(match.device);
            if (xcrun && target && lifecycleActive(match.device)) {
                const result = ports.runCommand(xcrun, ["simctl", "shutdown", target], timeoutMs);
                if (result) results.push(result);
            }
        } else if (match.backend.stateKey === "ios-device") {
            // Physical iOS devices are never powered off or disconnected by cleanup.
        } else if (match.backend.stateKey === "windows") {
            if (lifecycleActive(match.device)) {
                const sandboxId = isGuid(match.device.sandboxId) ? match.device.sandboxId : null;
                const result = sandboxId ? ports.runCommand(ports.commandPath("wsb"), ["stop", "--id", sandboxId], timeoutMs) : null;
                if (result) results.push(result);
            }
        } else if (match.backend.stateKey === "macos") {
            const provider = typeof match.device.provider === "string" ? match.device.provider : null;
            const instance = typeof match.device.providerInstance === "string" ? match.device.providerInstance : null;
            if (provider && instance && lifecycleActive(match.device)) {
                const args = stopMacosArgs(provider, instance);
                if (args) {
                    const result = ports.runCommand(ports.commandPath(provider), args, timeoutMs);
                    if (result) results.push(result);
                }
            }
        }
        for (const runtime of runtimes) {
            if (!ports.waitForRuntimeExit(runtime, timeoutMs)) {
                return { commands: results, reason: `${runtime.label}-process-still-active` };
            }
        }
        return { commands: results };
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
            const stopped = stopOwnedDevice({ backend, device: current }, timeoutMs);
            const commands = stopped.commands;
            if (stopped.reason) {
                return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands, reason: stopped.reason };
            }
            if (lifecycleStopFailed(backend, current, commands)) {
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
    function allProjects(timeoutMs = 5000): { ok: boolean; text: string } {
        const lines = ["projects: stop --all-projects"];
        let stopped = 0;
        let skipped = 0;
        let failed = 0;
        for (const ownerId of ports.enumerateOwnerIds()) {
            lines.push(`project: ${ownerId}`);
            for (const backend of ports.backends) {
                const devices = ports.readDevices(ownerId, backend.stateKey);
                devices.forEach((device) => {
                    if (!device.id || !shouldCleanupDevice(backend, device)) {
                        skipped += 1;
                        lines.push(`skipped: ${device.id || "(unknown)"}  backend=${backend.name}  status=${device.status || "unknown"}`);
                        return;
                    }

                    const result = cleanup.stopRecord(ownerId, backend, device, timeoutMs);
                    if (result.status !== "stopped") {
                        failed += 1;
                        lines.push(`failed: ${device.id}  backend=${backend.name}  previous=${device.status || "unknown"}  reason=${result.reason || "device-stop-failed"}`);
                        for (const command of result.commands) lines.push(`command: ${command.command} -> ${command.status ?? "unknown"}`);
                        return;
                    }

                    stopped += 1;
                    lines.push(`stopped: ${device.id}  backend=${backend.name}  previous=${device.status || "unknown"}`);
                    for (const command of result.commands) lines.push(`command: ${command.command} -> ${command.status ?? "unknown"}`);
                });
            }
        }
        if (stopped === 0) lines.push("stopped: 0");
        if (failed > 0) lines.push(`failed: ${failed}`);
        lines.push(`skipped: ${skipped}`);
        return { ok: failed === 0, text: `${lines.join("\n")}\n` };
    }

    return { allProjects };
}
