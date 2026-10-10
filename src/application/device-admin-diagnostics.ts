import { pushDeviceLabWiringDiagnostic, missingPrerequisiteFromCommandFailure, smokeDetail, smokePathCheck,
    compactSmokeOutput, inventoryContains,
    type SmokeResult, type SmokeMode, type SmokeOptions, type SmokeFormatOptions, type DeviceLabWiringDiagnostic,
    type BenchDeviceCheck, type DeviceLabBenchHealth } from "../domain/device-admin-diagnostics.js";
import type { DeviceAdminBackend } from "../domain/device-admin-inventory.js";
import type { CommandResult } from "../domain/device-admin-diagnostics.js";
import type { DeviceAdminDiagnosticsPorts, DeviceAdminDiagnosticsInventory, DiagnosticDeviceRecord, DiagnosticLease } from "../ports/device-admin-diagnostics.js";
const OPT_DIST_DEVICE_LAB_MCP_SERVER = "/opt/ccc/dist/device-lab-mcp/server.mjs";
const OPT_SOURCE_DEVICE_LAB_MCP_SERVER = "/opt/ccc/device-lab-mcp/server.mjs";
export function createDeviceAdminDiagnostics<Backend extends DeviceAdminBackend>(
    ports: DeviceAdminDiagnosticsPorts<Backend>,
    inventory: DeviceAdminDiagnosticsInventory<Backend>,
) {
    function leaseExpired(lease: DiagnosticLease | null, nowMs: number): boolean {
        if (!lease?.expiresAt || Number.isNaN(Date.parse(lease.expiresAt))) return false;
        return Date.parse(lease.expiresAt) <= nowMs;
    }
    function deviceLabWiringDiagnostic(): DeviceLabWiringDiagnostic {
        const stateRoot = ports.joinPath(ports.homeDirectory(), ".ccc/devices");
        const stateExists = ports.exists(stateRoot);
        const context = ports.environment("container") === "docker" ? "container" : "host";
        return {
            stateRoot,
            stateExists,
            context,
            environmentRequired: false,
            ownerResolution: "host-broker-resolve",
            incomplete: !stateExists,
        };
    }

    function smokeCommand(command: string, args: string[], timeoutMs: number): CommandResult {
        return ports.runCommand(command, args, timeoutMs) || {
            command: [command, ...args].join(" "),
            status: null,
            stderr: "command not found",
        };
    }

    function smokeFromCommands(backend: string, commands: Array<[string, string[]]>, detail: string, timeoutMs: number): SmokeResult {
        const results = commands.map(([command, args]) => smokeCommand(command, args, timeoutMs));
        const failed = results.find((result) => result.status !== 0);
        if (failed) {
            const missing = missingPrerequisiteFromCommandFailure(failed);
            if (missing) {
                return {
                    backend,
                    status: "SKIP",
                    detail: `${missing} (${failed.stderr || failed.stdout || `command exited ${failed.status}`})`,
                    commands: results,
                };
            }
            return {
                backend,
                status: "FAIL",
                detail: failed.stderr || failed.stdout || `command exited ${failed.status}`,
                commands: results,
            };
        }
        return { backend, status: "PASS", detail, commands: results };
    }

    function optionalPhysicalInventorySmoke(backend: "android-device" | "ios-device", command: string, args: string[], detail: string, timeoutMs: number): SmokeResult {
        const result = smokeFromCommands(backend, [[command, args]], detail, timeoutMs);
        if (result.status !== "FAIL") return result;
        const explicitTarget = backend === "ios-device"
            ? Boolean((ports.environment("CCC_REAL_IOS_DEVICE_UDID") || "").trim())
            : Boolean((ports.environment("CCC_REAL_ANDROID_DEVICE_SERIAL") || ports.environment("CCC_REAL_ANDROID_SERIAL") || "").trim());
        if (explicitTarget) return result;
        return {
            ...result,
            status: "SKIP",
            detail: `physical-device inventory unavailable without an explicit leased device target (${result.detail})`,
        };
    }

    function installedMcpSmokeScriptPath(options: SmokeFormatOptions): string {
        return options.mcpSmokeScriptPath || ports.joinPath(ports.packageRoot(), "scripts", "real-tests", "installed-mcp-smoke.ts");
    }

    function installedDeviceLabMcpServerPath(options: SmokeFormatOptions): string {
        if (options.mcpServerPath) return options.mcpServerPath;
        const configuredServer = ports.environment("CCC_REAL_DEVICE_LAB_MCP_SERVER");
        if (configuredServer) return configuredServer;
        const packageDist = ports.joinPath(ports.packageRoot(), "dist", "device-lab-mcp", "server.mjs");
        if (ports.exists(packageDist)) return packageDist;
        if (ports.exists(OPT_DIST_DEVICE_LAB_MCP_SERVER)) return OPT_DIST_DEVICE_LAB_MCP_SERVER;
        return OPT_SOURCE_DEVICE_LAB_MCP_SERVER;
    }

    function installedMcpSurfaceSmoke(timeoutMs: number, options: SmokeFormatOptions = {}): SmokeResult {
        const serverPath = installedDeviceLabMcpServerPath(options);
        const scriptPath = installedMcpSmokeScriptPath(options);
        if (!ports.exists(serverPath)) {
            return { backend: "device-lab-mcp-installed", status: "SKIP", detail: `installed MCP server not found: ${serverPath}` };
        }
        if (!ports.exists(scriptPath)) {
            return { backend: "device-lab-mcp-installed", status: "SKIP", detail: `installed MCP smoke script not found: ${scriptPath}` };
        }
        const command = ports.runNode(scriptPath, serverPath, Math.max(timeoutMs, 15000));
        if (command.status === 0) {
            return {
                backend: "device-lab-mcp-installed",
                status: "PASS",
                detail: "installed MCP advertised surface dispatches current-display aliases",
                commands: [command],
            };
        }
        const detail = compactSmokeOutput(`${command.stderr || ""}\n${command.stdout || ""}`) || `command exited ${command.status ?? "unknown"}`;
        return {
            backend: "device-lab-mcp-installed",
            status: "FAIL",
            detail,
            commands: [command],
        };
    }

    function macosSmokeResult(tools: Record<string, string | null>, mode: SmokeMode, timeoutMs: number): SmokeResult {
        const macosProvider = tools.tart || tools.vz || tools.utmctl;
        if (!macosProvider) {
            return { backend: "macos-vm", status: "SKIP", detail: "missing tart, vz, utmctl" };
        }

        const provider = smokeCommand(macosProvider, ["--version"], timeoutMs);
        const commands: CommandResult[] = [provider];
        if (provider.status !== 0) {
            return {
                backend: "macos-vm",
                status: "FAIL",
                detail: provider.stderr || provider.stdout || `command exited ${provider.status}`,
                commands,
            };
        }

        if (mode !== "real-provider") {
            return { backend: "macos-vm", status: "PASS", detail: "macOS VM provider responded", commands };
        }

        const ssh = ports.commandPath("ssh");
        const scp = ports.commandPath("scp");
        const missingBridgeTools = [
            ["ssh", ssh],
            ["scp", scp],
        ].filter(([, path]) => !path).map(([tool]) => tool);
        if (missingBridgeTools.length > 0) {
            return {
                backend: "macos-vm",
                status: "SKIP",
                detail: `missing ${missingBridgeTools.join(", ")}`,
                commands,
            };
        }

        const sshTool = ssh as string;
        const scpTool = scp as string;
        const sshVersion = smokeCommand(sshTool, ["-V"], timeoutMs);
        const bridgeCommands = [sshVersion, smokePathCheck(scpTool)];
        commands.push(...bridgeCommands);
        const failed = bridgeCommands.find((result) => result.status !== 0);
        if (failed) {
            return {
                backend: "macos-vm",
                status: "FAIL",
                detail: failed.stderr || failed.stdout || `command exited ${failed.status}`,
                commands,
            };
        }

        return {
            backend: "macos-vm",
            status: "PASS",
            detail: "real provider macOS VM CLI and SSH bridge responded; SCP bridge tool found; no VM started",
            commands,
        };
    }

    function hyperVSmokeResult(tools: Record<string, string | null>, timeoutMs: number): SmokeResult {
        if (ports.platform() !== "win32") return { backend: "windows-vm", status: "SKIP", detail: "not a Windows host" };
        const powershell = tools["powershell.exe"];
        if (!powershell) return { backend: "windows-vm", status: "SKIP", detail: "missing powershell" };
        const plan = ports.readinessCommand(powershell);
        const result = smokeCommand(plan.executable, plan.args, timeoutMs);
        const commands = [result];
        if (result.status !== 0) {
            return { backend: "windows-vm", status: "FAIL", detail: compactSmokeOutput(String(result.stderr || result.stdout || "")) || `command exited ${result.status}`, commands };
        }
        const readiness = ports.parseReadiness(result.stdout || "");
        if (!readiness) return { backend: "windows-vm", status: "FAIL", detail: "invalid Hyper-V readiness response", commands };
        if (!readiness.available) return { backend: "windows-vm", status: "SKIP", detail: `missing ${readiness.missing.join(", ") || "Hyper-V prerequisites"}`, commands };
        return { backend: "windows-vm", status: "PASS", detail: "Hyper-V module, hypervisor, and VMMS service are ready; no VM started", commands };
    }

    function hyperVLinuxSmokeResult(tools: Record<string, string | null>, timeoutMs: number, ownerId: string): SmokeResult {
        if (ports.platform() !== "win32") return { backend: "linux-vm", status: "SKIP", detail: "not a Windows host" };
        const missing = ["powershell.exe", "ssh", "scp"].filter((tool) => !tools[tool]);
        if (missing.length > 0) return { backend: "linux-vm", status: "SKIP", detail: `missing ${missing.join(", ")}` };
        const plan = ports.readinessCommand(tools["powershell.exe"] as string);
        const result = smokeCommand(plan.executable, plan.args, timeoutMs);
        const commands = [result];
        if (result.status !== 0) return { backend: "linux-vm", status: "FAIL", detail: compactSmokeOutput(String(result.stderr || result.stdout || "")) || `command exited ${result.status}`, commands };
        const readiness = ports.parseReadiness(result.stdout || "");
        if (!readiness) return { backend: "linux-vm", status: "FAIL", detail: "invalid Hyper-V readiness response", commands };
        if (!readiness.available) return { backend: "linux-vm", status: "SKIP", detail: `missing ${readiness.missing.join(", ") || "Hyper-V prerequisites"}`, commands };
        // The broker's private root and this owner, as create resolves the ubuntu-lts image.
        const cache = ports.inspectLinuxImageCache(ports.joinPath(ports.homeDirectory(), ".ccc/device-broker-private"), ownerId);
        return { backend: "linux-vm", ...ports.linuxImageSmokeResult(readiness, cache), commands };
    }

    function deviceLabSmoke(cwd: string, timeoutMs = 5000, profile?: string, options: SmokeOptions = {}): { ownerId: string; mode: SmokeMode; results: SmokeResult[] } {
        const ownerId = ports.resolveOwnerId(cwd, profile);
        const mode = options.mode || "prerequisite";
        const tools = Object.fromEntries(
            ports.backends.flatMap((backend) => backend.tools.map((tool) => [tool, ports.commandPath(tool)])),
        ) as Record<string, string | null>;

        const results: SmokeResult[] = [];
        if (!tools.adb || !tools.emulator) {
            results.push({ backend: "android-emulator", status: "SKIP", detail: `missing ${["adb", "emulator"].filter((tool) => !tools[tool]).join(", ")}` });
        } else {
            results.push(smokeFromCommands("android-emulator", [[tools.adb, ["version"]], [tools.emulator, ["-list-avds"]]], smokeDetail(mode, "adb and emulator responded", "real provider adb/emulator readiness responded; no emulator started"), timeoutMs));
        }
        if (!tools.adb) {
            results.push({ backend: "android-device", status: "SKIP", detail: "missing adb" });
        } else {
            results.push(optionalPhysicalInventorySmoke("android-device", tools.adb, ["devices", "-l"], smokeDetail(mode, "adb physical-device inventory responded", "real provider adb physical-device inventory responded; no device claimed"), timeoutMs));
        }

        if (!tools.xcrun) {
            results.push({ backend: "ios-simulator", status: "SKIP", detail: "missing xcrun" });
        } else {
            results.push(smokeFromCommands("ios-simulator", [[tools.xcrun, ["simctl", "list", "-j"]]], smokeDetail(mode, "xcrun simctl inventory responded", "real provider simctl inventory responded; no simulator booted"), timeoutMs));
        }
        if (!tools.xcrun) {
            results.push({ backend: "ios-device", status: "SKIP", detail: "missing xcrun" });
        } else {
            results.push(optionalPhysicalInventorySmoke("ios-device", tools.xcrun, ["xctrace", "list", "devices"], smokeDetail(mode, "xcrun xctrace physical-device inventory responded", "real provider xctrace physical-device inventory responded; no device claimed"), timeoutMs));
        }

        if (!tools.wsb) {
            results.push({ backend: "windows-sandbox", status: "SKIP", detail: "missing wsb" });
        } else {
            results.push(smokeFromCommands("windows-sandbox", [[tools.wsb, ["--help"]]], smokeDetail(mode, "wsb CLI responded", "real provider Windows Sandbox CLI responded; no sandbox started"), timeoutMs));
        }

        results.push(hyperVSmokeResult(tools, timeoutMs));
        results.push(hyperVLinuxSmokeResult(tools, timeoutMs, ownerId));

        results.push(macosSmokeResult(tools, mode, timeoutMs));

        return { ownerId, mode, results };
    }

    function benchInventory(stateKey: "android-device" | "ios-device", timeoutMs: number): { status: "PASS" | "SKIP" | "FAIL"; detail: string; command: CommandResult | null } {
        if (stateKey === "android-device") {
            const adb = ports.commandPath("adb");
            if (!adb) return { status: "SKIP", detail: "missing adb", command: null };
            const command = smokeCommand(adb, ["devices", "-l"], timeoutMs);
            if (command.status !== 0) return { status: "FAIL", detail: `inventory command failed with status ${command.status ?? "unknown"}`, command };
            return { status: "PASS", detail: "adb physical-device inventory responded", command };
        }
        const xcrun = ports.commandPath("xcrun");
        if (!xcrun) return { status: "SKIP", detail: "missing xcrun", command: null };
        const command = smokeCommand(xcrun, ["xctrace", "list", "devices"], timeoutMs);
        if (command.status !== 0) return { status: "FAIL", detail: `inventory command failed with status ${command.status ?? "unknown"}`, command };
        return { status: "PASS", detail: "xcrun physical-device inventory responded", command };
    }

    function benchDeviceCheck(ownerId: string, backend: Backend, device: DiagnosticDeviceRecord, command: CommandResult | null): BenchDeviceCheck {
        const deviceId = device.id || "(unknown)";
        const name = typeof device.name === "string" ? device.name : deviceId;
        const hardwareId = ports.hardwareIdForPhysicalDevice(backend, device);
        if (!hardwareId) {
            return { deviceId, name, hardwareId: null, status: "missing-hardware-id", detail: "attached physical device record has no serial/UDID", inventoryState: "unknown" };
        }
        const lease = ports.readPhysicalLease(backend.stateKey, hardwareId);
        const inventoryState = inventoryContains(command, hardwareId);
        if (!lease) return { deviceId, name, hardwareId, status: "missing-lease", detail: "physical lease lock is missing", inventoryState };
        if (lease.ownerId !== ownerId) return { deviceId, name, hardwareId, status: "foreign-lease", detail: "lease belongs to another owner", inventoryState };
        if (lease.deviceId && lease.deviceId !== deviceId) return { deviceId, name, hardwareId, status: "device-mismatch", detail: "lease is bound to a different device id", inventoryState };
        if (leaseExpired(lease, ports.now())) return { deviceId, name, hardwareId, status: "expired-lease", detail: `lease expired at ${lease.expiresAt}`, inventoryState, expiresAt: lease.expiresAt };
        if (inventoryState === "missing") return { deviceId, name, hardwareId, status: "inventory-missing", detail: "host inventory did not list the attached hardware id", inventoryState };
        if (inventoryState === "unknown") return { deviceId, name, hardwareId, status: "lease-ok", detail: "lease is current; inventory unavailable", inventoryState };
        return { deviceId, name, hardwareId, status: "healthy", detail: "lease is current and host inventory lists the device", inventoryState };
    }

    function deviceLabBenchHealth(cwd: string, profile?: string, timeoutMs = 5000): DeviceLabBenchHealth {
        const ownerId = ports.resolveOwnerId(cwd, profile);
        const backends = ports.backends
            .filter((backend) => backend.stateKey === "android-device" || backend.stateKey === "ios-device")
            .map((backend) => {
                const inventory = benchInventory(backend.stateKey === "android-device" ? "android-device" : "ios-device", timeoutMs);
                const devices = ports.readDevices(ownerId, backend.stateKey)
                    .filter((device) => device.physical === true && device.status === "attached")
                    .map((device) => benchDeviceCheck(ownerId, backend, device, inventory.command));
                return {
                    backend: backend.stateKey === "android-device" ? "android-device" as const : "ios-device" as const,
                    status: inventory.status,
                    detail: inventory.detail,
                    command: inventory.command ? { command: inventory.command.command, status: inventory.command.status } : null,
                    devices,
                };
            });
        return { ownerId, backends };
    }

    function formatDevicesDoctor(cwd: string, profile?: string): string {
        const snapshot = inventory.snapshot(cwd, profile);
        const bench = deviceLabBenchHealth(cwd, profile);
        const wiring = deviceLabWiringDiagnostic();
        const lines = [
            "=== CCC Devices Doctor ===",
            "",
            `owner: ${snapshot.ownerId}`,
        ];
        pushDeviceLabWiringDiagnostic(lines, wiring);
        lines.push(
            "",
            "Device-lab MCP: managed by CCC when containers are started",
            "Startup policy: lazy; these diagnostics do not start devices",
            "",
        );
        for (const backend of snapshot.backends) {
            if (backend.available) {
                lines.push(`${backend.name}: ok`);
            } else {
                lines.push(`${backend.name}: missing ${backend.missing.join(", ")}`);
            }
        }
        lines.push("");
        lines.push("Lab bench health:");
        for (const backend of bench.backends) {
            lines.push(`${backend.backend}: ${backend.status} - ${backend.detail}`);
            if (backend.devices.length === 0) {
                lines.push("  (no current-owner attached physical devices)");
                continue;
            }
            for (const device of backend.devices) {
                const hardware = device.hardwareId ? ` hardware=${device.hardwareId}` : "";
                lines.push(`  ${device.deviceId}: ${device.status}${hardware} inventory=${device.inventoryState} - ${device.detail}`);
            }
        }
        return `${lines.join("\n")}\n`;
    }

    function formatDevicesSmoke(cwd: string, timeoutMs = 5000, profile?: string, options: SmokeFormatOptions = {}): string {
        const smoke = deviceLabSmoke(cwd, timeoutMs, profile, options);
        const wiring = deviceLabWiringDiagnostic();
        const results = options.mcpSurface === true
            ? [installedMcpSurfaceSmoke(timeoutMs, options), ...smoke.results]
            : smoke.results;
        const lines = [
            "=== CCC Devices Smoke ===",
            "",
            `owner: ${smoke.ownerId}`,
        ];
        pushDeviceLabWiringDiagnostic(lines, wiring);
        lines.push("Startup policy: lazy; smoke checks do not start devices", "");
        if (smoke.mode === "real-provider") {
            const startupIndex = lines.findIndex((line) => line === "Startup policy: lazy; smoke checks do not start devices");
            lines.splice(startupIndex, 0, "mode: real-provider (explicit opt-in)", "Real provider policy: bounded readiness/inventory commands only; no devices are created, started, stopped, or deleted");
        }
        for (const result of results) {
            lines.push(`${result.backend}: ${result.status} - ${result.detail}`);
            for (const command of result.commands || []) {
                lines.push(`  ${command.command} -> ${command.status ?? "unknown"}`);
            }
        }
        return `${lines.join("\n")}\n`;
    }
    return { smoke: deviceLabSmoke, benchHealth: deviceLabBenchHealth, formatDoctor: formatDevicesDoctor,
        formatSmoke: formatDevicesSmoke, wiringDiagnostic: deviceLabWiringDiagnostic };
}
