import type { DeviceAdminBackendSnapshot } from "./device-admin-inventory.js";
import type { DeviceAdminBackend } from "../domain/device-admin-inventory.js";
import type { CommandResult, HyperVReadiness, LinuxImageCache, ProviderCommand } from "../domain/device-admin-diagnostics.js";
export type DiagnosticDeviceRecord = Record<string, unknown> & { id?: string; status?: string };
export type DiagnosticLease = { ownerId?: string; deviceId?: string; expiresAt?: string };
export type DeviceAdminDiagnosticsPorts<Backend extends DeviceAdminBackend = DeviceAdminBackend> = {
    backends: readonly Backend[];
    resolveOwnerId(cwd: string, profile?: string): string;
    readDevices(ownerId: string, stateKey: string): DiagnosticDeviceRecord[];
    commandPath(tool: string): string | null;
    hardwareIdForPhysicalDevice(backend: Backend, device: DiagnosticDeviceRecord): string | null;
    readPhysicalLease(stateKey: string, hardwareId: string): DiagnosticLease | null;
    platform(): string;
    environment(name: "container" | "CCC_REAL_IOS_DEVICE_UDID" | "CCC_REAL_ANDROID_DEVICE_SERIAL" | "CCC_REAL_ANDROID_SERIAL" | "CCC_REAL_DEVICE_LAB_MCP_SERVER"): string | undefined;
    now(): number;
    homeDirectory(): string;
    packageRoot(): string;
    joinPath(...parts: string[]): string;
    exists(path: string): boolean;
    runCommand(command: string, args: string[], timeoutMs: number): CommandResult | null;
    runNode(script: string, server: string, timeoutMs: number): CommandResult;
    readinessCommand(executable: string): ProviderCommand;
    parseReadiness(stdout: string): HyperVReadiness | null;
    inspectLinuxImageCache(privateRoot: string, ownerId: string): LinuxImageCache;
};

export type DeviceAdminDiagnosticsInventory<Backend extends DeviceAdminBackend> = {
    snapshot(cwd: string, profile?: string): { ownerId: string; backends: DeviceAdminBackendSnapshot<Backend>[] };
};
