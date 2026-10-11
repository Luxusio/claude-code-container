import type { BenchDeviceCheck, BenchHealth, DiagnosticProbe, DiagnosticRow, SmokeMode, SmokeOptions } from "../domain/device-admin-diagnostics.js";
import type { DeviceAdminBackend } from "../domain/device-admin-inventory.js";
import type { DeviceAdminDiagnosticsPorts, DiagnosticDeviceRecord } from "../ports/device-admin-diagnostics.js";
export function createDeviceAdminDiagnostics<Backend extends DeviceAdminBackend, Evidence>(ports: DeviceAdminDiagnosticsPorts<Backend, Evidence>) {
    function row(backend: string, probes: DiagnosticProbe<Evidence>[], reason: DiagnosticRow<Evidence>["reason"] = "responded"): DiagnosticRow<Evidence> {
        const failed = probes.find(probe => probe.state !== "available");
        return { backend, status: failed ? failed.state === "missing" ? "SKIP" : "FAIL" : "PASS",
            reason: failed ? failed.reason === "prerequisite-missing" ? "prerequisite-missing" : "probe-failed" : reason,
            evidence: probes.flatMap(probe => probe.evidence === undefined ? [] : [probe.evidence]) };
    }
    function smoke(cwd: string, timeoutMs = 5000, profile?: string, options: SmokeOptions = {}) {
        const ownerId = ports.resolveOwnerId(cwd, profile);
        const mode: SmokeMode = options.mode || "prerequisite";
        const tools = ports.availability();
        const targets = ports.physicalTargets();
        const results: DiagnosticRow<Evidence>[] = [];
        const missing = (backend: string, names: string[]): DiagnosticRow<Evidence> => ({ backend, status: "SKIP", reason: "missing-tools", missing: names, evidence: [] });
        results.push(!tools.adb || !tools.emulator ? missing("android-emulator", ["adb", "emulator"].filter(name => !tools[name as "adb" | "emulator"]))
            : row("android-emulator", [ports.probeAndroidVersion(timeoutMs), ports.probeAndroidEmulatorInventory(timeoutMs)]));
        function physical(backend: "android-device" | "ios-device", present: boolean, explicit: boolean, probe: () => DiagnosticProbe<Evidence>) {
            if (!present) return missing(backend, [backend === "android-device" ? "adb" : "xcrun"]);
            const result = row(backend, [probe()]);
            return result.status === "FAIL" && !explicit ? { ...result, status: "SKIP" as const, reason: "optional-inventory-unavailable" as const } : result;
        }
        results.push(physical("android-device", tools.adb, targets.android, () => ports.probeAndroidPhysicalInventory(timeoutMs)));
        results.push(!tools.xcrun ? missing("ios-simulator", ["xcrun"]) : row("ios-simulator", [ports.probeIosSimulatorInventory(timeoutMs)]));
        results.push(physical("ios-device", tools.xcrun, targets.ios, () => ports.probeIosPhysicalInventory(timeoutMs)));
        results.push(!tools.wsb ? missing("windows-sandbox", ["wsb"]) : row("windows-sandbox", [ports.probeWindowsSandbox(timeoutMs)]));
        for (const backend of ["windows-vm", "linux-vm"]) {
            if (!tools.windowsHost) { results.push({ backend, status: "SKIP", reason: "not-windows", evidence: [] }); continue; }
            const absent = backend === "linux-vm" ? ["powershell", "ssh", "scp"].filter(name => !tools[name as "powershell" | "ssh" | "scp"]) : tools.powershell ? [] : ["powershell"];
            if (absent.length) { results.push(missing(backend, absent)); continue; }
            const probe = ports.probeHyperV(timeoutMs);
            const result = row(backend, [probe]);
            if (probe.state !== "available") { results.push(result); continue; }
            if (!probe.readiness) { results.push({ ...result, status: "FAIL", reason: "invalid-readiness" }); continue; }
            if (!probe.readiness.available) { results.push({ ...result, status: "SKIP", reason: "hyper-v-unavailable", missing: probe.readiness.missing }); continue; }
            if (backend === "linux-vm") {
                const image = ports.linuxImage(ownerId, probe.readiness);
                results.push({ ...result, status: image.available ? "PASS" : "SKIP", reason: "linux-image", evidence: [...result.evidence, image.evidence] });
            } else results.push(result);
        }
        const provider = tools.tart ? "tart" : tools.vz ? "vz" : tools.utmctl ? "utmctl" : null;
        if (!provider) results.push(missing("macos-vm", ["tart", "vz", "utmctl"]));
        else {
            const version = row("macos-vm", [ports.probeMacosVersion(provider, timeoutMs)], "macos-responded");
            if (version.status !== "PASS" || mode !== "real-provider") results.push(version);
            else if (!tools.ssh || !tools.scp) results.push({ ...version, status: "SKIP", reason: "missing-bridge", missing: ["ssh", "scp"].filter(name => !tools[name as "ssh" | "scp"]) });
            else {
                const bridge = row("macos-vm", [ports.probeSsh(timeoutMs), ports.probeScp()], "macos-real-responded");
                results.push({ ...bridge, evidence: [...version.evidence, ...bridge.evidence] });
            }
        }
        if (options.mcpSurface) {
            const installed = ports.probeInstalledSurface(Math.max(timeoutMs, 15_000));
            const result = row("device-lab-mcp-installed", [installed]);
            if (installed.reason === "installed-server-missing" || installed.reason === "installed-script-missing") result.reason = installed.reason;
            results.unshift(result);
        }
        return { ownerId, mode, results };
    }
    function benchDeviceCheck(ownerId: string, backend: Backend, device: DiagnosticDeviceRecord, probe: DiagnosticProbe<Evidence>): BenchDeviceCheck {
        const deviceId = device.id || "(unknown)";
        const name = typeof device.name === "string" ? device.name : deviceId;
        const hardwareId = ports.hardwareIdForPhysicalDevice(backend, device);
        if (!hardwareId) return { deviceId, name, hardwareId: null, status: "missing-hardware-id", inventoryState: "unknown" };
        const lease = ports.readPhysicalLease(backend.stateKey, hardwareId);
        const inventoryState = probe.state !== "available" || !probe.tokens ? "unknown" : probe.tokens.includes(hardwareId) ? "present" : "missing";
        const facts = { deviceId, name, hardwareId, inventoryState } as const;
        if (!lease) return { ...facts, status: "missing-lease" };
        if (lease.ownerId !== ownerId) return { ...facts, status: "foreign-lease" };
        if (lease.deviceId && lease.deviceId !== deviceId) return { ...facts, status: "device-mismatch" };
        if (lease.expiresAt && !Number.isNaN(Date.parse(lease.expiresAt)) && Date.parse(lease.expiresAt) <= ports.now()) return { ...facts, status: "expired-lease", expiresAt: lease.expiresAt };
        return { ...facts, status: inventoryState === "missing" ? "inventory-missing" : inventoryState === "unknown" ? "lease-ok" : "healthy" };
    }
    function benchHealth(cwd: string, profile?: string, timeoutMs = 5000): BenchHealth<Evidence> {
        const ownerId = ports.resolveOwnerId(cwd, profile);
        const availability = ports.availability();
        return { ownerId, backends: ports.backends.filter(backend => backend.stateKey === "android-device" || backend.stateKey === "ios-device").map(backend => {
            const android = backend.stateKey === "android-device";
            const probe: DiagnosticProbe<Evidence> = !(android ? availability.adb : availability.xcrun) ? { state: "missing" }
                : android ? ports.probeAndroidPhysicalInventory(timeoutMs) : ports.probeIosPhysicalInventory(timeoutMs);
            return { backend: android ? "android-device" as const : "ios-device" as const,
                status: probe.state === "available" ? "PASS" as const : probe.state === "missing" && probe.evidence === undefined ? "SKIP" as const : "FAIL" as const,
                reason: probe.state === "available" ? "responded" as const : probe.evidence === undefined ? "missing-tools" as const : "probe-failed" as const,
                evidence: probe.evidence,
                devices: ports.readDevices(ownerId, backend.stateKey).filter(device => device.physical === true && device.status === "attached").map(device => benchDeviceCheck(ownerId, backend, device, probe)) };
        }) };
    }
    return { smoke, benchHealth };
}
