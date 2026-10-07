// These lifecycle suites simulate VM effects; host capacity must be simulated too.
// Dedicated capacity tests exercise refusal boundaries.
vi.mock("os", async (importOriginal) => ({
    ...await importOriginal<typeof import("os")>(),
    totalmem: () => 64 * 1024 ** 3,
    freemem: () => 48 * 1024 ** 3,
}));
import * as fixtureFs from "fs";
import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { isolatedDeviceLabPackage } from "./helpers/isolated-device-lab-package.js";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { request } from "http";
import { hostname, tmpdir, uptime } from "os";
import { dirname, join, resolve } from "path";
import { runInNewContext } from "vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer as createRawDeviceBrokerServer, hiddenChildProcessOptions, hiddenProviderCommandEnv, providerCommandSpawn, redactProviderCommandInput, registerDeviceBrokerOwner, waitForBrokerWindowsMinimizeConfirmation, windowsHiddenChildProcessPreloadScript, windowsHiddenVbsLauncherInvocation, windowsHiddenVbsLauncherScript, windowsProcessTreeOutcome, windowsSandboxMinimizeWatchdogArgs, windowsSandboxSessionIdsFromBrokerListOutput, windowsSandboxWindowHandleSnapshotArgs, windowsSandboxWindowHandlesFromOutput } from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerId, deviceLabProjectMountPath } from "@ccc/device-lab/device-lab-owner.js";
import { readDeviceRuntimeProcessIdentity } from "@ccc/device-lab/device-lab-process-identity.js";
import { withSharedMutationLockAsync } from "@ccc/device-lab/device-lab-shared-state.js";
import { releaseHyperVNetworkAllocationAndCleanup } from "@ccc/device-lab/device-lab/broker/hyper-v/network.js";
import { rememberHyperVConsoleFrame, forgetHyperVConsoleFrame, hyperVConsoleFrameKey } from "@ccc/device-lab/device-lab/broker/hyper-v/console.js";
import { hyperVVmName } from "@ccc/device-lab/host-control/hyper-v/index.js";
import { HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP } from "@ccc/hyper-v/low-level/powershell-transport.js";
import { backendRoot, cleanupOwner, close, listen, ownerRoot, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";
import {
    configureTypedHyperVNetworkOperations,
    withTypedHyperVNetworkOperations,
} from "./helpers/hyper-v-network-operation-simulator.js";

// A pass-through, so a test can stand in one network release failure the host would report.
// Create compensation keeps the shared fabric, so a rollback never reaches an elevated cleanup
// that could fail on its own here.
vi.mock("@ccc/device-lab/device-lab/broker/hyper-v/network.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@ccc/device-lab/device-lab/broker/hyper-v/network.js")>();
    return {
        ...actual,
        releaseHyperVNetworkAllocationAndCleanup: vi.fn(actual.releaseHyperVNetworkAllocationAndCleanup),
    };
});

function createDeviceBrokerServer(options: Parameters<typeof createRawDeviceBrokerServer>[0]) {
    const networkRunner = options.commandRunner && withTypedHyperVNetworkOperations(options.commandRunner, {
        stateFile: join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json"),
    });
    const preludeRunner = options.commandRunner && ((command: Parameters<NonNullable<typeof options.commandRunner>>[0], runnerOptions: Parameters<NonNullable<typeof options.commandRunner>>[1]) => {
        if (command.provider !== "hyper-v") return networkRunner!(command, runnerOptions);
        const script = providerScript(command);
        const value = (name: string) => script.match(new RegExp(`\\$${name} = '((?:''|[^'])*)'`))?.[1]?.replaceAll("''", "'") || "";
        if (script.includes("CCC_HYPER_V_STAGE:hyper-v-create-compensation-failed")) {
            const target = value("Target");
            if (existsSync(target)) {
                if (lstatSync(target).isDirectory()) rmdirSync(target);
                else unlinkSync(target);
            }
            return { ...command, status: 0, stdout: '{"ok":true}', stderr: "" };
        }
        if (script.includes("$DeviceRootExisted = [bool](Test-Path -LiteralPath $DeviceRoot)")) {
            const deviceRoot = value("DeviceRoot");
            const diskDirectory = dirname(value("DiskPath"));
            const deviceRootExisted = existsSync(deviceRoot);
            const diskDirectoryExisted = existsSync(diskDirectory);
            mkdirSync(diskDirectory, { recursive: true });
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, deviceRoot, diskDirectory, deviceRootExisted, diskDirectoryExisted }), stderr: "" };
        }
        if (script.includes("$Vhd = Get-VHD -Path $VhdPath") && script.includes("virtualSizeBytes = [long]$Vhd.Size")) {
            const path = value("VhdPath");
            const base = script.includes("kind = 'base'");
            const manifestPath = join(dirname(path), "manifest.json");
            const manifest = base && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as { virtualSizeBytes?: number } : null;
            const expectedSize = script.match(/\[long\]\$Vhd.Size -ne \[long\](\d+)/)?.[1];
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, kind: base ? "base" : "clone", virtualSizeBytes: manifest?.virtualSizeBytes ?? Number(expectedSize || 64 * 1024 * 1024 * 1024) }), stderr: "" };
        }
        return networkRunner!(command, runnerOptions);
    });
    return createRawDeviceBrokerServer({
        ...options,
        ...(preludeRunner ? { commandRunner: preludeRunner } : {}),
    });
}

// The typed Windows library never puts its operation script on the command line. The fixed
// bootstrap reads one Base64 ASCII blob from stdin and runs the { script, input } envelope it
// decodes (doc/hyper-v-windows/REQ__internal-library-contract.md, "The fixed bootstrap MUST pass
// its UTF-8 JSON envelope as Base64 ASCII"). This fixture stands in for the PowerShell host, so it
// has to unwrap that envelope the same way.
function memoryBootstrapEnvelope(
    command: { args: string[]; input?: string },
): { script: string; input: string } | null {
    if (command.args.at(-1) !== HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP || !command.input) return null;
    const decoded = JSON.parse(Buffer.from(command.input, "base64").toString("utf8")) as {
        script?: unknown;
        input?: unknown;
    };
    if (typeof decoded.script !== "string" || typeof decoded.input !== "string") return null;
    return { script: decoded.script, input: decoded.input };
}

// The operation request the library asked for, or null when this command is not a library call.
function nativeLibraryRequest(
    command: { args: string[]; input?: string },
): { operation: string; selector?: { kind: string; id?: string; name?: string }; action?: string; command?: string; localPath?: string; remotePath?: string; expectedName?: string; expectedNotes?: string; path?: string; mode?: string; force?: boolean; paths?: string[]; guard?: { expectedName: string; expectedNotes: string } } | null {
    const envelope = memoryBootstrapEnvelope(command);
    if (envelope) {
        return envelope.script.includes("Write-HyperVWindowsSuccess")
            ? JSON.parse(envelope.input) as { operation: string; selector?: { kind: string } }
            : null;
    }
    return providerScript(command).includes("Write-HyperVWindowsSuccess") && command.input
        ? JSON.parse(command.input) as { operation: string; selector?: { kind: string } }
        : null;
}

function providerScript(command: { args: string[]; input?: string }): string {
    const memoryEnvelope = memoryBootstrapEnvelope(command);
    if (memoryEnvelope) return memoryEnvelope.script;
    if (command.args.at(-1) === "-" && typeof command.input === "string") return command.input;
    const fileIndex = command.args.indexOf("-File");
    if (fileIndex >= 0) {
        const file = command.args[fileIndex + 1];
        return file ? readFileSync(file, "utf8") : "";
    }
    const decoded = Buffer.from(command.args.at(-1) || "", "base64").toString("utf16le");
    if (decoded.includes("$E=[Console]::In.ReadToEnd().Trim()")) {
        if (!command.input) throw new Error("missing streamed PowerShell program");
        return Buffer.from(command.input, "base64").toString("utf8");
    }
    return decoded;
}

function nativeEnvelope(operation: string, items: unknown[]): string {
    return JSON.stringify({ schemaVersion: 1, operation, ok: true, items });
}

function hyperVNetworkObservation(command: { args: string[]; input?: string }) {
    const script = providerScript(command);
    const value = (name: string) => script.match(new RegExp(`\\$${name} = '((?:''|[^'])*)'`))?.[1]?.replaceAll("''", "'") || "";
    return {
        ok: true,
        switchName: value("SwitchName"),
        switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        natName: value("NatName"),
        natInstanceId: "ccc-nat-instance-1",
        prefix: value("Prefix"),
        gateway: value("Gateway"),
        interfaceIndex: 42,
        createdSwitch: true,
        createdNat: true,
    };
}

function isHyperVNetworkCleanupScript(script: string): boolean {
    return script.includes("$RemoveNat =") && script.includes("Remove-NetNat -InputObject");
}

describe("device-lab host broker lifecycle commands", () => {
    it("preserves allowlisted Hyper-V provisioning stages while redacting command input and output", () => {
        const diagnosticCodes = [
            "hyper-v-guest-provision-credential-command-failed",
            "hyper-v-guest-provision-input-validation-command-failed",
            "hyper-v-guest-provision-media-build-command-failed",
            "hyper-v-guest-provision-media-attach-command-failed",
            "hyper-v-linux-seed-user-keygen-command-failed",
            "hyper-v-linux-seed-host-keygen-command-failed",
            "hyper-v-linux-seed-known-hosts-command-failed",
            "hyper-v-linux-seed-media-build-command-failed",
            "hyper-v-linux-seed-media-attach-command-failed",
            "hyper-v-linux-ssh-keygen-arguments-invalid",
            "hyper-v-linux-ssh-keygen-start-failed",
            "hyper-v-provisioning-media-source-directory-failed",
            "hyper-v-provisioning-media-source-file-invalid",
            "hyper-v-provisioning-media-source-file-failed",
            "hyper-v-provisioning-media-source-cleanup-failed",
            "hyper-v-provisioning-media-add-tree-failed",
            "hyper-v-provisioning-media-filesystem-selection-failed",
            "hyper-v-provisioning-media-volume-name-invalid",
            "hyper-v-provisioning-media-volume-name-failed",
        ];
        for (const diagnosticCode of diagnosticCodes) {
            expect(redactProviderCommandInput({
                mode: "exec",
                provider: "hyper-v",
                status: 1,
                input: "guest-secret-input",
                stdout: `guest-secret-output ${diagnosticCode}`,
                stderr: `guest-secret-error ${diagnosticCode}`,
            }, true, "hyper-v-powershell-execution-failed")).toEqual(expect.objectContaining({
                status: 1,
                stdoutPresent: true,
                stderrPresent: true,
                inputConfigured: true,
                outputRedacted: true,
                diagnosticCode,
            }));
        }
    });

    it("uses the last stage marker when PowerShell only reports a generic execution failure", () => {
        expect(redactProviderCommandInput({
            mode: "exec",
            provider: "hyper-v",
            status: 1,
            stdout: [
                "CCC_HYPER_V_STAGE:hyper-v-linux-seed-vm-lookup-command-failed",
                "CCC_HYPER_V_STAGE:hyper-v-linux-seed-media-check-command-failed",
                "CCC_HYPER_V_STAGE:hyper-v-linux-seed-media-build-command-failed",
            ].join("\n"),
            stderr: "hyper-v-powershell-execution-failed",
        }, true, "hyper-v-linux-seed-command-failed")).toEqual(expect.objectContaining({
            diagnosticCode: "hyper-v-linux-seed-media-build-command-failed",
            stdoutPresent: true,
            stderrPresent: true,
        }));
    });

    it("preserves bounded Hyper-V image and VM creation stages across generic PowerShell failures", () => {
        for (const diagnosticCode of [
            "hyper-v-base-image-download-failed",
            "hyper-v-base-image-hash-failed",
            "hyper-v-base-image-hash-mismatch",
            "hyper-v-base-image-archive-check-failed",
            "hyper-v-base-image-extract-failed",
            "hyper-v-base-image-normalize-failed",
            "hyper-v-base-image-inspection-failed",
            "hyper-v-base-image-finalize-failed",
            "hyper-v-base-image-final-move-failed",
            "hyper-v-base-image-final-inspection-failed",
            "hyper-v-base-image-final-observation-failed",
            "hyper-v-vm-disk-create-failed",
            "hyper-v-vm-disk-inspection-failed",
            "hyper-v-vm-create-failed",
            "hyper-v-vm-configure-failed",
            "hyper-v-vm-preflight-failed",
        ]) {
            expect(redactProviderCommandInput({
                mode: "exec",
                provider: "hyper-v",
                status: 1,
                stdout: `earlier-stage\nCCC_HYPER_V_STAGE:${diagnosticCode}`,
                stderr: "hyper-v-powershell-execution-failed",
            }, true, "hyper-v-provider-command-failed")).toEqual(expect.objectContaining({
                diagnosticCode,
                stdoutPresent: true,
                stderrPresent: true,
            }));
        }
    });

    it("preserves the last internal media-build marker across a generic nested PowerShell failure", () => {
        expect(redactProviderCommandInput({
            mode: "exec",
            provider: "hyper-v",
            status: 1,
            stdout: [
                "CCC_HYPER_V_STAGE:hyper-v-guest-provision-media-build-command-failed",
                "CCC_HYPER_V_STAGE:hyper-v-provisioning-media-add-tree-failed",
                "CCC_HYPER_V_STAGE:hyper-v-provisioning-media-output-open-failed",
            ].join("\n"),
            stderr: "hyper-v-powershell-execution-failed",
        }, true, "hyper-v-guest-provision-command-failed")).toEqual(expect.objectContaining({
            diagnosticCode: "hyper-v-provisioning-media-output-open-failed",
            stdoutPresent: true,
            stderrPresent: true,
        }));
    });

    it("prefers a specific reported diagnostic over stage markers", () => {
        expect(redactProviderCommandInput({
            mode: "exec",
            provider: "hyper-v",
            status: 1,
            stdout: "hyper-v-guest-provision-media-build-command-failed",
            stderr: "hyper-v-provisioning-media-output-open-failed",
        }, true, "hyper-v-guest-provision-command-failed")).toEqual(expect.objectContaining({
            diagnosticCode: "hyper-v-provisioning-media-output-open-failed",
        }));
    });

    it("keeps the last specific reported diagnostic ahead of a trailing generic wrapper error", () => {
        expect(redactProviderCommandInput({
            mode: "exec",
            provider: "hyper-v",
            status: 1,
            stdout: "CCC_HYPER_V_STAGE:hyper-v-base-image-download-failed",
            stderr: [
                "hyper-v-base-image-checksum-mismatch",
                "hyper-v-powershell-execution-failed",
            ].join("\n"),
        }, true, "hyper-v-provider-command-failed")).toEqual(expect.objectContaining({
            diagnosticCode: "hyper-v-base-image-checksum-mismatch",
        }));
    });

    it("preserves an explicit base image hash mismatch before VM creation starts", () => {
        expect(redactProviderCommandInput({
            mode: "exec",
            provider: "hyper-v",
            status: 1,
            stderr: [
                "hyper-v-base-image-hash-mismatch",
                "hyper-v-powershell-execution-failed",
            ].join("\n"),
        }, true, "hyper-v-provider-command-failed")).toEqual(expect.objectContaining({
            diagnosticCode: "hyper-v-base-image-hash-mismatch",
            stderrPresent: true,
        }));
    });

    it("accepts only exact stdout marker lines and removes executable diagnostics", () => {
        const redacted = redactProviderCommandInput({
            mode: "exec",
            provider: "hyper-v",
            executable: "C:\\secret\\powershell.exe",
            args: ["-EncodedCommand", "reversible-secret-program"],
            input: "secret-input",
            status: 1,
            stdout: [
                "host text mentions hyper-v-vm-create-failed inline",
                "hyper-v-vm-configure-failed",
            ].join("\n"),
            stderr: "localized host failure",
            error: "spawn C:\\secret\\powershell.exe failed",
        }, true, "hyper-v-provider-command-failed");

        expect(redacted).toEqual(expect.objectContaining({
            mode: "exec",
            provider: "hyper-v",
            status: 1,
            diagnosticCode: "hyper-v-provider-command-failed",
            stdoutPresent: true,
            stderrPresent: true,
            inputConfigured: true,
            outputRedacted: true,
        }));
        expect(redacted).not.toHaveProperty("executable");
        expect(redacted).not.toHaveProperty("args");
        expect(redacted).not.toHaveProperty("error");
        expect(JSON.stringify(redacted)).not.toContain("secret");
    });

    let originalHomeRestore: (() => void) | undefined;
    let fixtureHome: string | undefined;

    beforeEach(() => {
        fixtureHome = mkdtempSync(join(tmpdir(), "ccc-device-broker-test-home-"));
        originalHomeRestore = isolateDeviceLabTestEnvironment(fixtureHome);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
        originalHomeRestore?.();
    });

    it("recognizes localized Windows taskkill failures when the process is already gone", () => {
        expect(windowsProcessTreeOutcome(128, "Windows localized process-not-found message", false)).toEqual({
            ok: true,
            stale: true,
        });
        expect(windowsProcessTreeOutcome(128, "Access denied", true)).toEqual({
            ok: false,
            stale: false,
        });
    });

    it("rejects malformed owner state without creating or replacing devices", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-malformed-owner-state-test");
        const root = writeBrokerDevices(ownerId, "android", [{ id: "duplicate" }, { id: "duplicate" }]);
        const stateFile = join(root, "devices.json");
        const malformed = readFileSync(stateFile, "utf8");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-malformed-owner-state-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", emulator: "/fake/emulator", avdmanager: "/fake/avdmanager" },
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_create", name: "New Device" },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-devices-state-invalid" }));
            expect(readFileSync(stateFile, "utf8")).toBe(malformed);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("keeps uncached automatic Hyper-V dry-runs free of host mutations", async () => {
        const cwd = join(process.env.HOME!, "broker-hyper-v-dry-run-test");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const commandRunner = vi.fn();
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            for (const [backend, profile] of [["windows-vm", "windows-server"], ["linux-vm", "ubuntu-lts"]] as const) {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.command.invoke",
                        params: { backend, command: "device_create", deviceId: `dry-${backend}`, name: `Dry ${backend}`, profile, dryRun: true },
                    }),
                });
                expect(response.status).toBe(409);
                expect(await response.json()).toEqual(expect.objectContaining({ ok: false, error: "hyper-v-base-image-not-prepared" }));
            }
            expect(commandRunner).not.toHaveBeenCalled();
            expect(existsSync(join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v"))).toBe(false);
            expect(existsSync(join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v"))).toBe(false);
            expect(existsSync(join(process.env.HOME!, ".ccc", "devices", "host-locks", "hyper-v.mutation.lock"))).toBe(false);
            expect(existsSync(join(process.env.HOME!, ".ccc", "devices", "owners", ownerId, "windows-vm", "operations"))).toBe(false);
            expect(existsSync(join(process.env.HOME!, ".ccc", "devices", "owners", ownerId, "linux-vm", "operations"))).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it.each([
        { profile: "windows-server", input: {}, conflicts: [] },
        { profile: "windows-server", input: { profile: "windows-server" }, conflicts: [] },
        { profile: "windows-server", input: { profile: "windows-11" }, conflicts: ["profile"] },
        { profile: "windows-11", input: {}, conflicts: ["profile"] },
        { profile: "windows-11", input: { profile: "windows-11" }, conflicts: [] },
        { profile: "windows-server", input: { baseImageSha256: "b".repeat(64) }, conflicts: ["baseImageSha256"] },
        { profile: "windows-server", input: { sourceImage: "different.vhdx" }, conflicts: ["sourceImage"] },
    ])("checks repeated Hyper-V create against automatic profile defaults: %j", async ({ profile, input, conflicts }) => {
        const cwd = "/project/broker-hyper-v-default-profile-retry";
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "nested-development-vm";
        const incarnationId = "1".repeat(32);
        const root = writeBrokerDevices(ownerId, "windows-vm", [{
            id: deviceId, name: deviceId, ownerId, backend: "windows-vm", provider: "hyper-v",
            incarnationId, profile, memoryMb: 4096, cpus: 2, networking: true,
            diskMaxBytes: 64 * 1024 * 1024 * 1024,
            nestedVirtualization: true, secureBootEnabled: true, secureBootTemplate: "MicrosoftWindows",
            baseImageSha256: "a".repeat(64), sourceImage: "original.vhdx", status: "stopped",
        }]);
        const stateFile = join(root, "devices.json");
        const originalState = readFileSync(stateFile, "utf8");
        const commandRunner = vi.fn(() => ({ mode: "exec", provider: "hyper-v", status: 0, stdout: "{}", stderr: "" }));
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", commandRunner });
        const baseUrl = await listen(server);
        try {
            for (const method of ["broker.command.plan", "broker.command.invoke"]) {
                const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                    method: "POST", headers: ownerRpcHeaders(ownerId),
                    body: JSON.stringify({ method, params: {
                        backend: "windows-vm", command: "device_create", deviceId, name: deviceId,
                        nestedVirtualization: true, ...input,
                    } }),
                });
                const payload = await response.json();
                expect(response.status, JSON.stringify(payload)).toBe(conflicts.length ? 409 : 200);
                if (conflicts.length) {
                    expect(payload).toMatchObject({ ok: false, error: "hyper-v-create-configuration-conflict", conflicts });
                } else {
                    expect(payload).toMatchObject({ ok: true, result: { idempotent: true, device: { id: deviceId, profile, incarnationId } } });
                }
            }
            expect(commandRunner).not.toHaveBeenCalled();
            expect(readFileSync(stateFile, "utf8")).toBe(originalState);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("enforces owner-scoped Hyper-V definition and running quotas before provider execution", async () => {
        const cwd = "/project/broker-hyper-v-quota-test";
        const ownerId = deviceLabOwnerId(cwd);
        const defined = Array.from({ length: 16 }, (_, index) => ({
            id: `defined-${index}`,
            backend: "windows-vm",
            memoryMb: 4096,
            cpus: 2,
            diskMaxBytes: 64 * 1024 * 1024 * 1024,
            status: "stopped",
            runtimeState: "Off",
        }));
        writeBrokerDevices(ownerId, "windows-vm", defined);
        const commandRunner = vi.fn(() => ({ mode: "exec", provider: "hyper-v", status: 0, stdout: "{}", stderr: "" }));
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const create = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-vm", command: "device_create", name: "Over quota", profile: "windows-11" },
                }),
            });
            expect(create.status).toBe(409);
            expect(await create.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "hyper-v-owner-quota-exceeded",
                violations: expect.arrayContaining(["defined-vms"]),
            }));
            expect(commandRunner).not.toHaveBeenCalled();

            const running = Array.from({ length: 4 }, (_, index) => ({
                id: `running-${index}`,
                backend: "windows-vm",
                memoryMb: 4096,
                cpus: 2,
                diskMaxBytes: 64 * 1024 * 1024 * 1024,
                status: "running",
                runtimeState: "Running",
            }));
            const targetId = "stopped-target";
            writeBrokerDevices(ownerId, "windows-vm", [...running, {
                id: targetId,
                backend: "windows-vm",
                memoryMb: 4096,
                cpus: 2,
                diskMaxBytes: 64 * 1024 * 1024 * 1024,
                status: "stopped",
                runtimeState: "Off",
            }]);
            const start = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "windows-vm", command: "device_start", deviceId: targetId } }),
            });
            expect(start.status).toBe(409);
            expect(await start.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "hyper-v-owner-quota-exceeded",
                violations: expect.arrayContaining(["running-vms"]),
            }));
            expect(commandRunner).not.toHaveBeenCalled();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("creates owner-scoped Windows Sandbox definitions through the host broker", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-create-test");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-create-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: "/fake/wsb" },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const expectedConfigPath = join(backendRoot(ownerId, "windows"), "windows-broker-win", "windows-broker-win.wsb");
            const externalConfigTarget = join(process.env.HOME!, "external-windows-config.wsb");
            if (process.platform !== "win32") {
                mkdirSync(dirname(expectedConfigPath), { recursive: true });
                writeFileSync(externalConfigTarget, "external-config-target");
                symlinkSync(externalConfigTarget, expectedConfigPath);
            }
            const created = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "windows-sandbox",
                        command: "device_create",
                        name: "Broker Win",
                        networking: true,
                        memoryMb: 2048,
                    },
                }),
            });
            expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
            const createBody = await created.json() as { result: { device: { id: string; configPath: string; status: string; minimized: boolean } } };
            expect(createBody.result.device).toEqual(expect.objectContaining({
                id: "windows-broker-win",
                status: "stopped",
                authority: "host-broker",
                minimized: true,
            }));
            expect(existsSync(createBody.result.device.configPath)).toBe(true);
            expect(lstatSync(createBody.result.device.configPath).isSymbolicLink()).toBe(false);
            if (process.platform !== "win32") expect(readFileSync(externalConfigTarget, "utf8")).toBe("external-config-target");
            const config = readFileSync(createBody.result.device.configPath, "utf-8");
            expect(config).toContain("<Networking>Enable</Networking>");
            expect(config).toContain("<MappedFolders>");
            expect(config).not.toContain("<SandboxFolder>C:\\ccc\\scratch</SandboxFolder>");
            expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch\\inbox</SandboxFolder>");
            expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch\\outbox</SandboxFolder>");
            expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch\\uploads</SandboxFolder>");
            expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch\\downloads</SandboxFolder>");
            expect(config).toContain("<SandboxFolder>C:\\ccc\\tools</SandboxFolder>");
            expect(config.match(/<MappedFolder>/g)).toHaveLength(5);
            expect(config.match(/<ReadOnly>false<\/ReadOnly>/g)).toHaveLength(4);
            expect(config.match(/<ReadOnly>true<\/ReadOnly>/g)).toHaveLength(1);
            expect(config).toContain("<LogonCommand>");
            expect(config).toContain("wscript.exe //B C:\\ccc\\tools\\ccc-guest-helper-bootstrap.vbs");
            expect(config).not.toContain("<Command>powershell.exe");
            expect(existsSync(join(dirname(createBody.result.device.configPath), "tools"))).toBe(true);
            expect(existsSync(join(dirname(createBody.result.device.configPath), "inbox"))).toBe(true);
            const helperScript = readFileSync(join(dirname(createBody.result.device.configPath), "tools", "ccc-guest-helper.ps1"), "utf-8");
            expect(helperScript).toContain("param([string]$OnceRequestPath = '')");
            expect(helperScript).toContain("Invoke-CccRequest");
            expect(helperScript).toContain("ccc-guest-helper.ready.txt");
            const bootstrap = readFileSync(join(dirname(createBody.result.device.configPath), "tools", "ccc-guest-helper-bootstrap.ps1"), "utf-8");
            expect(bootstrap).toContain("waiting-helper");
            expect(bootstrap).toContain("ccc-guest-helper.ps1");
            const bootstrapLauncher = readFileSync(join(dirname(createBody.result.device.configPath), "tools", "ccc-guest-helper-bootstrap.vbs"), "utf-8");
            expect(bootstrapLauncher).toContain("WScript.Shell");
            expect(bootstrapLauncher).toContain("-WindowStyle Hidden");
            expect(bootstrapLauncher).toContain("ccc-guest-helper-bootstrap.ps1");

            const duplicate = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "windows-sandbox",
                        command: "device_create",
                        name: "Broker Win",
                    },
                }),
            });
            expect(duplicate.status).toBe(409);
            expect(await duplicate.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-device-already-exists",
                deviceId: "windows-broker-win",
            }));

            const startPlan = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: {
                        backend: "windows-sandbox",
                        command: "device_start",
                        deviceId: "windows-broker-win",
                    },
                }),
            });
            expect(startPlan.status).toBe(200);
            const planBody = await startPlan.json() as { result: { providerCommand: { provider: string; executable: string; args: string[]; windowStyle?: string } } };
            expect(planBody.result.providerCommand).toEqual(expect.objectContaining({
                provider: "wsb",
                executable: "/fake/wsb",
                windowStyle: "minimized",
            }));
            expect(planBody.result.providerCommand.args.join(" ")).toContain("<Networking>Enable</Networking>");
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    // The typed library has no self-reported `deleted` flag to distrust, so rollback confirmation is
    // now an observation: the checkpoint must be gone afterwards. These are the three ways the host
    // can fail to establish that, all of which must still leave the rollback unconfirmed.
    it.each([
        ["a still-present checkpoint", "checkpoint-remains"],
        ["a native error", "native-error"],
        ["malformed output", "malformed"],
    ])("preserves snapshot journal evidence when create rollback returns %s", async (_name, rollbackFailure) => {
        const cwd = join(process.env.HOME!, `broker-hyper-v-snapshot-rollback-${_name.replaceAll(" ", "-")}`);
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "snapshot-rollback";
        const incarnationId = "1".repeat(32);
        const vmId = "12345678-1234-1234-1234-123456789abc";
        const snapshotId = "87654321-4321-4321-4321-cba987654321";
        const rollbackSecret = "snapshot-rollback-host-secret";
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId);
        const deviceRoot = join(privateRoot, "artifacts");
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        const stateRoot = writeBrokerDevices(ownerId, "windows-vm", [{
            id: deviceId,
            name: "Snapshot rollback",
            ownerId,
            backend: "windows-vm",
            provider: "hyper-v",
            incarnationId,
            vmId,
            vmName,
            diskPath,
            privateRoot,
            deviceRoot,
            status: "stopped",
            runtimeState: "Off",
            snapshots: [],
        }]);
        mkdirSync(dirname(diskPath), { recursive: true });
        writeFileSync(diskPath, "root-vhdx");
        const stateFile = join(stateRoot, "devices.json");
        const providerName = `ccc-${ownerId}-rollback`;
        const nativeSnapshot = {
            id: snapshotId,
            name: providerName,
            vmId,
            vmName,
            snapshotType: "Recovery",
            parentSnapshotId: null,
            parentSnapshotName: null,
            creationTimeMilliseconds: 1_700_000_000_000,
        };
        const nativeEnvelope = (operation: string, items: unknown[]) =>
            JSON.stringify({ schemaVersion: 1, operation, ok: true, items });
        let removeAttempted = false;
        const commandRunner = vi.fn((command) => {
            const script = providerScript(command);
            const nativeRequest = nativeLibraryRequest(command);
            if (nativeRequest) {
                if (nativeRequest.operation === "Get-VM") {
                    return { ...command, status: 0, stdout: nativeEnvelope("Get-VM", [{
                        id: vmId, name: vmName, state: "Off", status: "Operating normally",
                        notes: `ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`,
                        uptimeMilliseconds: 0, generation: 2, checkpointType: "ProductionOnly",
                    }]), stderr: "" };
                }
                if (nativeRequest.operation === "Get-VMHardDiskDrive") {
                    return { ...command, status: 0, stdout: nativeEnvelope("Get-VMHardDiskDrive", [{
                        vmId, vmName, path: diskPath, controllerType: "SCSI",
                        controllerNumber: 0, controllerLocation: 0, diskNumber: null,
                    }]), stderr: "" };
                }
                if (nativeRequest.operation === "Checkpoint-VM") {
                    const state = JSON.parse(readFileSync(stateFile, "utf8"));
                    writeFileSync(stateFile, JSON.stringify({ devices: state.devices.map((device: Record<string, unknown>) => ({ ...device, concurrentMutation: true })) }));
                    return { ...command, status: 0, stdout: nativeEnvelope("Checkpoint-VM", [nativeSnapshot]), stderr: "" };
                }
                if (nativeRequest.operation === "Get-VMSnapshot") {
                    // The checkpoint stays visible after a failed rollback, which is exactly what
                    // leaves the deletion unconfirmed in the "checkpoint-remains" case.
                    const present = !removeAttempted || rollbackFailure === "checkpoint-remains";
                    return { ...command, status: 0, stdout: nativeEnvelope("Get-VMSnapshot", present ? [nativeSnapshot] : []), stderr: "" };
                }
                if (nativeRequest.operation === "Repair-VMSnapshotState") {
                    return { ...command, status: 0, stdout: nativeEnvelope("Repair-VMSnapshotState", [{
                        checkpointPolicy: "ProductionOnly", candidateCount: snapshotExists ? 1 : 0,
                    }]), stderr: "" };
                }
                if (nativeRequest.operation === "Get-VHD") {
                    return {
                        ...command,
                        status: 0,
                        stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VHD", ok: true, items: [{
                            path: nativeRequest.path,
                            vhdFormat: "VHDX",
                            vhdType: "Dynamic",
                            parentPath: null,
                            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
                            fileSizeBytes: 1024,
                        }] }),
                        stderr: "",
                    };
                }
                if (nativeRequest.operation === "Remove-VMSnapshot") {
                    removeAttempted = true;
                    const leaked = {
                        ...command,
                        executable: `C:\\host-secret\\${rollbackSecret}\\powershell.exe`,
                        args: ["-EncodedCommand", rollbackSecret],
                        stderr: "",
                        error: `host error at C:\\host-secret\\${rollbackSecret}`,
                    };
                    if (rollbackFailure === "native-error") {
                        return { ...leaked, status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: "Remove-VMSnapshot", ok: false, errorCode: "snapshot-not-found" }) };
                    }
                    if (rollbackFailure === "malformed") {
                        return { ...leaked, status: 0, stdout: "not-json" };
                    }
                    return { ...leaked, status: 0, stdout: nativeEnvelope("Remove-VMSnapshot", []) };
                }
                return { ...command, status: 0, stdout: nativeEnvelope(nativeRequest.operation, []), stderr: "" };
            }
            if (script.includes("$Snapshots = @(Get-VMSnapshot")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId, vmName, state: "Off", status: "Operating normally", diskPath, checkpointPolicy: "ProductionOnly", snapshots: [] }), stderr: "" };
            }
            return { ...command, status: 1, stdout: "", stderr: "unexpected provider command" };
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_snapshot_create", backend: "windows-vm", deviceId, incarnationId, snapshotName: "rollback" },
                }),
            });
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body).toEqual(expect.objectContaining({
                error: "hyper-v-snapshot-state-conflict",
                rollback: expect.objectContaining({ confirmed: false, error: "hyper-v-snapshot-rollback-unconfirmed" }),
            }));
            expect(body.rollback.execution).not.toHaveProperty("executable");
            expect(body.rollback.execution).not.toHaveProperty("args");
            expect(body.rollback.execution).not.toHaveProperty("error");
            expect(JSON.stringify(body)).not.toContain(rollbackSecret);
            expect(existsSync(join(deviceRoot, "snapshot-operation.json"))).toBe(true);
            expect(JSON.parse(readFileSync(stateFile, "utf8")).devices[0]).toEqual(expect.objectContaining({ concurrentMutation: true, snapshots: [] }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("runs an owner-fenced Hyper-V Windows VM lifecycle through the host broker", async () => {
        const cwd = join(process.env.HOME!, "broker-hyper-v-lifecycle-test");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "windows-vm-e2e";
        const vmId = "12345678-1234-1234-1234-123456789abc";
        const snapshotId = "87654321-4321-4321-4321-cba987654321";
        let vmName = "";
        const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId);
        const deviceRoot = join(privateRoot, "artifacts");
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        const imageRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v");
        const imageProfileRoot = join(imageRoot, "windows-11");
        const imagePath = join(imageProfileRoot, "base.vhdx");
        const sourceImagePath = join(cwd, "windows-11-generalized.vhdx");
        const credentialPath = join(privateRoot, "secrets", "guest.credential.xml");
        const provisioningMediaPath = join(deviceRoot, "disks", "autounattend.iso");
        const uploadPath = join(cwd, "upload.txt");
        const downloadPath = join(cwd, "download.txt");
        const staleMarkerPath = join(dirname(diskPath), "stale-operation.txt");
        const staleIncarnationId = "0".repeat(32);
        writeFileSync(sourceImagePath, "fake-vhdx");
        const imageSha256 = createHash("sha256").update("fake-vhdx").digest("hex");
        const expectedNetworkAddress = `172.29.0.${10 + (createHash("sha256").update(`${ownerId}\0${deviceId}\0address`).digest().readUInt32BE(0) % 241)}`;
        writeFileSync(uploadPath, "upload");
        mkdirSync(dirname(staleMarkerPath), { recursive: true });
        writeFileSync(staleMarkerPath, "interrupted-create");
        writeFileSync(join(privateRoot, "incarnation.json"), JSON.stringify({
            version: 1,
            ownerId,
            backend: "windows-vm",
            deviceId,
            incarnationId: staleIncarnationId,
            createdAt: new Date().toISOString(),
        }));
        let vmState = "Off";
        let vmExists = false;
        let createdVmNotes = "";
        let typedVmCreateCalls = 0;
        const typedVhdPaths: string[] = [];
        let sameNameReplacementVmId: string | null = null;
        let observedNativeDiskPath: string | null = diskPath;
        let observedPassThroughDiskNumber: number | null = null;
        let snapshotExists = false;
        let orphanRecoveryCalls = 0;
        let preparedSourcePath = "";
        let networkCleanupFailure: false | "nonzero" | "invalid" | "in-use" = false;
        let guestReadyScrubFailure: false
            | "hyper-v-guest-first-logon-incomplete"
            | "hyper-v-guest-provisioning-not-scrubbed"
            | "powershell-direct-attempt-timeout"
            | "powershell-direct-authentication-failed"
            | "powershell-direct-session-unavailable"
            | "powershell-direct-unavailable"
            | "hyper-v-guest-network-not-ready" = false;
        // The fifth probe-never-returned reason is not one the script can throw: the four above
        // ride the readiness script's own structured failure JSON, while `powershell-direct-timeout`
        // is synthesized by the broker when the readiness command itself times out and emits no
        // JSON at all. Reaching it needs the command to time out, not a reason to be injected.
        let guestReadyCommandTimedOut = false;
        // Mirrors the script's $ScrubConfirmed latch: true for failures thrown BELOW both scrub
        // gates, where the guest is clean and only the media removal or network check failed.
        let guestReadyScrubFailureScrubbed = false;
        let guestReadyScrubFailureDetached = false;
        // Renames the VM in the start observation so the broker's identity gate rejects it.
        // That is one of the two exits between Start-VM and readiness, and it leaves the guest
        // Running with no readiness result at all — the state where a failed containment used
        // to be recorded nowhere.
        let startObservationMismatch = false;
        let startObservationGetVmCount = 0;
        // Lets the post-failure boot diagnostic report a state other than the fixture's own
        // vmState, which is what the containment skip-guard reads.
        let diagnosticStateOverride = "";
        let containmentStopFailure = false;
        let deleteConfirmationFailure = false;
        let snapshotDeleteConfirmationFailure = false;
        let snapshotProviderFailure = false;
        let snapshotOwnershipMismatch = false;
        let snapshotRestoreProviderFailure = false;
        let snapshotRepairResult: "normal" | "invalid" | "timeout" | "count-mismatch" = "normal";
        let observedSnapshotId: string | null = null;
        let observedSnapshotName: string | null = null;
        let restoreRetryJournalObserved = false;
        let guestExecExitCode = 0;
        let focusWindowOutput = '{"ok":true}';
        let windowListOutput = '{"windows":[{"handle":"42","title":"Guest Notes","processId":123}]}';
        let guestDownloadReportedBytes = 6;
        let guestDownloadLostResponse = false;
        let checkpointPolicy: "Disabled" | "ProductionOnly" = "ProductionOnly";
        const commandRunner = vi.fn((command) => {
            const script = providerScript(command);
            const nativeRequest = nativeLibraryRequest(command);
            if (nativeRequest) {
                if (nativeRequest.operation === "Get-VMDiagnostic") {
                    return {
                        ...command,
                        status: 0,
                        stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VMDiagnostic", ok: true, items: [{
                            ok: true,
                            vmId,
                            vmName,
                            state: diagnosticStateOverride || vmState,
                            uptimeMs: 60000,
                            generation: 2,
                            secureBootEnabled: true,
                            heartbeatEnabled: true,
                            heartbeatPrimaryStatus: 2,
                            heartbeatSecondaryStatus: 0,
                            integrationServices: [],
                            hardDiskCount: 1,
                            dvdCount: 1,
                            hardDiskControllers: ["scsi"],
                            bootDeviceTypes: ["hard-disk"],
                            bootEntries: [],
                            hardDisks: [],
                            dvdDrives: [],
                            diagnosticComplete: true,
                            diagnosticErrors: [],
                        }] }),
                        stderr: "",
                    };
                }
                if (nativeRequest.operation === "Invoke-Guest") {
                    const action = nativeRequest.action;
                    if (action === "job") {
                        if (guestReadyCommandTimedOut) return { ...command, status: null, stdout: "", timedOut: true };
                        if (!guestReadyScrubFailureScrubbed && typeof guestReadyScrubFailure === "string" && guestReadyScrubFailure.startsWith("powershell-direct-")) {
                            return { ...command, status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: "Invoke-Guest", ok: false, errorCode: guestReadyScrubFailure }) };
                        }
                        const result = {
                            computerName: "CCC-WIN",
                            addresses: guestReadyScrubFailure === "hyper-v-guest-network-not-ready" ? [] : [expectedNetworkAddress],
                            firstLogonCompleted: guestReadyScrubFailure === "hyper-v-guest-first-logon-incomplete" ? "wrong-incarnation" : nativeRequest.expectedNotes,
                            provisioningSecretsPresent: guestReadyScrubFailure === "hyper-v-guest-provisioning-not-scrubbed",
                        };
                        return { ...command, status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: "Invoke-Guest", ok: true, items: [{ action: "job", output: JSON.stringify(result) }] }) };
                    }
                    if (action === "download") {
                        mkdirSync(dirname(nativeRequest.localPath!), { recursive: true });
                        writeFileSync(nativeRequest.localPath!, "output");
                        if (guestDownloadLostResponse) {
                            return { ...command, status: null, stdout: "", error: `lost response at ${credentialPath}` };
                        }
                    }
                    const item = action === "exec"
                        ? { action, status: guestExecExitCode, stdout: guestExecExitCode === 0 ? (nativeRequest.command?.includes("CCCWin") ? windowListOutput : nativeRequest.command?.includes("CCCFocus") ? focusWindowOutput : "guest-ok\r\n") : "", stderr: guestExecExitCode === 0 ? "" : "guest-failed" }
                        : action === "mkdir" ? { action }
                            : { action, localPath: nativeRequest.localPath, remotePath: nativeRequest.remotePath, bytes: action === "upload" ? statSync(nativeRequest.localPath!).size : guestDownloadReportedBytes };
                    return { ...command, status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: "Invoke-Guest", ok: true, items: [item] }), stderr: "" };
                }
                if (nativeRequest.operation === "Remove-VMDvdDrive") {
                    return guestReadyScrubFailureScrubbed && !guestReadyScrubFailureDetached
                        ? { ...command, status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: "Remove-VMDvdDrive", ok: false, errorCode: "dvd-still-attached" }) }
                        : { ...command, status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: "Remove-VMDvdDrive", ok: true, items: [] }) };
                }
                if (nativeRequest.operation === "Start-VM") vmState = "Running";
                if (nativeRequest.operation === "Stop-VM" && containmentStopFailure) {
                    return { ...command, status: 1, stdout: "", stderr: "simulated containment stop failure" };
                }
                if (nativeRequest.operation === "Stop-VM") vmState = "Off";
                if (nativeRequest.operation === "Remove-VM" && !deleteConfirmationFailure) vmExists = false;
                if (nativeRequest.operation === "Remove-HostFiles") {
                    if (typedVmCreateCalls === 0) orphanRecoveryCalls += 1;
                    let removedCount = 0;
                    for (const path of nativeRequest.paths || []) {
                        if (existsSync(path)) {
                            rmSync(path, { force: true });
                            removedCount += 1;
                        }
                    }
                    return { ...command, status: 0, stdout: nativeEnvelope("Remove-HostFiles", [{ removedCount }]), stderr: "" };
                }
                if (nativeRequest.operation === "Restore-VMSnapshot") {
                    if (snapshotRestoreProviderFailure) {
                        snapshotRestoreProviderFailure = false;
                        return { ...command, status: 1, stdout: "", stderr: "simulated restore provider failure" };
                    }
                    if (existsSync(join(deviceRoot, "snapshot-operation.json"))) restoreRetryJournalObserved = true;
                    vmState = "Off";
                }
                if (nativeRequest.operation === "Checkpoint-VM") {
                    if (snapshotProviderFailure) {
                        return { ...command, status: 1, stdout: "", stderr: "simulated checkpoint provider failure" };
                    }
                    snapshotExists = true;
                }
                if (nativeRequest.operation === "Remove-VMSnapshot" && !snapshotDeleteConfirmationFailure) snapshotExists = false;
                const nativeSnapshot = {
                    id: observedSnapshotId ?? snapshotId,
                    name: observedSnapshotName ?? `ccc-${ownerId}-before-install`,
                    vmId,
                    vmName,
                    snapshotType: "Recovery",
                    parentSnapshotId: null,
                    parentSnapshotName: null,
                    creationTimeMilliseconds: 1_700_000_000_000,
                };
                if (nativeRequest.operation === "Checkpoint-VM") {
                    // A host that reports success but names the checkpoint something other than the
                    // owner-scoped name. The legacy path caught this by re-reading the observation.
                    const created = snapshotOwnershipMismatch
                        ? { ...nativeSnapshot, name: "not-the-owner-scoped-name" }
                        : nativeSnapshot;
                    return {
                        ...command,
                        status: 0,
                        stdout: JSON.stringify({ schemaVersion: 1, operation: "Checkpoint-VM", ok: true, items: [created] }),
                        stderr: "",
                    };
                }
                if (nativeRequest.operation === "Get-VMSnapshot") {
                    return {
                        ...command,
                        status: 0,
                        stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VMSnapshot", ok: true, items: snapshotExists ? [nativeSnapshot] : [] }),
                        stderr: "",
                    };
                }
                if (nativeRequest.operation === "Repair-VMSnapshotState") {
                    if (snapshotRepairResult === "timeout") {
                        return { ...command, status: null, stdout: "", stderr: "", timedOut: true };
                    }
                    const candidateExists = snapshotExists
                        && nativeSnapshot.name.toLowerCase() === nativeRequest.snapshotName.toLowerCase();
                    return { ...command, status: 0, stdout: nativeEnvelope("Repair-VMSnapshotState", [{
                        checkpointPolicy: "ProductionOnly", candidateCount: snapshotRepairResult === "invalid" ? 2
                            : snapshotRepairResult === "count-mismatch" ? candidateExists ? 0 : 1 : candidateExists ? 1 : 0,
                    }]), stderr: "" };
                }
                if (nativeRequest.operation === "Get-VHD") {
                    return { ...command, status: 0, stdout: nativeEnvelope("Get-VHD", [{
                        path: nativeRequest.path,
                        vhdFormat: "VHDX",
                        vhdType: "Dynamic",
                        parentPath: null,
                        virtualSizeBytes: 64 * 1024 * 1024 * 1024,
                        fileSizeBytes: 1024,
                    }]), stderr: "" };
                }
                const observedVmId = vmExists
                    ? vmId
                    : nativeRequest.operation === "Get-VM" && nativeRequest.selector?.kind === "name"
                        ? sameNameReplacementVmId
                        : null;
                const observedName = startObservationMismatch && nativeRequest.operation === "Get-VM"
                    && ++startObservationGetVmCount === 2 ? "ccc-renamed-out-of-band" : vmName;
                const items = nativeRequest.operation === "Get-VM"
                    ? observedVmId ? [{
                        id: observedVmId,
                        name: observedName,
                        state: vmState,
                        status: "Operating normally",
                        notes: createdVmNotes,
                        uptimeMilliseconds: 42,
                        generation: 2,
                        checkpointType: checkpointPolicy,
                    }] : []
                    : nativeRequest.operation === "Get-VMHardDiskDrive"
                    ? vmExists && (observedNativeDiskPath !== null || observedPassThroughDiskNumber !== null) ? [{
                        vmId,
                        vmName,
                        path: observedNativeDiskPath,
                        controllerType: "SCSI",
                        controllerNumber: 0,
                        controllerLocation: 0,
                        diskNumber: observedPassThroughDiskNumber,
                    }] : []
                    : nativeRequest.operation === "Get-VMDvdDrive"
                    ? guestReadyScrubFailureScrubbed && !guestReadyScrubFailureDetached ? [{
                        vmId, vmName, path: provisioningMediaPath, controllerType: "SCSI",
                        controllerNumber: 0, controllerLocation: 1,
                    }] : []
                    : [];
                return {
                    ...command,
                    status: 0,
                    stdout: JSON.stringify({ schemaVersion: 1, operation: nativeRequest.operation, ok: true, items }),
                    stderr: "",
                };
            }
            if (script.includes("Start-VM")) vmState = "Running";
            // The containment stop travels this script path, not the native-library one, so the
            // failure injection has to sit here to be reached at all.
            if (script.includes("Stop-VM") && containmentStopFailure) {
                return { ...command, status: 1, stdout: "", stderr: "simulated containment stop failure" };
            }
            if (script.includes("Stop-VM")) vmState = "Off";
            const deleting = script.includes("Remove-VM -VM $Vm");
            const snapshotCreate = script.includes("Checkpoint-VM") || script.includes("New-CccVmSnapshot");
            const snapshotRepair = script.includes("Repair-CccVmSnapshotState");
            const snapshotDelete = script.includes("snapshotId = [string]$Snapshot.Id") && script.includes("deleted = $true");
            const snapshotOperation = snapshotCreate || script.includes("Restore-VMSnapshot") || snapshotDelete;
            if (snapshotRestoreProviderFailure && script.includes("Restore-VMSnapshot")) {
                snapshotRestoreProviderFailure = false;
                return { ...command, status: 1, stdout: "", stderr: "simulated restore provider failure" };
            }
            if (script.includes("Restore-VMSnapshot") && existsSync(join(deviceRoot, "snapshot-operation.json"))) {
                restoreRetryJournalObserved = true;
            }
            if (snapshotProviderFailure && snapshotCreate) {
                return { ...command, status: 1, stdout: "", stderr: "simulated checkpoint provider failure" };
            }
            if (snapshotCreate) snapshotExists = true;
            if (snapshotDelete && !snapshotDeleteConfirmationFailure) snapshotExists = false;
            const imagePrepare = script.includes("hyper-v-base-image-profile-conflict");
            if (imagePrepare) preparedSourcePath = script.match(/\$SourceImage = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
            const networkSetup = script.includes("New-NetNat -Name $NatName");
            const networkCleanup = isHyperVNetworkCleanupScript(script);
            if (networkCleanup && networkCleanupFailure === "nonzero") {
                return {
                    ...command,
                    args: ["-EncodedCommand", "network-cleanup-host-secret"],
                    status: 1,
                    stdout: "",
                    stderr: "simulated network cleanup failure at C:\\network-cleanup-host-secret",
                    error: "spawn network-cleanup-host-secret",
                };
            }
            if (networkCleanup && networkCleanupFailure === "invalid") {
                return {
                    ...command,
                    args: ["-EncodedCommand", "network-cleanup-invalid-secret"],
                    status: 0,
                    stdout: "malformed network cleanup output",
                    stderr: "host path C:\\network-cleanup-invalid-secret",
                };
            }
            if (networkCleanup && networkCleanupFailure === "in-use") {
                return {
                    ...command,
                    status: 0,
                    stdout: JSON.stringify({ ok: true, removedSwitch: false, removedNat: false, removedGateway: false, alreadyMissing: false, deferred: true, reason: "hyper-v-network-switch-in-use" }),
                    stderr: "",
                };
            }
            const orphanRecovery = script.includes("hyper-v-orphan-vm-ownership-mismatch");
            const vmCreate = script.includes("New-VM");
            if (vmCreate) {
                vmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                vmExists = true;
                observedNativeDiskPath = diskPath;
            }
            if (orphanRecovery) orphanRecoveryCalls += 1;
            const guestProvision = script.includes("Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND'");
            const guestReady = script.includes("hyper-v-guest-ready-timeout");
            // A boot diagnostic that actually parses, reporting the CURRENT vmState. Previously the
            // fixture returned something invalid, so lastBootCheck carried no diagnostic at all and
            // nothing could observe whether it had been captured before or after containment.
            const guestBootDiagnostic = script.includes("Get-CccGuestBootDiagnosticResult $Vm");
            if (guestBootDiagnostic) {
                return {
                    ...command,
                    status: 0,
                    stdout: JSON.stringify({
                        ok: true,
                        vmId,
                        vmName,
                        state: diagnosticStateOverride || vmState,
                        uptimeMs: 60000,
                        generation: 2,
                        secureBootEnabled: true,
                        heartbeatEnabled: true,
                        heartbeatPrimaryStatus: 2,
                        heartbeatSecondaryStatus: 0,
                        integrationServices: [],
                        hardDiskCount: 1,
                        dvdCount: 1,
                        hardDiskControllers: ["scsi"],
                        bootDeviceTypes: ["hard-disk"],
                        bootEntries: [],
                        hardDisks: [],
                        dvdDrives: [],
                        diagnosticComplete: true,
                        diagnosticErrors: [],
                    }),
                    stderr: "",
                };
            }
            const guestExec = script.includes("Start-Process -FilePath 'powershell.exe'");
            const guestUpload = script.includes("-ToSession $Session");
            const guestDownload = script.includes("hyper-v-guest-download-source-missing")
                && script.includes("[Convert]::FromBase64String");
            const transferLocalPath = script.match(/\$LocalPath = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || null;
            if (guestDownload && transferLocalPath) {
                mkdirSync(dirname(transferLocalPath), { recursive: true });
                writeFileSync(transferLocalPath, "output");
            }
            if (imagePrepare) {
                mkdirSync(imageProfileRoot, { recursive: true });
                writeFileSync(imagePath, "fake-vhdx");
            }
            if (vmCreate) {
                mkdirSync(dirname(diskPath), { recursive: true });
                writeFileSync(diskPath, "fake-root-vhdx");
            }
            if (guestProvision) {
                mkdirSync(dirname(credentialPath), { recursive: true });
                writeFileSync(credentialPath, "fake-dpapi-credential");
            }
            if (deleting && !deleteConfirmationFailure) vmExists = false;
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args || [],
                status: 0,
                stdout: JSON.stringify(imagePrepare
                    ? { ok: true, profile: "windows-11", imagePath, sha256: imageSha256, sizeBytes: 9, virtualSizeBytes: 64 * 1024 * 1024 * 1024, vhdType: "Dynamic", generation: 2, reused: false }
                    : networkCleanup
                    ? { ok: true, removedSwitch: true, removedNat: true, removedGateway: true, alreadyMissing: false }
                    : orphanRecovery
                    ? { ok: true, recoveredVm: orphanRecoveryCalls === 1, removedDisk: orphanRecoveryCalls === 1 }
                    : networkSetup
                    ? hyperVNetworkObservation(command)
                    : guestReady && guestReadyScrubFailure
                    ? {
                        ok: false,
                        error: "hyper-v-guest-ready-timeout",
                        reason: guestReadyScrubFailure,
                        attempts: 150,
                        // The real script latches this once both scrub gates pass, so it is true for
                        // exactly the failures thrown below them — the network check and the media
                        // removal. Mirroring that here is what lets the media-retained arm be tested
                        // for the case where the guest is clean but its ISO could not be deleted.
                        scrubConfirmed: guestReadyScrubFailureScrubbed,
                        // Latched separately in the real script, after the DVD is actually gone.
                        // A scrubbed guest whose drive could not be detached still has the
                        // plaintext answer file mounted and readable inside it.
                        mediaDetached: guestReadyScrubFailureDetached,
                    }
                    : guestReady
                    ? { ok: true, vmId, vmName, computerName: "CCC-WIN", attempts: 2, networkAddress: expectedNetworkAddress }
                    : guestProvision
                    ? { ok: true, vmId, vmName, guestUsername: `ccc${ownerId.slice(0, 8)}`, credentialPath, unattendPath: provisioningMediaPath }
                    : guestExec
                    ? { ok: true, status: 0, stdout: "guest-ok\r\n", stderr: "" }
                    : guestUpload || guestDownload
                        ? { ok: true, localPath: transferLocalPath, remotePath: guestUpload ? "C:\\ccc\\upload.txt" : "C:\\ccc\\download.txt", bytes: 6 }
                    : snapshotRepair
                    ? { ok: true, checkpointPolicy: "ProductionOnly", candidateCount: snapshotExists ? 1 : 0 }
                    : snapshotOperation
                    ? { ok: true, snapshotId, snapshotName: `ccc-${ownerId}-before-install`, snapshotType: "Recovery", state: vmState, ...(snapshotDelete ? { deleted: !snapshotDeleteConfirmationFailure } : {}) }
                    : { ok: true, vmId, vmName: startObservationMismatch ? "ccc-renamed-out-of-band" : vmName, state: vmState, status: "Operating normally", generation: 2, diskPath, checkpointPolicy, snapshots: snapshotExists ? [{ snapshotId, snapshotName: `ccc-${ownerId}-before-install`, snapshotType: "Recovery" }] : [], ...(deleting ? { deleted: !deleteConfirmationFailure } : {}) }),
                stderr: snapshotOperation
                    ? "host path C:\\snapshot-provider-host-secret"
                    : "",
                // A readiness command that never came back: no structured JSON to parse, so the
                // broker names the cause itself. Spread last so it overrides the stdout and status
                // the branches above chose.
                // Carrying the real wrapper's error text, not just the shape. Without it the case
                // asserts the timeout branch but never pins that a genuine timeout's message
                // cannot satisfy the `/^hyper-v-[a-z0-9-]+$/` allowlist tested just above that
                // branch — which is the thing that would silently reroute it.
                ...(guestReady && guestReadyCommandTimedOut
                    ? { status: null, stdout: "", timedOut: true, error: "device-lab provider wrapper timed out after 1000ms" }
                    : {}),
            };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: "until-readback",
            beforeOperation(request) {
                if (request.operation === "Remove-NetNat" && networkCleanupFailure === "nonzero") {
                    return {
                        status: null,
                        stdout: "",
                        stderr: "",
                        error: "hyper-v-network-elevation-request-failed",
                    };
                }
                if (request.operation === "Remove-NetNat" && networkCleanupFailure === "invalid") {
                    return { status: 0, stdout: "malformed network cleanup output", stderr: "" };
                }
                if (request.operation === "Get-VMNetworkAdapter" && networkCleanupFailure === "in-use") {
                    return {
                        status: 0,
                        stdout: JSON.stringify({
                            schemaVersion: 1,
                            operation: "Get-VMNetworkAdapter",
                            ok: true,
                            items: [{
                                vmId,
                                vmName,
                                name: "Network Adapter",
                                switchId: "00000000-0000-0000-0000-000000000001",
                                switchName: "CCC Device Lab",
                                status: "Ok",
                                managementOperatingSystem: false,
                                macAddress: "02155D011A2C",
                                ipAddresses: [],
                            }],
                        }),
                        stderr: "",
                    };
                }
                return null;
            },
            onOperation(request) {
                if (request.operation === "Get-VHD" && request.path) typedVhdPaths.push(request.path);
                if (request.operation === "Mount-VHD" && request.path) preparedSourcePath = request.path;
                if (request.operation === "Set-VM" && request.notes) createdVmNotes = request.notes;
                if (request.operation === "New-VM") {
                    typedVmCreateCalls += 1;
                    vmName = request.name || "";
                    createdVmNotes = request.notes || "";
                    vmExists = true;
                }
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const invoke = (params: Record<string, unknown>) => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ method: "broker.command.invoke", params }),
        });
        let activeIncarnationId: string | undefined;
        const invokeTool = (tool: string, params: Record<string, unknown>) => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ method: "broker.device.tool.invoke", params: { tool, backend: "windows-vm", deviceId, ...(activeIncarnationId ? { incarnationId: activeIncarnationId } : {}), ...params } }),
        });
        try {
            const created = await invoke({ backend: "windows-vm", command: "device_create", deviceId, name: "Windows VM E2E", profile: "windows-11", sourceImage: sourceImagePath, memoryMb: 4096, cpus: 2 });
            const createdBody = await created.json();
            expect(created.status, JSON.stringify(createdBody)).toBe(200);
            expect(existsSync(staleMarkerPath)).toBe(false);
            expect(createdBody).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: deviceId, backend: "windows-vm", provider: "hyper-v", vmId, vmName, status: "stopped", guestProvisioned: true, guestUsername: `ccc${ownerId.slice(0, 8)}`, switchName: "CCC Device Lab", networkAddress: expect.stringMatching(/^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/), macAddress: expect.stringMatching(/^02(?::[a-f0-9]{2}){5}$/), outboundPolicy: "nat" }),
                }),
            }));
            expect(createdBody.result.device).not.toHaveProperty("diskPath");
            expect(createdBody.result.device).not.toHaveProperty("deviceRoot");
            expect(JSON.stringify(createdBody)).not.toContain("Ccc!7");
            const incarnationId = createdBody.result.device.incarnationId as string;
            activeIncarnationId = incarnationId;
            expect(incarnationId).toMatch(/^[a-f0-9]{32}$/);
            expect(JSON.parse(readFileSync(join(imageProfileRoot, "manifest.json"), "utf8"))).toEqual(expect.objectContaining({
                version: 3,
                profile: "windows-11",
                catalogId: "user-provided-vhdx",
                imagePath,
                sha256: imageSha256,
                sizeBytes: 9,
                virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            }));
            expect(preparedSourcePath).toMatch(new RegExp(`^${imageProfileRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]\\.source-[a-f0-9]{24}\\.vhdx$`));
            expect(preparedSourcePath).not.toBe(sourceImagePath);
            expect(existsSync(preparedSourcePath)).toBe(false);
            expect(typedVmCreateCalls).toBe(1);
            expect(typedVhdPaths[0]).toBe(preparedSourcePath);
            expect(typedVhdPaths).toContain(imagePath);
            expect(typedVhdPaths).toContain(diskPath);
            expect(readFileSync(diskPath, "utf8")).toBe("fake-vhdx");
            expect(readFileSync(imagePath, "utf8")).toBe("fake-vhdx");
            expect(commandRunner.mock.calls.some(([command]) => providerScript(command).includes("New-VM @VmArgs"))).toBe(false);
            expect(commandRunner.mock.calls.some(([command]) => providerScript(command).includes("$Vhd = Get-VHD -Path $VhdPath"))).toBe(false);
            const callsAfterCreate = commandRunner.mock.calls.length;
            const duplicateCreate = await invoke({ backend: "windows-vm", command: "device_create", deviceId, name: "Windows VM E2E", profile: "windows-11", memoryMb: 4096, cpus: 2 });
            expect(duplicateCreate.status, JSON.stringify(await duplicateCreate.clone().json())).toBe(200);
            expect(await duplicateCreate.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ idempotent: true, invoked: false, device: expect.objectContaining({ id: deviceId, incarnationId }) }) }));
            expect(commandRunner).toHaveBeenCalledTimes(callsAfterCreate);
            const conflictingCreate = await invoke({ backend: "windows-vm", command: "device_create", deviceId, name: "Windows VM E2E", profile: "windows-11", memoryMb: 8192, cpus: 2 });
            expect(conflictingCreate.status).toBe(409);
            expect(await conflictingCreate.json()).toEqual(expect.objectContaining({ error: "hyper-v-create-configuration-conflict", conflicts: ["memoryMb"] }));
            expect(commandRunner).toHaveBeenCalledTimes(callsAfterCreate);

            const missingIncarnation = await invoke({ backend: "windows-vm", command: "device_start", deviceId });
            expect(missingIncarnation.status).toBe(409);
            expect(await missingIncarnation.json()).toEqual(expect.objectContaining({ error: "hyper-v-incarnation-required" }));
            const staleIncarnation = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId: "f".repeat(32) });
            expect(staleIncarnation.status).toBe(409);
            expect(await staleIncarnation.json()).toEqual(expect.objectContaining({ error: "hyper-v-incarnation-conflict" }));
            expect(commandRunner).toHaveBeenCalledTimes(callsAfterCreate);

            const started = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId });
            expect(started.status, JSON.stringify(await started.clone().json())).toBe(200);
            expect(await started.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ status: "running", runtimeState: "Running", bootReady: true }), boot: expect.objectContaining({ ready: true, provider: "hyper-v-powershell-direct" }) }) }));

            // A readiness refusal for an un-scrubbed reason must not leave the guest Running: it
            // still holds a live autologon password and the plaintext answer file. Containment is
            // scoped to exactly these reasons, so the assertion pairs with the timeout case below.
            // waitForBoot:false skipped readiness entirely, and readiness is the ONLY place the
            // provisioning media is removed and the only place containment runs. So this returned
            // 200 success with the guest Running and CCC_UNATTEND still mounted — a DVD carrying
            // the local Administrator password as PlainText — with no failure and nothing reporting
            // it. Rejected now, and no provider call may be made before the rejection.
            const callsBeforeUnsafeWindowsStart = commandRunner.mock.calls.length;
            const unsafeWindowsStart = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, waitForBoot: false });
            expect(unsafeWindowsStart.status).toBe(400);
            expect(await unsafeWindowsStart.json()).toEqual(expect.objectContaining({
                error: "windows-vm-bootstrap-requires-boot-wait",
                // A bare code tells a caller that set waitForBoot:false to skip a slow boot nothing
                // about what to do instead.
                detail: expect.stringContaining("bootTimeoutMs"),
            }));
            const unsafeWindowsReboot = await invoke({ backend: "windows-vm", command: "device_reboot", deviceId, incarnationId, waitForBoot: false });
            expect(unsafeWindowsReboot.status).toBe(400);
            expect(commandRunner).toHaveBeenCalledTimes(callsBeforeUnsafeWindowsStart);

            // Containment must request an immediate turn-off, even when guest shutdown hangs.
            const containmentStops = () => commandRunner.mock.calls
                .map((call) => nativeLibraryRequest(call[0]))
                .filter((request) => request?.operation === "Stop-VM" && request.mode === "turn-off" && request.force === true);
            const readinessProbeCount = (from: number) => commandRunner.mock.calls.slice(from)
                .filter(([command]) => {
                    const request = nativeLibraryRequest(command);
                    return request?.operation === "Invoke-Guest" && request.action === "job";
                }).length;
            for (const scrubReason of ["hyper-v-guest-first-logon-incomplete", "hyper-v-guest-provisioning-not-scrubbed"] as const) {
                guestReadyScrubFailure = scrubReason;
                const stopsBefore = containmentStops().length;
                const refused = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 });
                const refusedBody = await refused.json();
                expect(JSON.stringify(refusedBody)).toContain(scrubReason);
                expect(vmState, `expected containment to power off the guest for ${scrubReason}`).toBe("Off");
                expect(containmentStops().length, `expected a -TurnOff stop for ${scrubReason}`).toBeGreaterThan(stopsBefore);
                // The boot diagnostic must be captured BEFORE containment. Taken after, every
                // contained case records a post-mortem of a machine we just killed — the exact
                // diagnosability this narrow scope was chosen to preserve. Nothing else in this
                // test can tell the two orderings apart: moving containment back above the
                // diagnostic leaves every other assertion green.
                // Read off the refusal itself, not a follow-up device_status: the fixture flips
                // vmState back to "Running" for any script mentioning Start-VM, and the reconcile
                // script does — the same loose-substring trap as the Stop-VM one above.
                //
                // The pair IS the proof of ordering: the recorded diagnostic saw Running, and
                // containment then drove runtimeState to Off. Move the containment block back above
                // the diagnostic and the recorded state becomes "Off", failing here.
                const refusedDevice = refusedBody?.result?.device;
                expect(refusedDevice?.lastBootCheck?.diagnostic?.state, "diagnostic must predate containment").toBe("Running");
                expect(refusedDevice?.runtimeState, "containment must drive the recorded state Off").toBe("Off");
            }

            // First-boot containment. The two reasons above both require the PowerShell Direct probe
            // to have landed; when it never lands — a stalled OOBE, the most likely way a fresh VM's
            // first start fails — the reason is a transport code and the guest is in its DEFAULT
            // un-scrubbed state. The host cannot ask the guest, but the provisioning ISO still being
            // on disk is durable proof no readiness ever completed, and the ISO is itself the
            // plaintext residue. So a transport failure with the media retained must contain.
            mkdirSync(dirname(provisioningMediaPath), { recursive: true });
            writeFileSync(provisioningMediaPath, "unattend-iso-bytes");
            guestReadyScrubFailure = "powershell-direct-attempt-timeout";
            const firstBootStops = containmentStops().length;
            const neverProbed = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 });
            const neverProbedBody = await neverProbed.json() as Record<string, any>;
            expect(JSON.stringify(neverProbedBody)).toContain("powershell-direct-attempt-timeout");
            expect(containmentStops().length, "media still on disk means never scrubbed: contain").toBeGreaterThan(firstBootStops);
            expect(vmState).toBe("Off");
            // A failed start that force-stopped the guest DID change the host. Derived from
            // `success` alone this reported false — the envelope telling the caller nothing
            // happened, on the one path whose whole purpose was to make something happen.
            expect(neverProbedBody?.result?.execution?.mutatesHost, "containment mutated the host and must say so").toBe(true);

            // The same first-boot arm reached by a command that never returned rather than a reason
            // that was thrown. This is the dangerous inverse of the debuggable case further down: a
            // timed-out command emits no JSON, so there is no scrub observation to parse, so
            // $ScrubConfirmed is false — and with the ISO still on disk this guest is holding a
            // plaintext Administrator password. It must be contained. Nothing pinned it: the gate
            // makes it structural, but "structural" is what the four other retractions in this
            // series also looked like before they were measured.
            guestReadyScrubFailure = false;
            guestReadyCommandTimedOut = true;
            const timedOutRetainedStops = containmentStops().length;
            // Count the stable non-probe provider work here. Deadline scheduling can permit
            // one more read-only guest probe without changing containment behavior.
            const timedOutRetainedCalls = commandRunner.mock.calls.length;
            const timedOutRetained = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 });
            const timedOutRetainedBody = await timedOutRetained.json() as Record<string, any>;
            expect(JSON.stringify(timedOutRetainedBody)).toContain("powershell-direct-timeout");
            expect(containmentStops().length, "a timed-out probe with media retained must be contained").toBeGreaterThan(timedOutRetainedStops);
            expect(vmState, "a timed-out probe holding its ISO must be powered off").toBe("Off");
            // Same reason the sibling case above asserts it: a containment that force-stopped the
            // guest changed the host, and an envelope saying otherwise is wrong on the one path
            // whose purpose was to make something happen.
            expect(timedOutRetainedBody?.result?.execution?.mutatesHost, "containment mutated the host and must say so").toBe(true);
            expect(commandRunner.mock.calls.length - timedOutRetainedCalls - readinessProbeCount(timedOutRetainedCalls),
                "a contained device_start costs 13 non-probe provider commands").toBe(13);
            guestReadyCommandTimedOut = false;
            guestReadyScrubFailure = false;

            // A directory at the ISO path makes host cleanup fail after the guest scrub and
            // DVD detach have both been observed. The retained path must not cause containment.
            rmSync(provisioningMediaPath, { force: true });
            mkdirSync(provisioningMediaPath);
            guestReadyScrubFailureScrubbed = true;
            guestReadyScrubFailureDetached = true;
            const scrubbedRetainedStops = containmentStops().length;
            const scrubbedRetainedDetachCalls = commandRunner.mock.calls.filter(([command]) => nativeLibraryRequest(command)?.operation === "Remove-VMDvdDrive").length;
            const mediaCleanupFailed = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 18000 });
            const mediaCleanupBody = await mediaCleanupFailed.json() as { detail?: string };
            expect(["hyper-v-guest-provisioning-media-delete-failed", "hyper-v-guest-ready-deadline-exceeded"]).toContain(mediaCleanupBody.detail);
            expect(commandRunner.mock.calls.filter(([command]) => nativeLibraryRequest(command)?.operation === "Remove-VMDvdDrive").length)
                .toBeGreaterThan(scrubbedRetainedDetachCalls);
            expect(lstatSync(provisioningMediaPath).isDirectory()).toBe(true);
            expect(containmentStops().length, "a scrubbed guest must not be contained for a failed media cleanup").toBe(scrubbedRetainedStops);
            expect(vmState, "a scrubbed guest stays debuggable even with its media retained").toBe("Running");
            rmSync(provisioningMediaPath, { recursive: true, force: true });
            writeFileSync(provisioningMediaPath, "unattend-iso-bytes");
            // Scrubbed, but the DVD is STILL ATTACHED — an ambiguous attachment or a failed
            // Remove-VMDvdDrive, both of which throw after the scrub latch and before the detach
            // one. The guest is clean in registry and Panther, yet D:\Autounattend.xml is mounted
            // and readable by anything inside it, carrying the local Administrator password in
            // plaintext; the scrub does not remove that account. Vetoing on scrubConfirmed alone
            // stood containment down here, which is why the veto needs both flags.
            guestReadyScrubFailureDetached = false;
            const mountedIsoStops = containmentStops().length;
            const stillMounted = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 18000 });
            expect(JSON.stringify(await stillMounted.json())).toContain("hyper-v-guest-provisioning-media-detach-failed");
            expect(containmentStops().length, "a mounted answer-file ISO must still be contained").toBeGreaterThan(mountedIsoStops);
            expect(vmState).toBe("Off");

            guestReadyScrubFailureScrubbed = false;
            guestReadyScrubFailureDetached = false;

            // The skip-guard is an exact list, not "anything that is not Running". Hyper-V reports
            // 27 states; Paused, Saved, Starting and Stopping are all guests still holding a
            // mounted answer file, and hyperVStopCommand's own `-ne 'Off'` test would stop them.
            // Loosening the guard to `!== "Running"` would skip containment for every one of them
            // and leave a live DefaultPassword un-contained and unreported.
            for (const liveState of ["Paused", "Saved", "Starting", "Stopping"] as const) {
                diagnosticStateOverride = liveState;
                guestReadyScrubFailure = "hyper-v-guest-provisioning-not-scrubbed";
                const liveStops = containmentStops().length;
                await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 });
                expect(containmentStops().length, `${liveState} is not Off and must still be contained`).toBeGreaterThan(liveStops);
            }
            // And a genuinely powered-off guest is not "contained" by a stop that does nothing.
            // OffCritical counts as off too — missing it would produce the same phantom stop.
            for (const offState of ["Off", "OffCritical"] as const) {
                diagnosticStateOverride = offState;
                guestReadyScrubFailure = "hyper-v-guest-provisioning-not-scrubbed";
                const offStops = containmentStops().length;
                await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 });
                expect(containmentStops().length, `${offState} means there is nothing to contain`).toBe(offStops);
            }
            diagnosticStateOverride = "";
            guestReadyScrubFailure = false;
            await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId });

            // Readiness never runs: the identity gate rejects the start observation, one of the two
            // exits between Start-VM and readiness. The guest is Running with the media still on
            // disk, so containment fires — and when the stop ALSO fails, that has to be reported.
            // It previously was not: both surfaces for scrubContainmentFailed hung off the
            // readiness execution, which is null here, so a failed containment on this exact path
            // reached neither the reply nor device_status. Guest up, ISO mounted, total silence.
            // A dangling ISO symlink still occupies the computed path. statSync would report
            // ENOENT and silently skip both diagnosis and required containment.
            if (process.platform === "win32") writeFileSync(provisioningMediaPath, "unattend-iso-bytes");
            else symlinkSync(join(dirname(provisioningMediaPath), "missing-answer.iso"), provisioningMediaPath);
            startObservationMismatch = true;
            startObservationGetVmCount = 0;
            containmentStopFailure = true;
            const silentPath = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 });
            const silentBody = JSON.stringify(await silentPath.json());
            expect(silentBody, "a failed containment must never be silent").toContain("scrubContainmentFailed");
            // Asserted on the PERSISTED record too, not just the reply. `toContain` over the whole
            // body is satisfied by the boot.errorDetail copy alone — the same weakness this file
            // already documents 40 lines down — so moving the synthesis below the persistence write
            // would make the record vanish here and still pass. The record is the surface that
            // outlives the reply, and the reply is exactly what gets lost to a caller timeout.
            const silentRecord = JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as { devices: Array<Record<string, any>> };
            expect(silentRecord.devices[0]?.lastBootCheck?.scrubContainmentFailed, "device_status must see the failed containment").toBe(true);
            // The reply half, separately. The record write reads the flag directly, so a body-wide
            // toContain — and even the record assertion above — is satisfied without the reply ever
            // carrying it. Reverting the detail builder to patch only a detail that already exists
            // leaves errorDetail absent on this path, where none exists yet, and that mutant
            // survived both of the assertions above.
            const silentReply = JSON.parse(silentBody) as Record<string, any>;
            expect(silentReply?.result?.device?.lastBootCheck?.diagnostic?.state,
                "pre-readiness containment must record a diagnostic before stopping").toBe("Running");
            expect(silentReply?.result?.boot?.errorDetail?.scrubContainmentFailed, "the reply must carry it too").toBe(true);
            rmSync(provisioningMediaPath, { force: true });
            containmentStopFailure = false;
            startObservationMismatch = false;
            await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId });

            rmSync(provisioningMediaPath, { force: true });

            // The other half of the decision: an ordinary readiness timeout leaves the VM Running
            // on purpose, because powering it off destroys the state needed to diagnose it. Without
            // this, "contain every failure" would satisfy the loop above just as well.
            // All four script-thrown probe-never-returned reasons, not just one. The doc claims
            // this set is pinned by test; listing some of them in prose while asserting only one is
            // the kind of claim this series has already had to retract more than once. These four
            // share a code path — the script's structured failure JSON — so looping is a one-line
            // cost. The fifth reason does not share it, and gets its own case below.
            for (const unknownReason of [
                "powershell-direct-attempt-timeout",
                "powershell-direct-authentication-failed",
                "powershell-direct-session-unavailable",
                "powershell-direct-unavailable",
            ] as const) {
                guestReadyScrubFailure = unknownReason;
                const stopsBeforeTimeout = containmentStops().length;
                const timedOut = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 });
                expect(JSON.stringify(await timedOut.json())).toContain(unknownReason);
                expect(vmState, `${unknownReason} must stay debuggable, not be powered off`).toBe("Running");
                expect(containmentStops().length, `no containment stop for ${unknownReason}`).toBe(stopsBeforeTimeout);
            }
            // The fifth, reached the only way it can be: the readiness command times out with no
            // output. It belongs to the same class as the four above — the probe never landed, so
            // the reason proves nothing — and must be treated the same way. It was missing from
            // both this file and the doc while sitting in the reader-facing projection allowlist,
            // which is how a reason ends up unreviewed on either side of the boundary.
            guestReadyScrubFailure = false;
            guestReadyCommandTimedOut = true;
            const stopsBeforeCommandTimeout = containmentStops().length;
            // The uncontained half omits the containment transaction.
            const commandTimedOutCalls = commandRunner.mock.calls.length;
            const commandTimedOut = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 });
            expect(JSON.stringify(await commandTimedOut.json())).toContain("powershell-direct-timeout");
            expect(vmState, "powershell-direct-timeout must stay debuggable, not be powered off").toBe("Running");
            expect(containmentStops().length, "no containment stop for powershell-direct-timeout").toBe(stopsBeforeCommandTimeout);
            expect(commandRunner.mock.calls.length - commandTimedOutCalls - readinessProbeCount(commandTimedOutCalls),
                "an uncontained device_start costs 6 non-probe provider commands").toBe(6);
            guestReadyCommandTimedOut = false;
            // A containment that could not power the guest off must say so. This flag is the only
            // signal that a guest is still live with a hot credential, so silence here would be the
            // same class of invisible failure the whole series exists to remove. The readiness
            // reason must survive too — replacing it would discard the diagnostic that selected
            // the containment path in the first place.
            guestReadyScrubFailure = "hyper-v-guest-provisioning-not-scrubbed";
            containmentStopFailure = true;
            const containmentFailed = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 });
            const containmentFailedBody = await containmentFailed.json();
            // Asserted on the two writers SEPARATELY. A `toContain("scrubContainmentFailed")` over
            // the whole stringified response is satisfied by errorDetail alone, so deleting the
            // lastBootCheck persistence — the headline fix here — left the suite green. The
            // persisted copy is the one that survives a dropped reply, which is the entire point:
            // the caller's RPC can time out while containment is still running.
            expect(containmentFailedBody?.result?.boot?.errorDetail?.scrubContainmentFailed).toBe(true);
            // And on DISK, which is the actual claim: the reply can be dropped when the caller's
            // RPC times out while containment is still running, so the persisted record is what an
            // operator reads afterwards. Asserting `toContain("scrubContainmentFailed")` over the
            // whole response was satisfied by errorDetail alone, so deleting the persistence — the
            // headline fix of this commit — left the suite green.
            const persisted = JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as {
                devices: Array<{ id?: string; lastBootCheck?: { error?: string; scrubContainmentFailed?: boolean } }>;
            };
            const persistedDevice = persisted.devices.find((entry) => entry.id === deviceId);
            expect(persistedDevice?.lastBootCheck?.scrubContainmentFailed).toBe(true);
            expect(persistedDevice?.lastBootCheck?.error).toBe("hyper-v-guest-provisioning-not-scrubbed");
            expect(vmState).toBe("Running");
            containmentStopFailure = false;

            // And it is absent, not `false`, when containment worked — its presence always means
            // something needs attention.
            const containmentOk = await (await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId, bootTimeoutMs: 1000 })).json();
            expect(JSON.stringify(containmentOk)).not.toContain("scrubContainmentFailed");
            const persistedOk = JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as {
                devices: Array<{ id?: string; lastBootCheck?: { scrubContainmentFailed?: boolean } }>;
            };
            expect(persistedOk.devices.find((entry) => entry.id === deviceId)?.lastBootCheck?.scrubContainmentFailed).toBeUndefined();
            expect(vmState).toBe("Off");

            guestReadyScrubFailure = false;
            await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId });

            const operationPath = join(deviceRoot, "operation.json");
            mkdirSync(dirname(diskPath), { recursive: true });
            writeFileSync(operationPath, JSON.stringify({ version: 1, operationId: snapshotId, ownerId, deviceId, incarnationId, command: "device_stop", vmId, vmName, diskPath, startedAt: new Date().toISOString() }));
            const callsBeforeStaleLifecycle = commandRunner.mock.calls.length;
            const staleLifecycleWithJournal = await invoke({ backend: "windows-vm", command: "device_start", deviceId, incarnationId: "f".repeat(32) });
            expect(staleLifecycleWithJournal.status).toBe(409);
            expect(await staleLifecycleWithJournal.json()).toEqual(expect.objectContaining({ error: "hyper-v-incarnation-conflict" }));
            expect(existsSync(operationPath)).toBe(true);
            expect(commandRunner).toHaveBeenCalledTimes(callsBeforeStaleLifecycle);
            const status = await invoke({ backend: "windows-vm", command: "device_status", deviceId });
            expect(status.status, JSON.stringify(await status.clone().json())).toBe(200);
            expect(await status.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ vmId, runtimeState: "Off" }) }) }));
            expect(commandRunner.mock.calls.slice(callsBeforeStaleLifecycle).some(([command]) => {
                if (!command.input) return false;
                try {
                    const request = nativeLibraryRequest(command);
                    return request?.operation === "Stop-VM"
                        && request.expectedName === vmName
                        && request.expectedNotes === createdVmNotes;
                } catch {
                    return false;
                }
            })).toBe(true);
            expect(existsSync(operationPath)).toBe(false);

            writeFileSync(operationPath, JSON.stringify({ version: 1, operationId: snapshotId, ownerId, deviceId, incarnationId, command: "device_start", vmId, vmName, diskPath, startedAt: new Date().toISOString() }));
            const callsBeforeStartReconciliation = commandRunner.mock.calls.length;
            const reconciledStart = await invoke({ backend: "windows-vm", command: "device_status", deviceId });
            expect(reconciledStart.status, JSON.stringify(await reconciledStart.clone().json())).toBe(200);
            expect(commandRunner.mock.calls.slice(callsBeforeStartReconciliation).some(([command]) => {
                const request = nativeLibraryRequest(command);
                return request?.operation === "Start-VM"
                    && request.expectedName === vmName
                    && request.expectedNotes === createdVmNotes;
            })).toBe(true);
            expect(existsSync(operationPath)).toBe(false);

            observedNativeDiskPath = null;
            writeFileSync(operationPath, JSON.stringify({ version: 1, operationId: snapshotId, ownerId, deviceId, incarnationId, command: "device_stop", vmId, vmName, diskPath, startedAt: new Date().toISOString() }));
            const zeroDiskResidue = await invoke({ backend: "windows-vm", command: "device_status", deviceId });
            expect(zeroDiskResidue.status, JSON.stringify(await zeroDiskResidue.clone().json())).toBe(200);
            expect(existsSync(operationPath)).toBe(false);

            observedNativeDiskPath = join(cwd, "foreign-attached.vhdx");
            writeFileSync(operationPath, JSON.stringify({ version: 1, operationId: snapshotId, ownerId, deviceId, incarnationId, command: "device_stop", vmId, vmName, diskPath, startedAt: new Date().toISOString() }));
            const foreignDiskResidue = await invoke({ backend: "windows-vm", command: "device_status", deviceId });
            expect(foreignDiskResidue.status).toBe(502);
            expect(await foreignDiskResidue.json()).toEqual(expect.objectContaining({ error: "hyper-v-state-reconciliation-invalid-result" }));
            expect(existsSync(operationPath)).toBe(true);
            rmSync(operationPath, { force: true });

            observedNativeDiskPath = null;
            observedPassThroughDiskNumber = 7;
            writeFileSync(operationPath, JSON.stringify({ version: 1, operationId: snapshotId, ownerId, deviceId, incarnationId, command: "device_delete", vmId, vmName, diskPath, startedAt: new Date().toISOString() }));
            const removeCallsBeforePassThroughConflict = commandRunner.mock.calls.filter(([command]) => {
                if (!command.input) return false;
                try {
                    return JSON.parse(command.input).operation === "Remove-VM";
                } catch {
                    return false;
                }
            }).length;
            const passThroughDiskResidue = await invoke({ backend: "windows-vm", command: "device_status", deviceId });
            expect(passThroughDiskResidue.status).toBe(502);
            expect(await passThroughDiskResidue.json()).toEqual(expect.objectContaining({ error: "hyper-v-delete-reconciliation-invalid-result" }));
            expect(existsSync(operationPath)).toBe(true);
            expect(commandRunner.mock.calls.filter(([command]) => {
                if (!command.input) return false;
                try {
                    return JSON.parse(command.input).operation === "Remove-VM";
                } catch {
                    return false;
                }
            })).toHaveLength(removeCallsBeforePassThroughConflict);
            rmSync(operationPath, { force: true });
            observedPassThroughDiskNumber = null;
            observedNativeDiskPath = diskPath;

            const guestExec = await invokeTool("device_exec", { command: "Write-Output guest-ok" });
            expect(guestExec.status, JSON.stringify(await guestExec.clone().json())).toBe(200);
            expect(await guestExec.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ provider: "hyper-v-powershell-direct", stdout: "guest-ok\r\n", status: 0 }) }));

            const beforeInvalidGesture = commandRunner.mock.calls.length;
            expect((await invokeTool("device_drag", {x1:0,y1:0,x2:10,y2:10,durationMs:0})).status).toBe(400);
            expect((await invokeTool("device_focus_window", {handle:"42;id"})).status).toBe(400);
            expect(commandRunner.mock.calls).toHaveLength(beforeInvalidGesture);
            const staleDrag = await invokeTool("device_drag", {x1:0,y1:0,x2:10,y2:10,incarnationId:"f".repeat(32)});
            expect(staleDrag.status).toBe(409);
            expect(await staleDrag.json()).toMatchObject({error:"hyper-v-incarnation-conflict"});
            const staleFocus = await invokeTool("device_focus_window", {handle:"42",incarnationId:"f".repeat(32)});
            expect(staleFocus.status).toBe(409);
            expect(await staleFocus.json()).toMatchObject({error:"hyper-v-incarnation-conflict"});
            const noFrameDrag = await invokeTool("device_drag", {x1:0,y1:0,x2:10,y2:10});
            expect(noFrameDrag.status).toBe(409);
            expect(await noFrameDrag.json()).toMatchObject({error:"hyper-v-console-screenshot-required"});
            const dragFrameKey = hyperVConsoleFrameKey(ownerId, "windows-vm", deviceId);
            rememberHyperVConsoleFrame(dragFrameKey, {incarnationId:activeIncarnationId!,width:640,height:480,nativeWidth:1280,nativeHeight:960,capturedAt:new Date().toISOString()});
            try {
                const beforeOffscreen = commandRunner.mock.calls.length;
                const offscreenDrag = await invokeTool("device_drag", {x1:0,y1:0,x2:640,y2:10});
                expect(offscreenDrag.status).toBe(400);
                expect(await offscreenDrag.json()).toMatchObject({error:"hyper-v-console-pixel-invalid"});
                expect(commandRunner.mock.calls).toHaveLength(beforeOffscreen);
                const dragResult = await invokeTool("device_drag", {x1:1,y1:2,x2:639,y2:479});
                expect(dragResult.status, JSON.stringify(await dragResult.clone().json())).toBe(200);
                expect(commandRunner.mock.calls.map(([command]) => nativeLibraryRequest(command)).filter(Boolean))
                    .toContainEqual(expect.objectContaining({operation:"Send-VMConsoleInput",action:"drag",x:1,y:2,x2:639,y2:479,durationMs:700,nativeWidth:1280,nativeHeight:960,expectedNotes:createdVmNotes}));
            } finally { forgetHyperVConsoleFrame(dragFrameKey); }
            const focused = await invokeTool("device_focus_window", {handle:"42"});
            expect(focused.status, JSON.stringify(await focused.clone().json())).toBe(200);
            expect(await focused.json()).toMatchObject({result:{tool:"device_focus_window",ok:true}});
            focusWindowOutput = '{"error":"window-focus-denied"}';
            const deniedFocus = await invokeTool("device_focus_window", {handle:"42"});
            expect(deniedFocus.status).toBe(502);
            expect(await deniedFocus.json()).toMatchObject({error:"window-focus-denied"});

            const windows = await invokeTool("device_window_list", {});
            expect(windows.status, JSON.stringify(await windows.clone().json())).toBe(200);
            expect(await windows.json()).toMatchObject({result:{tool:"device_window_list", windows:[{handle:"42",title:"Guest Notes",processId:123}]}});
            const beforeShortWindowList = commandRunner.mock.calls.length;
            expect((await invokeTool("device_window_list", {helperTimeoutMs:1000})).status).toBe(400);
            expect(commandRunner.mock.calls).toHaveLength(beforeShortWindowList);
            windowListOutput = '{"error":"window-list-session-changed"}';
            const changedSession = await invokeTool("device_window_list", {});
            expect(changedSession.status).toBe(502);
            expect(await changedSession.json()).toMatchObject({error:"window-list-session-changed"});
            windowListOutput = 'invalid';
            expect((await invokeTool("device_window_list", {})).status).toBe(502);
            windowListOutput = '{"windows":[]}';
            expect(await (await invokeTool("device_window_list", {})).json()).toMatchObject({result:{windows:[]}});

            guestExecExitCode = 7;
            const failedGuestExec = await invokeTool("device_exec", { command: "exit 7" });
            expect(failedGuestExec.status).toBe(422);
            expect(await failedGuestExec.json()).toEqual(expect.objectContaining({
                error: "hyper-v-guest-command-failed",
                result: expect.objectContaining({ status: 7, stderr: "guest-failed" }),
            }));
            guestExecExitCode = 0;

            const callsBeforeUpload = commandRunner.mock.calls.length;
            const uploaded = await invokeTool("device_upload", { localPath: uploadPath, remotePath: "C:\\ccc\\upload.txt" });
            expect(uploaded.status).toBe(200);
            expect(await uploaded.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ provider: "hyper-v-powershell-direct", bytes: 6 }) }));
            expect(commandRunner.mock.calls.slice(callsBeforeUpload).map(([command]) => nativeLibraryRequest(command)?.action)).toEqual(["mkdir", "upload"]);

            const largeUploadPath = join(cwd, "packaged-node.exe");
            writeFileSync(largeUploadPath, Buffer.alloc(16 * 1024 * 1024 + 1));
            const largeUpload = await invokeTool("device_upload", { localPath: largeUploadPath, remotePath: "C:\\ccc\\node.exe", maxFileBytes: 128 * 1024 * 1024 });
            expect(largeUpload.status, JSON.stringify(await largeUpload.clone().json())).toBe(200);

            const downloaded = await invokeTool("device_download", { remotePath: "C:\\ccc\\download.txt", localPath: downloadPath });
            expect(downloaded.status).toBe(200);
            expect(await downloaded.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ provider: "hyper-v-powershell-direct", remotePath: "C:\\ccc\\download.txt" }) }));

            guestDownloadReportedBytes = 7;
            const rejectedDownloadPath = join(cwd, "download-mismatch.txt");
            const mismatchedDownload = await invokeTool("device_download", { remotePath: "C:\\ccc\\download.txt", localPath: rejectedDownloadPath });
            expect(mismatchedDownload.status).toBe(502);
            expect(await mismatchedDownload.json()).toEqual(expect.objectContaining({ error: "hyper-v-guest-download-invalid-artifact" }));
            expect(existsSync(rejectedDownloadPath)).toBe(false);
            guestDownloadReportedBytes = 6;

            guestDownloadLostResponse = true;
            const lostDownloadPath = join(cwd, "download-lost.txt");
            const callsBeforeLostDownload = commandRunner.mock.calls.length;
            const lostDownload = await invokeTool("device_download", { remotePath: "C:\\ccc\\download.txt", localPath: lostDownloadPath });
            expect(lostDownload.status).toBe(502);
            const lostBody = await lostDownload.json();
            expect(lostBody).toEqual(expect.objectContaining({ error: "hyper-v-guest-provider-failed" }));
            expect(JSON.stringify(lostBody)).not.toContain(credentialPath);
            expect(existsSync(lostDownloadPath)).toBe(false);
            expect(readdirSync(join(privateRoot, "downloads"))).toEqual([]);
            expect(commandRunner.mock.calls.slice(callsBeforeLostDownload).map(([command]) => nativeLibraryRequest(command)?.action)).toEqual(["download"]);
            guestDownloadLostResponse = false;

            const stopped = await invoke({ backend: "windows-vm", command: "device_stop", deviceId, incarnationId });
            expect(stopped.status).toBe(200);
            expect(await stopped.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ status: "stopped", runtimeState: "Off" }) }) }));

            checkpointPolicy = "Disabled";
            const quarantinedSnapshot = await invokeTool("device_snapshot_create", { snapshotName: "quarantined" });
            expect(quarantinedSnapshot.status).toBe(409);
            expect(await quarantinedSnapshot.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-policy-invalid" }));
            expect(existsSync(join(deviceRoot, "snapshot-operation.json"))).toBe(false);
            checkpointPolicy = "ProductionOnly";
            const snapshotCreated = await invokeTool("device_snapshot_create", { snapshotName: "before-install" });
            expect(snapshotCreated.status).toBe(200);
            const snapshotCreatedBody = await snapshotCreated.json();
            expect(snapshotCreatedBody).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    snapshot: expect.objectContaining({
                        id: snapshotId,
                        name: "before-install",
                        providerName: `ccc-${ownerId}-before-install`,
                    }),
                    execution: expect.objectContaining({
                        provider: "hyper-v",
                        outputRedacted: true,
                    }),
                }),
            }));
            expect(JSON.stringify(snapshotCreatedBody)).not.toContain(
                "snapshot-provider-host-secret",
            );

            snapshotRestoreProviderFailure = true;
            const failedRestore = await invokeTool("device_snapshot_restore", { snapshotId, confirmDestructive: true });
            const failedRestoreBody = await failedRestore.json();
            expect(failedRestore.status, JSON.stringify(failedRestoreBody)).toBe(409);
            expect(failedRestoreBody).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-restore-outcome-indeterminate" }));
            expect((JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as { devices: Array<{ activeSnapshotId?: string | null }> }).devices[0].activeSnapshotId ?? null).toBeNull();
            expect(existsSync(join(deviceRoot, "snapshot-operation.json"))).toBe(true);
            const retriedRestore = await invokeTool("device_snapshot_restore", { snapshotId, confirmDestructive: true });
            expect(retriedRestore.status).toBe(200);
            expect(await retriedRestore.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ activeSnapshotId: snapshotId }) }) }));
            expect(restoreRetryJournalObserved).toBe(true);

            snapshotProviderFailure = true;
            const failedSnapshot = await invokeTool("device_snapshot_create", { snapshotName: "provider-failure" });
            const failedSnapshotBody = await failedSnapshot.json();
            expect(failedSnapshot.status, JSON.stringify(failedSnapshotBody)).toBe(409);
            expect(failedSnapshotBody).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-create-outcome-indeterminate" }));
            snapshotProviderFailure = false;
            // The mock's protocol failure cannot prove the mutation never ran. Reset its
            // synthetic journal before the next independent ownership-mismatch case.
            expect(existsSync(join(deviceRoot, "snapshot-operation.json"))).toBe(true);
            rmSync(join(deviceRoot, "snapshot-operation.json"), { force: true });

            // A provider that reports success but hands back a checkpoint that is not the
            // owner-scoped one is not a provider failure — the mutation ran and its own report is
            // what cannot be trusted. The legacy path caught this by re-reading the observation
            // after success, answered 502 hyper-v-snapshot-invalid-result, and deliberately stayed
            // off journal reconciliation because there is no drift to repair.
            snapshotOwnershipMismatch = true;
            const callsBeforeOwnershipMismatch = commandRunner.mock.calls.length;
            const mismatchedSnapshot = await invokeTool("device_snapshot_create", { snapshotName: "ownership-mismatch" });
            expect(mismatchedSnapshot.status).toBe(502);
            expect(await mismatchedSnapshot.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-invalid-result" }));
            expect(commandRunner.mock.calls.slice(callsBeforeOwnershipMismatch)
                .some(([issued]) => nativeLibraryRequest(issued)?.operation === "Repair-VMSnapshotState")).toBe(false);
            expect((JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as { devices: Array<{ snapshots: unknown[] }> }).devices[0].snapshots).toHaveLength(1);
            snapshotOwnershipMismatch = false;
            rmSync(join(deviceRoot, "snapshot-operation.json"), { force: true });

            // Building the legacy provider command rejected bad options before anything ran and
            // answered 400. The typed client rejects the same corrupted device metadata as a
            // validation error, still before the first round trip, so it must stay a request error
            // rather than become a provider failure that drags reconciliation in behind it.
            const devicesPath = join(backendRoot(ownerId, "windows-vm"), "devices.json");
            const validDevicesState = readFileSync(devicesPath);
            const corrupted = JSON.parse(validDevicesState.toString("utf8")) as { devices: Array<{ vmId: string }> };
            corrupted.devices[0]!.vmId = "not-a-guid";
            writeFileSync(devicesPath, JSON.stringify(corrupted));
            const callsBeforeInvalidOptions = commandRunner.mock.calls.length;
            const invalidOptions = await invokeTool("device_snapshot_delete", { snapshotName: "before-install", confirmDestructive: true });
            expect(invalidOptions.status).toBe(400);
            expect(await invalidOptions.json()).toEqual(expect.objectContaining({ error: "invalid-hyper-v-snapshot-options" }));
            expect(commandRunner).toHaveBeenCalledTimes(callsBeforeInvalidOptions);
            writeFileSync(devicesPath, validDevicesState);

            const snapshotOperationPath = join(deviceRoot, "snapshot-operation.json");
            // Nothing here removes the journal the rejected call wrote — the 400 branch clears it
            // itself, because the request never reached the provider and left nothing to reconcile.
            expect(existsSync(snapshotOperationPath)).toBe(false);
            writeFileSync(snapshotOperationPath, JSON.stringify({ version: 1, operationId: vmId, ownerId, deviceId, incarnationId, tool: "device_snapshot_create", snapshotName: "before-install", providerName: `ccc-${ownerId}-before-install`, startedAt: new Date().toISOString() }));
            const callsBeforeDryRunCreate = commandRunner.mock.calls.length;
            const dryRunCreateWithJournal = await invoke({ backend: "windows-vm", command: "device_create", deviceId, name: "Windows VM E2E", profile: "windows-11", memoryMb: 4096, cpus: 2, dryRun: true });
            expect(dryRunCreateWithJournal.status).toBe(200);
            expect(existsSync(snapshotOperationPath)).toBe(true);
            expect(commandRunner).toHaveBeenCalledTimes(callsBeforeDryRunCreate);
            const callsBeforeStaleSnapshot = commandRunner.mock.calls.length;
            const staleSnapshotWithJournal = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.device.tool.invoke", params: { tool: "device_snapshot_restore", backend: "windows-vm", deviceId, incarnationId: "f".repeat(32), snapshotId, confirmDestructive: true } }),
            });
            expect(staleSnapshotWithJournal.status).toBe(409);
            expect(await staleSnapshotWithJournal.json()).toEqual(expect.objectContaining({ error: "hyper-v-incarnation-conflict" }));
            expect(existsSync(snapshotOperationPath)).toBe(true);
            expect(commandRunner).toHaveBeenCalledTimes(callsBeforeStaleSnapshot);
            const createAfterInterruptedSnapshot = await invoke({ backend: "windows-vm", command: "device_create", deviceId, name: "Windows VM E2E", profile: "windows-11", memoryMb: 4096, cpus: 2 });
            expect(createAfterInterruptedSnapshot.status).toBe(200);
            expect(existsSync(snapshotOperationPath)).toBe(false);
            writeFileSync(snapshotOperationPath, JSON.stringify({ version: 1, operationId: vmId, ownerId, deviceId, incarnationId, tool: "device_snapshot_create", snapshotName: "before-install", providerName: `ccc-${ownerId}-before-install`, startedAt: new Date().toISOString() }));
            for (const failure of ["invalid", "timeout"] as const) {
                snapshotRepairResult = failure;
                const repairsBefore = commandRunner.mock.calls.filter(([command]) => nativeLibraryRequest(command)?.operation === "Repair-VMSnapshotState").length;
                const refusedStatus = await invoke({ backend: "windows-vm", command: "device_status", deviceId, incarnationId });
                expect(refusedStatus.status).toBe(502);
                expect(await refusedStatus.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-reconciliation-failed" }));
                expect(existsSync(snapshotOperationPath)).toBe(true);
                expect(commandRunner.mock.calls.filter(([command]) => nativeLibraryRequest(command)?.operation === "Repair-VMSnapshotState")).toHaveLength(repairsBefore + 1);
            }
            snapshotRepairResult = "normal";
            snapshotRepairResult = "count-mismatch";
            const contradictoryStatus = await invoke({ backend: "windows-vm", command: "device_status", deviceId, incarnationId });
            expect(contradictoryStatus.status).toBe(502);
            expect(await contradictoryStatus.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-reconciliation-invalid-result" }));
            expect(existsSync(snapshotOperationPath)).toBe(true);
            snapshotRepairResult = "normal";
            observedSnapshotName = `CCC-${ownerId}-BEFORE-INSTALL`;
            const differentlyCasedSnapshot = await invoke({ backend: "windows-vm", command: "device_status", deviceId, incarnationId });
            expect(differentlyCasedSnapshot.status).toBe(409);
            expect(await differentlyCasedSnapshot.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-reconciliation-metadata-invalid" }));
            expect(existsSync(snapshotOperationPath)).toBe(true);
            observedSnapshotName = null;
            const statusAfterInterruptedSnapshot = await invoke({ backend: "windows-vm", command: "device_status", deviceId, incarnationId });
            expect(statusAfterInterruptedSnapshot.status).toBe(200);
            expect(existsSync(snapshotOperationPath)).toBe(false);
            const unconfirmedRestore = await invokeTool("device_snapshot_restore", { snapshotId });
            expect(unconfirmedRestore.status).toBe(400);
            expect(await unconfirmedRestore.json()).toEqual(expect.objectContaining({ error: "destructive-confirmation-required", confirmationField: "confirmDestructive" }));
            const snapshotRestored = await invokeTool("device_snapshot_restore", { snapshotId, confirmDestructive: true });
            expect(snapshotRestored.status).toBe(200);
            expect(await snapshotRestored.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ activeSnapshotId: snapshotId, status: "stopped" }) }) }));
            expect(existsSync(snapshotOperationPath)).toBe(false);

            const unconfirmedDelete = await invokeTool("device_snapshot_delete", { snapshotName: "before-install", confirmDestructive: false });
            expect(unconfirmedDelete.status).toBe(400);
            expect(await unconfirmedDelete.json()).toEqual(expect.objectContaining({ error: "destructive-confirmation-required", confirmationField: "confirmDestructive" }));
            snapshotDeleteConfirmationFailure = true;
            const providerUnconfirmedSnapshotDelete = await invokeTool("device_snapshot_delete", { snapshotName: "before-install", confirmDestructive: true });
            expect(providerUnconfirmedSnapshotDelete.status).toBe(502);
            expect(await providerUnconfirmedSnapshotDelete.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-invalid-result" }));
            expect(existsSync(snapshotOperationPath)).toBe(true);
            expect((JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as { devices: Array<{ snapshots: unknown[] }> }).devices[0].snapshots).toHaveLength(1);
            snapshotDeleteConfirmationFailure = false;
            observedSnapshotId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
            const replacementSnapshotStatus = await invoke({ backend: "windows-vm", command: "device_status", deviceId, incarnationId });
            expect(replacementSnapshotStatus.status).toBe(409);
            expect(await replacementSnapshotStatus.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-reconciliation-metadata-invalid" }));
            expect(existsSync(snapshotOperationPath)).toBe(true);
            observedSnapshotId = null;

            // A tracked checkpoint the host no longer reports is out-of-band drift, not an
            // untrustworthy result. The legacy ownership prelude threw inside PowerShell for this
            // case, which exited non-zero and reached the provider-failure branch so journal
            // reconciliation could repair it. Collapsing it onto hyper-v-snapshot-invalid-result
            // would skip the repair that exists for exactly this drift.
            //
            // The journal from the case above is cleared first so the pre-operation reconcile does
            // not consume the drift before the ownership fence sees it — this asserts the fence's
            // own behavior, not the pre-op path's.
            const devicesBeforeDrift = readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"));
            rmSync(snapshotOperationPath, { force: true });
            snapshotExists = false;
            const callsBeforeDrift = commandRunner.mock.calls.length;
            const driftedDelete = await invokeTool("device_snapshot_delete", { snapshotName: "before-install", confirmDestructive: true });
            expect(driftedDelete.status).toBe(502);
            expect(await driftedDelete.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-provider-failed" }));
            const driftCalls = commandRunner.mock.calls.slice(callsBeforeDrift);
            expect(driftCalls.some(([issued]) => nativeLibraryRequest(issued)?.operation === "Repair-VMSnapshotState")).toBe(true);
            // The guarantee stated directly rather than inferred from the call count: the fence
            // refused to act, so no checkpoint removal was ever issued.
            expect(driftCalls.some(([issued]) => nativeLibraryRequest(issued)?.operation === "Remove-VMSnapshot")).toBe(false);
            // Reconciliation owns the journal it repaired; nothing else clears it here.
            expect(existsSync(snapshotOperationPath)).toBe(false);
            snapshotExists = true;
            writeFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), devicesBeforeDrift);

            const snapshotDeleted = await invokeTool("device_snapshot_delete", { snapshotName: "before-install", confirmDestructive: true });
            expect(snapshotDeleted.status).toBe(200);
            expect(await snapshotDeleted.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ snapshots: [], activeSnapshotId: null }) }) }));

            const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
            const validNetworkState = readFileSync(networkStatePath);
            writeFileSync(operationPath, JSON.stringify({ version: 1, operationId: snapshotId, ownerId, deviceId, incarnationId, command: "device_delete", vmId, vmName, diskPath, startedAt: new Date().toISOString() }));
            deleteConfirmationFailure = true;
            const unconfirmedReconciliation = await invoke({ backend: "windows-vm", command: "device_delete", deviceId, incarnationId });
            expect(unconfirmedReconciliation.status).toBe(502);
            expect(await unconfirmedReconciliation.json()).toEqual(expect.objectContaining({ error: "hyper-v-delete-reconciliation-invalid-result" }));
            expect(existsSync(operationPath)).toBe(true);
            expect(existsSync(privateRoot)).toBe(true);
            deleteConfirmationFailure = false;
            writeFileSync(networkStatePath, "{malformed");
            const cleanupFailed = await invoke({ backend: "windows-vm", command: "device_delete", deviceId, incarnationId });
            expect(cleanupFailed.status).toBe(502);
            expect(await cleanupFailed.json()).toEqual(expect.objectContaining({ error: "hyper-v-delete-reconciliation-cleanup-failed" }));
            expect(existsSync(privateRoot)).toBe(true);
            expect((JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as { devices: Array<{ id: string }> }).devices).toEqual(expect.arrayContaining([expect.objectContaining({ id: deviceId })]));

            sameNameReplacementVmId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
            const cleanupCallsBeforeIdentityConflict = commandRunner.mock.calls.filter(
                ([command]) => isHyperVNetworkCleanupScript(providerScript(command)),
            ).length;
            const sameNameIdentityConflict = await invoke({ backend: "windows-vm", command: "device_delete", deviceId, incarnationId });
            expect(sameNameIdentityConflict.status).toBe(502);
            expect(await sameNameIdentityConflict.json()).toEqual(expect.objectContaining({ error: "hyper-v-delete-reconciliation-invalid-result" }));
            expect(existsSync(operationPath)).toBe(true);
            expect(existsSync(privateRoot)).toBe(true);
            expect((JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as { devices: Array<{ id: string }> }).devices)
                .toEqual(expect.arrayContaining([expect.objectContaining({ id: deviceId })]));
            expect(commandRunner.mock.calls.filter(
                ([command]) => isHyperVNetworkCleanupScript(providerScript(command)),
            )).toHaveLength(cleanupCallsBeforeIdentityConflict);
            sameNameReplacementVmId = null;

            writeFileSync(networkStatePath, validNetworkState);
            networkCleanupFailure = "nonzero";
            const providerCleanupFailed = await invoke({ backend: "windows-vm", command: "device_delete", deviceId, incarnationId });
            expect(providerCleanupFailed.status).toBe(502);
            const providerCleanupFailureBody = await providerCleanupFailed.json();
            expect(providerCleanupFailureBody).toEqual(expect.objectContaining({
                error: "hyper-v-delete-reconciliation-cleanup-failed",
                detail: expect.stringContaining("hyper-v-network-elevation-request-failed"),
            }));
            expect(JSON.stringify(providerCleanupFailureBody))
                .not.toContain("network-cleanup-host-secret");
            expect(existsSync(networkStatePath)).toBe(true);
            expect(JSON.parse(readFileSync(networkStatePath, "utf8")).allocations).toEqual(expect.arrayContaining([
                expect.objectContaining({ ownerId, deviceId, incarnationId }),
            ]));
            writeFileSync(networkStatePath, validNetworkState);
            networkCleanupFailure = "invalid";
            const invalidProviderCleanup = await invoke({
                backend: "windows-vm",
                command: "device_delete",
                deviceId,
                incarnationId,
            });
            expect(invalidProviderCleanup.status).toBe(502);
            const invalidProviderCleanupBody = await invalidProviderCleanup.json();
            expect(invalidProviderCleanupBody).toEqual(expect.objectContaining({
                error: "hyper-v-delete-reconciliation-cleanup-failed",
                // A malformed response is a protocol failure, not a native error id.
                detail: expect.stringContaining(
                    "hyper-v-windows-protocol-response-malformed",
                ),
            }));
            expect(JSON.stringify(invalidProviderCleanupBody))
                .not.toContain("network-cleanup-invalid-secret");
            expect(existsSync(networkStatePath)).toBe(true);
            writeFileSync(networkStatePath, validNetworkState);
            networkCleanupFailure = "nonzero";
            const cleanupCallsBeforePreservedRecovery = commandRunner.mock.calls.filter(
                ([command]) => isHyperVNetworkCleanupScript(providerScript(command)),
            ).length;
            const deleted = await invoke({
                backend: "windows-vm",
                command: "device_delete",
                deviceId,
                incarnationId,
                preserveNetwork: true,
            });
            expect(deleted.status).toBe(200);
            expect(await deleted.json()).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    reconciled: true,
                    hyperVNetworkAllocationCleanup: expect.objectContaining({
                        released: true,
                        remaining: 0,
                        networkCleanup: {
                            skipped: true,
                            reason: "hyper-v-network-retained-by-request",
                        },
                    }),
                }),
            }));
            expect(commandRunner.mock.calls.filter(
                ([command]) => isHyperVNetworkCleanupScript(providerScript(command)),
            )).toHaveLength(cleanupCallsBeforePreservedRecovery);
            expect(existsSync(privateRoot)).toBe(false);
            expect((JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as { devices: unknown[] }).devices).toEqual([]);
            expect(JSON.parse(readFileSync(networkStatePath, "utf8"))).toMatchObject({
                managedSwitch: true,
                managedGateway: true,
                managedNat: true,
                allocations: [],
            });

            networkCleanupFailure = false;
            const recreated = await invoke({ backend: "windows-vm", command: "device_create", deviceId, name: "Windows VM E2E cached", profile: "windows-11", memoryMb: 4096, cpus: 2 });
            expect(recreated.status).toBe(200);
            const recreatedIncarnationId = (await recreated.clone().json()).result.device.incarnationId as string;
            activeIncarnationId = recreatedIncarnationId;
            const stateFile = join(backendRoot(ownerId, "windows-vm"), "devices.json");
            const canonicalState = JSON.parse(readFileSync(stateFile, "utf8"));
            writeFileSync(stateFile, JSON.stringify({ devices: canonicalState.devices.map((device) => ({ ...device, diskPath: join(cwd, "foreign.vhdx") })) }));
            const refusedTamperedDelete = await invoke({ backend: "windows-vm", command: "device_delete", deviceId, incarnationId: recreatedIncarnationId });
            expect(refusedTamperedDelete.status).toBe(400);
            expect(await refusedTamperedDelete.json()).toEqual(expect.objectContaining({ error: "invalid-provider-metadata" }));
            writeFileSync(stateFile, JSON.stringify(canonicalState));
            deleteConfirmationFailure = true;
            const providerUnconfirmedDelete = await invoke({ backend: "windows-vm", command: "device_delete", deviceId, incarnationId: recreatedIncarnationId });
            expect(providerUnconfirmedDelete.status).toBe(502);
            expect(existsSync(privateRoot)).toBe(true);
            expect((JSON.parse(readFileSync(stateFile, "utf8")) as { devices: Array<{ id: string }> }).devices).toEqual(expect.arrayContaining([expect.objectContaining({ id: deviceId })]));
            deleteConfirmationFailure = false;
            const redeleted = await invoke({ backend: "windows-vm", command: "device_delete", deviceId, incarnationId: recreatedIncarnationId });
            expect(redeleted.status).toBe(200);
            expect(existsSync(deviceRoot)).toBe(false);
            expect(existsSync(privateRoot)).toBe(false);
            const callsAfterDelete = commandRunner.mock.calls.length;
            const duplicateDelete = await invoke({ backend: "windows-vm", command: "device_delete", deviceId });
            expect(duplicateDelete.status).toBe(200);
            expect(await duplicateDelete.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ idempotent: true, alreadyMissing: true, invoked: false, device: null }) }));
            expect(commandRunner).toHaveBeenCalledTimes(callsAfterDelete);
            expect(preparedSourcePath).toMatch(/\.source-[a-f0-9]{24}\.vhdx$/);
            expect(commandRunner.mock.calls.filter(([command]) => nativeLibraryRequest(command)?.operation === "Remove-HostFiles")).not.toHaveLength(0);
            expect(commandRunner.mock.calls.filter(([command]) => providerScript(command).includes("hyper-v-orphan-vm-ownership-mismatch"))).toHaveLength(0);
            // The broker now routes host-network creation through the typed primitive adapter;
            // the retired composite setup script must never run in this production-shaped flow.
            expect(commandRunner.mock.calls.filter(([command]) => providerScript(command).includes("New-NetNat -Name $NatName"))).toHaveLength(0);
            expect(commandRunner.mock.calls.filter(([command]) => isHyperVNetworkCleanupScript(providerScript(command)))).toHaveLength(0);
            const snapshotRepairCalls = commandRunner.mock.calls.filter(([command]) => nativeLibraryRequest(command)?.operation === "Repair-VMSnapshotState");
            // The indeterminate protocol-failure fixture above clears its synthetic journal
            // before the independent drift case, so it contributes no repair call here.
            expect(snapshotRepairCalls).toHaveLength(10);
            for (const [command] of snapshotRepairCalls) {
                expect(nativeLibraryRequest(command)).toMatchObject({ expectedCheckpointPolicy: "ProductionOnly" });
            }
            // Up from 90 with the snapshot migration: the typed library issues one primitive per
            // call, so operations that were a single PowerShell script now cost several round trips
            // (an ownership read before each mutation, a VM state read around restore, and an
            // absence read confirming a delete). The three new error-path cases add 3: the
            // result-mismatch case costs a create preflight plus the checkpoint itself with no
            // reconciliation behind it, the drift case costs one ownership read (its reconciliation
            // moved here from the following delete rather than adding to the total), and the
            // corrupted-metadata case costs nothing at all — that is the point of its 400.
            // The scrub-containment cases cover un-scrubbed probes, transport failures,
            // retained and mounted media, live and off guest states, failed containment,
            // and recovery. Typed DVD removal and readback add calls to successful probes.
            // Power transactions read the owned VM before and after each mutation.
            // The two rejected waitForBoot:false calls add nothing by design — that is what their
            // own assertion checks. The per-case split is not spelled out because the obvious
            // accounting — "each contained case costs a stop plus an ownership read" — was measured
            // and is not what the cases actually cost; a plausible breakdown is worse than none.
            // Readiness retries can add a probe at the 1-second deadline boundary. The
            // per-case checks above pin containment costs; this range catches runaway traffic.
            expect(commandRunner.mock.calls.some(([command]) => nativeLibraryRequest(command)?.operation === "Get-VM")).toBe(true);
            expect(commandRunner.mock.calls.some(([command]) => providerScript(command).includes("$Snapshots = @(Get-VMSnapshot"))).toBe(false);
            expect(commandRunner.mock.calls.length).toBeGreaterThanOrEqual(280);
            expect(commandRunner.mock.calls.length).toBeLessThan(450);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(imageProfileRoot, { recursive: true, force: true });
        }
    }, 120000);

    it.each([
        {
            group: "VHD inspection",
            variants: ["vhd-wrong-path", "vhd-wrong-format", "vhd-wrong-type", "vhd-parent", "vhd-native-failure", "vhd-reparse", "vhd-malformed", "vhd-wrong-size", "vhd-missing-clone", "vhd-clone-native-failure", "vhd-clone-malformed"] as const,
        },
        {
            group: "VM creation",
            variants: ["nonzero", "timeout", "overflow", "malformed", "wrong-name", "wrong-disk", "artifact-cleanup-failure", "allocation-cleanup-failure", "allocation-elevation-cancelled", "recovery-native-failure", "provision-failure", "provision-ownership-failure", "provision-untagged-failure", "typed-boot-failure", "typed-integration-failure", "typed-media-ambiguous", "missing-credential", "state-claim-conflict"] as const,
        },
    ])("rolls back Hyper-V resources when create output cannot be trusted ($group)", async ({ variants }) => {
        const cwd = join(process.env.HOME!, "broker-hyper-v-invalid-create-test");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", "windows-11");
        const imagePath = join(profileRoot, "base.vhdx");
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, "owner-scoped-vhdx");
        const sha256 = createHash("sha256").update("owner-scoped-vhdx").digest("hex");
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "windows-11",
            catalogId: "user-provided-vhdx",
            sourceUrl: null,
            sourceFormat: "vhdx",
            sourceSha256: null,
            licenseId: null,
            generation: 2,
            secureBootTemplate: "MicrosoftWindows",
            preparationVersion: 1,
            imagePath,
            sha256,
            sizeBytes: 17,
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const vhdVariants = new Set<string>(variants.filter((variant) => variant.startsWith("vhd-")));
        const cleanupOutside = join(cwd, "cleanup-outside");
        mkdirSync(cleanupOutside, { recursive: true });
        let createIndex = 0;
        let recoveryCalls = 0;
        const recoveredVariants = new Set<string>();
        let activeVariant: typeof variants[number] | null = null;
        let currentRequestVariant: typeof variants[number] | null = null;
        let networkStateBeforeCleanupFailure: string | null = null;
        const provisioningSecretEcho = "hyper-v-secret-provider-echo";
        const rollbackSecretEcho = "hyper-v-rollback-provider-echo";
        const createdVmNames = new Map<string, string>();
        const commandRunner = vi.fn((command) => {
            const script = providerScript(command);
            if (isHyperVNetworkCleanupScript(script)) {
                return { mode: command.mode, provider: command.provider, status: 0, stdout: JSON.stringify({ ok: true, removedSwitch: true, removedNat: true, removedGateway: true, alreadyMissing: false }), stderr: "" };
            }
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) throw new Error("legacy orphan recovery invoked");
            if (script.includes("New-NetNat -Name $NatName")) {
                return { mode: command.mode, provider: command.provider, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command)), stderr: "" };
            }
            if (script.includes("Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND'")
                && (activeVariant === "provision-failure" || activeVariant === "provision-ownership-failure" || activeVariant === "provision-untagged-failure"
                    || activeVariant === "typed-boot-failure" || activeVariant === "typed-integration-failure"
                    || activeVariant === "typed-media-ambiguous" || activeVariant === "missing-credential"
                    || activeVariant === "state-claim-conflict")) {
                const deviceId = `invalid-create-${activeVariant}`;
                const vmName = createdVmNames.get(deviceId) || "";
                const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId);
                const deviceRoot = join(privateRoot, "artifacts");
                const credentialPath = join(privateRoot, "secrets", "guest.credential.xml");
                const provisioningMediaPath = join(deviceRoot, "disks", "autounattend.iso");
                mkdirSync(dirname(credentialPath), { recursive: true });
                if (activeVariant === "missing-credential") rmSync(credentialPath, { force: true });
                else writeFileSync(credentialPath, "fake-dpapi-credential");
                if (activeVariant === "provision-failure" || activeVariant === "provision-ownership-failure" || activeVariant === "provision-untagged-failure") {
                    return {
                        mode: command.mode,
                        provider: command.provider,
                        executable: `C:\\host-secret\\${provisioningSecretEcho}\\powershell.exe`,
                        args: ["-EncodedCommand", provisioningSecretEcho],
                        status: 1,
                        stdout: provisioningSecretEcho,
                        stderr: activeVariant === "provision-failure"
                            ? `hyper-v-provisioning-media-create-failed: ${provisioningSecretEcho}`
                            : activeVariant === "provision-ownership-failure"
                                ? `hyper-v-vm-ownership-mismatch: ${provisioningSecretEcho}`
                                : `untagged provisioning failure: ${provisioningSecretEcho}`,
                        error: `spawn failed at C:\\host-secret\\${provisioningSecretEcho}`,
                    };
                }
                if (activeVariant === "state-claim-conflict") {
                    const stateFile = join(backendRoot(ownerId, "windows-vm"), "devices.json");
                    mkdirSync(dirname(stateFile), { recursive: true });
                    writeFileSync(stateFile, JSON.stringify({ devices: [{ id: deviceId, backend: "windows-vm", ownerId, vmId: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb", vmName: "foreign-vm", diskPath: join(cwd, "foreign.vhdx"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
                }
                return { mode: command.mode, provider: command.provider, status: 0, stdout: JSON.stringify({ ok: true, vmId: "12345678-1234-1234-1234-123456789abc", vmName, guestUsername: `ccc${ownerId.slice(0, 8)}`, credentialPath, unattendPath: provisioningMediaPath }), stderr: "" };
            }
            if (script.includes("New-VM @VmArgs")) {
                const variant = variants[createIndex++];
                activeVariant = variant;
                const deviceId = `invalid-create-${variant}`;
                const vmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                createdVmNames.set(deviceId, vmName);
                const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId);
                const diskPath = join(privateRoot, "artifacts", "disks", "root.vhdx");
                if (variant === "nonzero") {
                    return {
                        mode: command.mode,
                        provider: command.provider,
                        status: 1,
                        stdout: "CCC_HYPER_V_STAGE:hyper-v-vm-create-failed",
                        stderr: "New-VM failed with a host-specific secret",
                    };
                }
                if (variant === "timeout") {
                    return { mode: command.mode, provider: command.provider, status: null, stdout: "", stderr: "", error: "device-lab backend tool timed out", timedOut: true };
                }
                if (variant === "overflow") {
                    return { mode: command.mode, provider: command.provider, status: null, stdout: "partial output", stderr: "", error: "device-lab provider output exceeded limit" };
                }
                if (variant === "artifact-cleanup-failure") {
                    rmSync(privateRoot, { recursive: true, force: true });
                    directorySymlink(cleanupOutside, privateRoot);
                }
                if (variant === "allocation-cleanup-failure") {
                    const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
                    networkStateBeforeCleanupFailure = readFileSync(networkStatePath, "utf8");
                    writeFileSync(networkStatePath, "{malformed");
                }
                const stdout = variant === "malformed" || variant === "artifact-cleanup-failure" || variant === "allocation-cleanup-failure"
                    ? "not-json"
                    : JSON.stringify({ ok: true, vmId: "12345678-1234-1234-1234-123456789abc", vmName: variant === "wrong-name" ? "foreign-vm" : vmName, generation: 2, diskPath: variant === "wrong-disk" ? join(cwd, "foreign.vhdx") : diskPath });
                return { mode: command.mode, provider: command.provider, status: 0, stdout, stderr: "" };
            }
            throw new Error("unexpected Hyper-V command");
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            beforeOperation(request) {
                if (request.operation === "Remove-HostFiles") {
                    if (currentRequestVariant && !recoveredVariants.has(currentRequestVariant)) {
                        recoveredVariants.add(currentRequestVariant);
                        recoveryCalls += 1;
                    }
                    if (activeVariant === "recovery-native-failure") {
                        return { status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: false,
                            errorCode: "RemoveItemIOError-Microsoft.PowerShell.Commands.RemoveItemCommand" }),
                        stderr: `Remove-Item : C:\\host-secret\\${rollbackSecretEcho}` };
                    }
                    const paths = (request as typeof request & { paths?: readonly string[] }).paths ?? [];
                    return { status: 0, stdout: nativeEnvelope(request.operation, [{
                        removedCount: paths.length > 0 && activeVariant && !vhdVariants.has(activeVariant) ? 1 : 0,
                    }]), stderr: "" };
                }
                if (request.operation === "Get-VMDvdDrive") {
                    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items: [] }) };
                }
                if (request.operation === "Configure-VMGuestBoot") {
                    const failures: Record<string, string> = {
                        "typed-boot-failure": "hyper-v-guest-secure-boot-not-enabled",
                        "typed-integration-failure": "hyper-v-guest-integration-services-not-enabled",
                        "typed-media-ambiguous": "hyper-v-guest-provisioning-media-already-attached",
                    };
                    if (activeVariant && failures[activeVariant]) {
                        return { status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation,
                            ok: false, errorCode: failures[activeVariant] }),
                        stderr: `host path C:\\host-secret\\${provisioningSecretEcho}` };
                    }
                    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items: [] }) };
                }
                if (request.operation === "Get-VHD" && request.path) {
                    if (request.path === imagePath && vhdVariants.has(variants[createIndex] || "")) {
                        activeVariant = variants[createIndex++];
                    }
                    if (activeVariant && vhdVariants.has(activeVariant)) {
                        const cloneFailure = activeVariant === "vhd-wrong-size" || activeVariant === "vhd-missing-clone"
                            || activeVariant === "vhd-clone-native-failure" || activeVariant === "vhd-clone-malformed";
                        if ((request.path === imagePath) !== cloneFailure) {
                            if (activeVariant === "vhd-malformed" || activeVariant === "vhd-clone-malformed") return { status: 0, stdout: "not-json", stderr: "" };
                            if (activeVariant === "vhd-native-failure" || activeVariant === "vhd-missing-clone" || activeVariant === "vhd-reparse" || activeVariant === "vhd-clone-native-failure") return {
                                status: 1,
                                stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VHD", ok: false, errorCode: activeVariant === "vhd-reparse" ? "vhd-path-reparse-point-rejected" : activeVariant === "vhd-clone-native-failure" ? "vhd-inspection-failed" : "vhd-not-found" }),
                                stderr: "",
                            };
                            return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VHD", ok: true, items: [{
                                path: activeVariant === "vhd-wrong-path" ? join(cwd, "foreign.vhdx") : request.path,
                                vhdFormat: activeVariant === "vhd-wrong-format" ? "VHD" : "VHDX",
                                vhdType: activeVariant === "vhd-wrong-type" ? "Differencing" : "Dynamic",
                                parentPath: activeVariant === "vhd-parent" ? join(cwd, "parent.vhdx") : null,
                                virtualSizeBytes: activeVariant === "vhd-wrong-size" ? 32 * 1024 * 1024 * 1024 : 64 * 1024 * 1024 * 1024,
                                fileSizeBytes: 17,
                            }] }), stderr: "" };
                        }
                    }
                }
                if (request.operation === "Get-VMHardDiskDrive" && activeVariant === "wrong-disk") {
                    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VMHardDiskDrive", ok: true, items: [{
                        vmId: "12345678-1234-1234-1234-123456789abc",
                        vmName: createdVmNames.get("invalid-create-wrong-disk"),
                        path: join(cwd, "foreign.vhdx"),
                        controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0, diskNumber: null,
                    }] }), stderr: "" };
                }
                if (request.operation !== "New-VM") return null;
                expect(vhdVariants.has(variants[createIndex] || "")).toBe(false);
                const variant = variants[createIndex++];
                activeVariant = variant;
                const vmName = request.name || "";
                const deviceId = `invalid-create-${variant}`;
                createdVmNames.set(deviceId, vmName);
                const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId);
                if (variant === "artifact-cleanup-failure") {
                    rmSync(privateRoot, { recursive: true, force: true });
                    directorySymlink(cleanupOutside, privateRoot);
                }
                if (variant === "allocation-cleanup-failure") {
                    const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
                    networkStateBeforeCleanupFailure = readFileSync(networkStatePath, "utf8");
                    writeFileSync(networkStatePath, "{malformed");
                }
                if (variant === "allocation-elevation-cancelled") {
                    vi.mocked(releaseHyperVNetworkAllocationAndCleanup).mockResolvedValueOnce({
                        ok: false,
                        released: false,
                        statePresent: true,
                        remaining: 1,
                        error: "hyper-v-network-elevation-cancelled",
                        networkCleanup: null,
                    });
                }
                if (variant === "nonzero") return { status: 1, stdout: "", stderr: "New-VM failed with a host-specific secret" };
                if (variant === "timeout") return { status: null, stdout: "", stderr: "", error: "device-lab backend tool timed out", timedOut: true };
                if (variant === "overflow") return { status: null, stdout: "partial output", stderr: "", error: "device-lab provider output exceeded limit" };
                if (["malformed", "artifact-cleanup-failure", "allocation-cleanup-failure", "allocation-elevation-cancelled", "recovery-native-failure"].includes(variant)) return { status: 0, stdout: "not-json", stderr: "" };
                if (variant === "wrong-name") return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: "New-VM", ok: true, items: [{
                    id: "12345678-1234-1234-1234-123456789abc", name: "foreign-vm", state: "Off",
                    status: "Operating normally", notes: "", uptimeMilliseconds: 0, generation: 2, checkpointType: "Disabled",
                }] }), stderr: "" };
                return null;
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            for (const variant of variants) {
                currentRequestVariant = variant;
                activeVariant = null;
                const removeCallsBefore = commandRunner.mock.calls.filter(([issued]) => nativeLibraryRequest(issued)?.operation === "Remove-VM").length;
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "windows-vm", command: "device_create", deviceId: `invalid-create-${variant}`, name: "Invalid VM", profile: "windows-11" } }),
                });
                const body = await response.json();
                expect(JSON.stringify(body)).not.toContain(rollbackSecretEcho);
                expect(response.status, `${variant}: ${JSON.stringify(body)}`).toBe(variant === "state-claim-conflict" ? 409 : 502);
                const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", `invalid-create-${variant}`);
                const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
                if (variant === "artifact-cleanup-failure") {
                    expect(body).toEqual(expect.objectContaining({ error: "hyper-v-create-invalid-result", rollback: expect.objectContaining({ ok: false, error: "hyper-v-recovery-cleanup-failed", detail: "hyper-v-artifact-cleanup-failed" }) }));
                    expect(body.rollback).not.toHaveProperty("stage");
                    expect(lstatSync(privateRoot).isSymbolicLink()).toBe(true);
                    const allocations = existsSync(networkStatePath) ? JSON.parse(readFileSync(networkStatePath, "utf8")).allocations : [];
                    expect(allocations).not.toEqual(expect.arrayContaining([expect.objectContaining({ ownerId, deviceId: `invalid-create-${variant}` })]));
                    rmSync(privateRoot, { force: true });
                } else if (variant === "allocation-cleanup-failure" || variant === "allocation-elevation-cancelled") {
                    // The release failed, so the artifacts were never touched: the rollback names the
                    // network error and its stage, not an artifact cleanup that did not run.
                    expect(body).toEqual(expect.objectContaining({
                        error: "hyper-v-create-invalid-result",
                        rollback: {
                            ok: false,
                            status: 502,
                            error: "hyper-v-recovery-cleanup-failed",
                            stage: "network-release",
                            detail: variant === "allocation-cleanup-failure"
                                ? "hyper-v-network-state-state-invalid"
                                : "hyper-v-network-elevation-cancelled",
                        },
                    }));
                    expect(existsSync(privateRoot)).toBe(true);
                    if (variant === "allocation-cleanup-failure") {
                        expect(networkStateBeforeCleanupFailure).not.toBeNull();
                        writeFileSync(networkStatePath, networkStateBeforeCleanupFailure!);
                    }
                } else if (variant === "recovery-native-failure") {
                    // The typed library's own code for the step that failed, not its bare category.
                    expect(body).toEqual(expect.objectContaining({
                        error: "hyper-v-create-invalid-result",
                        rollback: {
                            ok: false,
                            status: 502,
                            error: "hyper-v-recovery-failed",
                            detail: "hyper-v-ps-removeitemioerror-microsoft-powershell-commands-removeitemcommand",
                        },
                    }));
                    expect(existsSync(privateRoot)).toBe(true);
                } else if (variant === "wrong-disk") {
                    expect(body).toEqual(expect.objectContaining({
                        error: "hyper-v-create-invalid-result",
                        rollback: expect.objectContaining({ ok: false, error: "hyper-v-recovery-failed", detail: "hyper-v-delete-attachment-mismatch" }),
                    }));
                    expect(commandRunner.mock.calls.filter(([issued]) => nativeLibraryRequest(issued)?.operation === "Remove-VM")).toHaveLength(removeCallsBefore);
                    expect(existsSync(privateRoot)).toBe(true);
                } else if (vhdVariants.has(variant)) {
                    expect(body).toEqual(expect.objectContaining({
                        error: variant === "vhd-malformed" || variant === "vhd-clone-malformed" ? "hyper-v-create-invalid-result" : "provider-command-failed",
                        detail: variant === "vhd-native-failure" ? "hyper-v-base-image-not-found"
                            : variant === "vhd-missing-clone" ? "hyper-v-created-disk-not-found"
                                : variant === "vhd-reparse" ? "hyper-v-path-reparse-point-rejected"
                                    : variant === "vhd-clone-native-failure" || variant === "vhd-clone-malformed" ? "hyper-v-vm-disk-create-failed"
                                : variant === "vhd-malformed" ? "hyper-v-base-image-inspection-failed"
                                    : variant === "vhd-wrong-size" ? "hyper-v-created-disk-format-mismatch"
                                        : "hyper-v-base-image-parent-invalid",
                        rollback: expect.objectContaining({ ok: true, recoveredVm: false, removedDisk: false }),
                    }));
                    // A failed typed read still names its primitive; a policy mismatch has none.
                    if (["vhd-native-failure", "vhd-missing-clone", "vhd-reparse", "vhd-clone-native-failure", "vhd-malformed", "vhd-clone-malformed"].includes(variant)) {
                        expect(body.operation).toBe("Get-VHD");
                    } else {
                        expect(body).not.toHaveProperty("operation");
                    }
                    expect(createdVmNames.has(`invalid-create-${variant}`)).toBe(false);
                    expect(existsSync(privateRoot)).toBe(false);
                    const allocations = existsSync(networkStatePath) ? JSON.parse(readFileSync(networkStatePath, "utf8")).allocations : [];
                    expect(allocations).not.toEqual(expect.arrayContaining([expect.objectContaining({ ownerId, deviceId: `invalid-create-${variant}` })]));
                } else if (variant === "provision-failure" || variant === "provision-ownership-failure" || variant === "provision-untagged-failure"
                    || variant === "typed-boot-failure" || variant === "typed-integration-failure" || variant === "typed-media-ambiguous"
                    || variant === "missing-credential" || variant === "state-claim-conflict") {
                    expect(body).toEqual(expect.objectContaining({
                        error: variant === "state-claim-conflict" ? "owner-device-id-conflict"
                            : variant === "missing-credential" ? "hyper-v-guest-provision-invalid-result" : "hyper-v-guest-provision-failed",
                        rollback: expect.objectContaining({ ok: true }),
                    }));
                    if (variant === "provision-failure" || variant === "provision-ownership-failure" || variant === "provision-untagged-failure") {
                        expect(JSON.stringify(body)).not.toContain(provisioningSecretEcho);
                        expect(body.provisioning).toEqual(expect.objectContaining({
                            stdoutPresent: true,
                            stderrPresent: true,
                            outputRedacted: true,
                            diagnosticCode: variant === "provision-failure"
                                ? "hyper-v-provisioning-media-create-failed"
                                : variant === "provision-ownership-failure"
                                    ? "hyper-v-vm-ownership-mismatch"
                                    : "hyper-v-guest-provision-command-failed",
                        }));
                    }
                    if (variant === "typed-boot-failure" || variant === "typed-integration-failure" || variant === "typed-media-ambiguous") {
                        expect(JSON.stringify(body)).not.toContain(provisioningSecretEcho);
                        expect(body.provisioning).toEqual(expect.objectContaining({
                            status: 1, stdoutPresent: false, stderrPresent: true, outputRedacted: true,
                            diagnosticCode: variant === "typed-boot-failure" ? "hyper-v-guest-secure-boot-not-enabled"
                                : variant === "typed-integration-failure" ? "hyper-v-guest-integration-services-not-enabled"
                                    : "hyper-v-guest-provisioning-media-already-attached",
                        }));
                    }
                    if (variant === "missing-credential") {
                        expect(body.provisioning).toEqual(expect.objectContaining({ status: 0, outputRedacted: true }));
                    }
                    expect(existsSync(privateRoot)).toBe(false);
                    const allocations = existsSync(networkStatePath) ? JSON.parse(readFileSync(networkStatePath, "utf8")).allocations : [];
                    expect(allocations).not.toEqual(expect.arrayContaining([expect.objectContaining({ ownerId, deviceId: `invalid-create-${variant}` })]));
                } else {
                    expect(body).toEqual(expect.objectContaining({
                        error: ["nonzero", "timeout", "overflow"].includes(variant) ? "provider-command-failed" : "hyper-v-create-invalid-result",
                        rollback: expect.objectContaining({ ok: true, removedDisk: true }),
                    }));
                    if (variant === "nonzero") {
                        // The typed client's own code, not the generic provider fallback.
                        expect(body.detail).toBe("hyper-v-windows-protocol-response-malformed");
                        expect(body.operation).toBe("New-VM");
                        expect(JSON.stringify(body)).not.toContain("host-specific secret");
                    }
                    expect(existsSync(privateRoot)).toBe(false);
                    const allocations = existsSync(networkStatePath) ? JSON.parse(readFileSync(networkStatePath, "utf8")).allocations : [];
                    expect(allocations).not.toEqual(expect.arrayContaining([expect.objectContaining({ ownerId, deviceId: `invalid-create-${variant}` })]));
                }
            }
            expect(createIndex).toBe(variants.length);
            expect(recoveryCalls).toBe(variants.length - (variants.includes("wrong-disk") ? 1 : 0));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    }, 120000);

    // Rolling back a failed create is compensation, not a delete request. Tearing the shared
    // switch, gateway and NAT down behind it needs Administrator, which is a UAC prompt in an
    // unattended run and an orphaned allocation when nobody answers it.
    it.each([
        { name: "typed VM creation failure", failure: "vm-create", error: "provider-command-failed" },
        { name: "guest provisioning failure", failure: "provision", error: "hyper-v-guest-provision-failed" },
    ] as const)("keeps the shared Hyper-V fabric when a failed create compensates its only allocation ($name)", async ({ failure, error }) => {
        const cwd = join(process.env.HOME!, "broker-hyper-v-compensation-fabric-test");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", "windows-11");
        const imagePath = join(profileRoot, "base.vhdx");
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, "owner-scoped-vhdx");
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "windows-11",
            catalogId: "user-provided-vhdx",
            sourceUrl: null,
            sourceFormat: "vhdx",
            sourceSha256: null,
            licenseId: null,
            generation: 2,
            secureBootTemplate: "MicrosoftWindows",
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update("owner-scoped-vhdx").digest("hex"),
            sizeBytes: 17,
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
        const fabricMutations: string[] = [];
        const commandRunner = vi.fn((command) => {
            const script = providerScript(command);
            if (failure === "provision" && script.includes("Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND'")) {
                return { mode: command.mode, provider: command.provider, status: 1, stdout: "", stderr: "hyper-v-provisioning-media-create-failed: host detail" };
            }
            throw new Error("unexpected Hyper-V command");
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            onOperation(request) {
                if (["New-VMSwitch", "New-NetIPAddress", "New-NetNat", "Remove-NetNat", "Remove-NetIPAddress", "Remove-VMSwitch"].includes(request.operation)) {
                    fabricMutations.push(request.operation);
                }
            },
            beforeOperation(request) {
                if (request.operation === "Remove-HostFiles") {
                    return { status: 0, stdout: nativeEnvelope(request.operation, [{ removedCount: 0 }]), stderr: "" };
                }
                if (request.operation === "Configure-VMGuestBoot") {
                    return { status: 0, stdout: nativeEnvelope(request.operation, []), stderr: "" };
                }
                if (failure === "vm-create" && request.operation === "New-VM") {
                    return { status: 1, stdout: "", stderr: "New-VM failed with a host-specific detail" };
                }
                return null;
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const create = (deviceId: string) => fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST",
            headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "windows-vm", command: "device_create", deviceId, name: "Compensated VM", profile: "windows-11" } }),
        });
        try {
            for (const deviceId of ["compensated-first", "compensated-second"]) {
                const response = await create(deviceId);
                const body = await response.json();
                expect(response.status, JSON.stringify(body)).toBe(502);
                expect(body).toEqual(expect.objectContaining({ error, rollback: expect.objectContaining({ ok: true }) }));
                // The fabric is built once for the first create and never torn down, so neither
                // rollback nor the second create needed an administrator transaction.
                expect(fabricMutations).toEqual(["New-VMSwitch", "New-NetIPAddress", "New-NetNat"]);
                expect(JSON.parse(readFileSync(networkStatePath, "utf8"))).toMatchObject({
                    managedSwitch: true,
                    managedGateway: true,
                    managedNat: true,
                    allocations: [],
                });
                expect(existsSync(join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId))).toBe(false);
            }
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    }, 60000);

    // A post-create rollback that fails names its own cause: a native removal failure keeps its
    // id, and a failed network release is reported by stage beside artifacts it never touched.
    it.each([
        { name: "native removal failure", failure: "remove-host-files" },
        { name: "network release failure", failure: "release" },
    ] as const)("reports a failed provisioning rollback by its own cause ($name)", async ({ failure }) => {
        const cwd = join(process.env.HOME!, "broker-hyper-v-rollback-cause-test");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", "windows-11");
        const imagePath = join(profileRoot, "base.vhdx");
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, "owner-scoped-vhdx");
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "windows-11",
            catalogId: "user-provided-vhdx",
            sourceUrl: null,
            sourceFormat: "vhdx",
            sourceSha256: null,
            licenseId: null,
            generation: 2,
            secureBootTemplate: "MicrosoftWindows",
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update("owner-scoped-vhdx").digest("hex"),
            sizeBytes: 17,
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const deviceId = `rollback-cause-${failure}`;
        const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId);
        let provisioningFailed = false;
        const commandRunner = vi.fn((command) => {
            if (providerScript(command).includes("Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND'")) {
                provisioningFailed = true;
                if (failure === "release") {
                    vi.mocked(releaseHyperVNetworkAllocationAndCleanup).mockResolvedValueOnce({
                        ok: false,
                        released: false,
                        statePresent: true,
                        remaining: 1,
                        error: "hyper-v-network-elevation-cancelled",
                        networkCleanup: null,
                    });
                }
                return { mode: command.mode, provider: command.provider, status: 1, stdout: "", stderr: "hyper-v-provisioning-media-create-failed: host detail" };
            }
            throw new Error("unexpected Hyper-V command");
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            beforeOperation(request) {
                if (request.operation === "Remove-HostFiles") {
                    if (failure === "remove-host-files" && provisioningFailed) {
                        return { status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: false,
                            errorCode: "RemoveItemIOError-Microsoft.PowerShell.Commands.RemoveItemCommand" }),
                        stderr: "Remove-Item : C:\\host-secret\\rollback-cause" };
                    }
                    return { status: 0, stdout: nativeEnvelope(request.operation, [{ removedCount: 0 }]), stderr: "" };
                }
                if (request.operation === "Configure-VMGuestBoot") {
                    return { status: 0, stdout: nativeEnvelope(request.operation, []), stderr: "" };
                }
                return null;
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "windows-vm", command: "device_create", deviceId, name: "Rollback cause VM", profile: "windows-11" } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(502);
            expect(body.error).toBe("hyper-v-guest-provision-failed");
            if (failure === "remove-host-files") {
                expect(body.rollback).toEqual(expect.objectContaining({
                    attempted: true,
                    ok: false,
                    reason: "hyper-v-rollback-command-failed",
                    result: expect.objectContaining({
                        diagnosticCode: "hyper-v-ps-removeitemioerror-microsoft-powershell-commands-removeitemcommand",
                    }),
                }));
            } else {
                expect(body.rollback).toEqual({
                    attempted: true,
                    ok: false,
                    stage: "network-release",
                    result: expect.objectContaining({ status: 0, outputRedacted: true }),
                    artifacts: { ok: false, attempted: false, removed: false },
                    allocation: { ok: false, released: false, error: "hyper-v-network-elevation-cancelled" },
                });
            }
            expect(existsSync(privateRoot)).toBe(true);
            expect(JSON.stringify(body)).not.toContain("host-secret");
            expect(JSON.stringify(body)).not.toContain("host detail");
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    }, 60000);

    // A create that fails without a rollback of its own is compensated by the create wrapper. When
    // that compensation's network release fails, the stage is reported beside the failure it was
    // compensating, so neither is lost.
    it("names the stage of a failed wrapper compensation beside the create failure it followed", async () => {
        const cwd = join(process.env.HOME!, "broker-hyper-v-wrapper-compensation-test");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", "windows-11");
        const imagePath = join(profileRoot, "base.vhdx");
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, "owner-scoped-vhdx");
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "windows-11",
            catalogId: "user-provided-vhdx",
            sourceUrl: null,
            sourceFormat: "vhdx",
            sourceSha256: null,
            licenseId: null,
            generation: 2,
            secureBootTemplate: "MicrosoftWindows",
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update("owner-scoped-vhdx").digest("hex"),
            sizeBytes: 17,
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const deviceId = "wrapper-compensation";
        const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId);
        const movedRoot = join(cwd, "moved-private-root");
        let swapped = false;
        const commandRunner = vi.fn(() => {
            throw new Error("unexpected Hyper-V command");
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            onOperation(request) {
                // Once the incarnation is on record and the allocation is being made, the private
                // root turns into a symlink, so the create fails its own root check with no rollback.
                if (!swapped && request.operation === "New-VMSwitch") {
                    swapped = true;
                    rmSync(movedRoot, { recursive: true, force: true });
                    renameSync(privateRoot, movedRoot);
                    directorySymlink(movedRoot, privateRoot);
                    vi.mocked(releaseHyperVNetworkAllocationAndCleanup).mockResolvedValueOnce({
                        ok: false,
                        released: false,
                        statePresent: true,
                        remaining: 1,
                        error: "hyper-v-network-elevation-cancelled",
                        networkCleanup: null,
                    });
                }
            },
            beforeOperation(request) {
                if (request.operation === "Remove-HostFiles") {
                    return { status: 0, stdout: nativeEnvelope(request.operation, [{ removedCount: 0 }]), stderr: "" };
                }
                return null;
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "windows-vm", command: "device_create", deviceId, name: "Wrapper compensation", profile: "windows-11" } }),
            });
            const body = await response.json();
            expect(swapped).toBe(true);
            expect(response.status, JSON.stringify(body)).toBe(502);
            expect(body).toEqual(expect.objectContaining({
                error: "hyper-v-create-allocation-cleanup-failed",
                detail: "hyper-v-network-elevation-cancelled",
                stage: "network-release",
                lifecycleFailure: expect.objectContaining({
                    error: "hyper-v-private-root-invalid",
                    detail: "hyper-v-private-root-path-symlink-rejected",
                }),
            }));
        } finally {
            await close(server);
            rmSync(privateRoot, { force: true });
            cleanupOwner(ownerId);
            rmSync(movedRoot, { recursive: true, force: true });
        }
    }, 60000);

    // The 502 detail names what failed: the typed library's code in a bounded family, with the
    // operation that raised it, and never the host text that came back beside it.
    it.each([
        {
            name: "native error id",
            operation: "New-VM",
            diagnostics: {},
            result: {
                status: 1,
                stdout: JSON.stringify({ schemaVersion: 1, operation: "New-VM", ok: false, errorCode: "InvalidParameter-Microsoft.HyperV.PowerShell.Commands.NewVM" }),
                stderr: "New-VM : host-specific secret at C:\\Users\\secret-user\\vm",
            },
            detail: "hyper-v-ps-invalidparameter-microsoft-hyperv-powershell-commands-newvm",
        },
        {
            name: "transport failure",
            operation: "New-VM",
            diagnostics: {},
            result: { status: null, stdout: "", stderr: "host-specific secret", error: "spawn C:\\Users\\secret-user\\powershell.exe failed" },
            detail: "hyper-v-windows-transport-executor-failed",
        },
        {
            name: "firmware native diagnostics",
            operation: "Set-VMFirmware",
            diagnostics: { nativeHResult: -2147024809, nativeErrorCategory: 5 },
            result: {
                status: 1,
                stdout: JSON.stringify({ schemaVersion: 1, operation: "Set-VMFirmware", ok: false,
                    errorCode: "InvalidParameter-Microsoft.HyperV.PowerShell.Commands.SetVMFirmware",
                    nativeHResult: -2147024809, nativeErrorCategory: 5 }),
                stderr: "host secret at C:\\private\\file",
            },
            detail: "hyper-v-ps-invalidparameter-microsoft-hyperv-powershell-commands-setvmfirmware",
        },
    ] as const)("reports a failed typed create by its own code and operation ($name)", async ({ result, detail, operation, diagnostics }) => {
        const cwd = join(process.env.HOME!, "broker-hyper-v-typed-create-code-test");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", "windows-11");
        const imagePath = join(profileRoot, "base.vhdx");
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, "owner-scoped-vhdx");
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "windows-11",
            catalogId: "user-provided-vhdx",
            sourceUrl: null,
            sourceFormat: "vhdx",
            sourceSha256: null,
            licenseId: null,
            generation: 2,
            secureBootTemplate: "MicrosoftWindows",
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update("owner-scoped-vhdx").digest("hex"),
            sizeBytes: 17,
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const commandRunner = vi.fn(() => {
            throw new Error("unexpected Hyper-V command");
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            beforeOperation(request) {
                if (request.operation === "Remove-HostFiles") {
                    return { status: 0, stdout: nativeEnvelope(request.operation, [{ removedCount: 0 }]), stderr: "" };
                }
                return request.operation === operation ? result : null;
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "windows-vm", command: "device_create", deviceId: "typed-create-code", name: "Typed create code", profile: "windows-11" } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(502);
            expect(body).toEqual(expect.objectContaining({
                error: "provider-command-failed",
                detail,
                operation,
                ...diagnostics,
                rollback: expect.objectContaining({ ok: true }),
            }));
            expect(JSON.stringify(body)).not.toContain("secret");
            expect(JSON.stringify(body)).not.toContain("Microsoft.HyperV");
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    }, 60000);

    // Only an explicit device_delete may tear the shared fabric down. The stop and create cases
    // replay the same journal as compensation and then fail on their own terms: the replay removed
    // the device the stop was for, and this fixture prepares no image for the create.
    it.each([
        { command: "device_stop", keepsFabric: true, status: 404, error: "owner-device-not-found" },
        { command: "device_create", keepsFabric: true, status: 409, error: "hyper-v-base-image-not-prepared" },
        { command: "device_delete", keepsFabric: false, status: 200, error: null },
    ] as const)("replays a pending Hyper-V delete journal ahead of $command with the matching fabric policy", async ({ command, keepsFabric, status, error }) => {
        const cwd = join(process.env.HOME!, "broker-hyper-v-journal-fabric-test");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "journal-fabric";
        const incarnationId = "c".repeat(32);
        const vmId = "12345678-1234-1234-1234-123456789abc";
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId);
        const deviceRoot = join(privateRoot, "artifacts");
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        mkdirSync(dirname(diskPath), { recursive: true });
        writeFileSync(diskPath, "fake-root-vhdx");
        writeFileSync(join(deviceRoot, "operation.json"), JSON.stringify({
            version: 1,
            operationId: "11111111-2222-3333-4444-555555555555",
            ownerId,
            deviceId,
            incarnationId,
            command: "device_delete",
            vmId,
            vmName,
            diskPath,
            startedAt: new Date().toISOString(),
        }));
        const networkRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "network");
        const networkStatePath = join(networkRoot, "hyper-v.json");
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(networkStatePath, JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            marker: "ccc-device-lab:hyper-v-network:v1",
            natName: "CCCDeviceLab",
            natInstanceId: "ccc-nat-instance-1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            outboundPolicy: "nat",
            managedSwitch: true,
            managedGateway: true,
            managedNat: true,
            allocations: [{ ownerId, deviceId, incarnationId, address: "172.29.0.20", macAddress: "02:11:22:33:44:55", allocatedAt: new Date().toISOString() }],
        }));
        const fabricTeardowns: string[] = [];
        const commandRunner = vi.fn(() => {
            throw new Error("unexpected Hyper-V command");
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            onOperation(request) {
                if (["Remove-NetNat", "Remove-NetIPAddress", "Remove-VMSwitch"].includes(request.operation)) {
                    fabricTeardowns.push(request.operation);
                }
            },
            beforeOperation(request) {
                // The journaled VM is already gone; the replay proves that and finishes the delete.
                if (request.operation === "Get-VM" && request.selector) {
                    return { status: 0, stdout: nativeEnvelope(request.operation, []), stderr: "" };
                }
                if (request.operation === "Remove-HostFiles") {
                    return { status: 0, stdout: nativeEnvelope(request.operation, [{ removedCount: 1 }]), stderr: "" };
                }
                return null;
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: command === "device_create"
                        ? { backend: "windows-vm", command, deviceId, name: "Journal fabric", profile: "windows-11" }
                        : { backend: "windows-vm", command, deviceId, incarnationId },
                }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(status);
            expect(existsSync(privateRoot)).toBe(false);
            if (keepsFabric) {
                expect(body).toEqual(expect.objectContaining({ error }));
                expect(fabricTeardowns).toEqual([]);
                expect(JSON.parse(readFileSync(networkStatePath, "utf8"))).toMatchObject({
                    managedSwitch: true,
                    managedGateway: true,
                    managedNat: true,
                    allocations: [],
                });
            } else {
                expect(body).toEqual(expect.objectContaining({
                    result: expect.objectContaining({
                        reconciled: true,
                        hyperVNetworkAllocationCleanup: expect.objectContaining({
                            released: true,
                            remaining: 0,
                            networkCleanup: expect.objectContaining({ removedNat: true, removedGateway: true, removedSwitch: true }),
                        }),
                    }),
                }));
                expect(fabricTeardowns).toEqual(["Remove-NetNat", "Remove-NetIPAddress", "Remove-VMSwitch"]);
                expect(existsSync(networkStatePath)).toBe(false);
            }
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("refreshes canonical Windows Sandbox configs before starting existing definitions", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-windows-config-refresh-test");
        const deviceId = "windows-refresh";
        const deviceRoot = join(backendRoot(ownerId, "windows"), deviceId);
        const configPath = join(deviceRoot, `${deviceId}.wsb`);
        mkdirSync(deviceRoot, { recursive: true });
        writeFileSync(configPath, "<Configuration>stale nested mapping</Configuration>");
        writeBrokerDevices(ownerId, "windows", [{
            id: deviceId,
            backend: "windows-sandbox",
            status: "stopped",
            configPath,
            sandboxId: "12345678-1234-4234-9234-1234567890ab",
            networking: true,
            clipboard: false,
            vgpu: false,
            memoryMb: 3072,
            minimized: false,
        }]);
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            status: 0,
            stdout: "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-windows-config-refresh-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: "/fake/wsb" },
            commandRunner,
            platform: "linux",
        });
        const baseUrl = await listen(server);
        try {
            const started = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId },
                }),
            });
            expect(started.status).toBe(200);
            const startedBody = await started.json() as { result: { providerCommand: { args: string[] } } };
            const config = readFileSync(configPath, "utf-8");
            expect(config).not.toContain("stale nested mapping");
            expect(config).toContain("<Networking>Enable</Networking>");
            expect(config).toContain("<MemoryInMB>3072</MemoryInMB>");
            expect(config).not.toContain("<SandboxFolder>C:\\ccc\\scratch</SandboxFolder>");
            expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch\\inbox</SandboxFolder>");
            expect(config.match(/<MappedFolder>/g)).toHaveLength(5);
            expect(startedBody.result.providerCommand.args).toEqual(expect.arrayContaining(["--config", config]));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "wsb",
                args: expect.arrayContaining(["--config", config]),
            }), expect.any(Object));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("keeps physical lifecycle state fenced by its owner lease", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-physical-lifecycle-test");
        const deviceId = "android-physical-owned";
        const serial = "USB-PHYSICAL-OWNED";
        const claimId = "claim-physical-owned";
        const claimNonce = "nonce-physical-owned";
        const attachedDevice = {
            id: deviceId,
            backend: "android-device",
            physical: true,
            serial,
            status: "attached",
            leaseClaimId: claimId,
            leaseClaimNonce: claimNonce,
        };
        writeBrokerDevices(ownerId, "android-device", [attachedDevice]);
        const leaseDir = join(process.env.HOME!, ".ccc/devices/physical-leases/android-device/locks");
        const leaseFile = join(leaseDir, `${encodeURIComponent(serial)}.json`);
        mkdirSync(leaseDir, { recursive: true });
        writeFileSync(leaseFile, JSON.stringify({
            backend: "android-device",
            hardwareId: serial,
            ownerId,
            deviceId,
            claimId,
            claimNonce,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            stdout: command.provider === "adb" ? "device\n" : "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-lifecycle-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const invoke = (command: string) => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
                method: "broker.command.invoke",
                params: { backend: "android-device", command, deviceId, dryRun: false },
            }),
        });
        try {
            writeBrokerDevices(ownerId, "android-device", [{ ...attachedDevice, leaseClaimNonce: undefined }]);
            const missingClaimNonce = await invoke("device_start");
            expect(missingClaimNonce.status).toBe(409);
            expect(await missingClaimNonce.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-device-not-attached",
            }));

            writeBrokerDevices(ownerId, "android-device", [attachedDevice]);
            const started = await invoke("device_start");
            expect(started.status).toBe(200);
            expect(await started.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: deviceId, status: "attached" }),
                }),
            }));
            expect(existsSync(leaseFile)).toBe(true);

            const stateFile = join(backendRoot(ownerId, "android-device"), "devices.json");
            const stateBeforeStaleStop = JSON.parse(readFileSync(stateFile, "utf8")) as { devices: Array<Record<string, unknown>> };
            writeBrokerDevices(ownerId, "android-device", stateBeforeStaleStop.devices.map((device) => ({
                ...device,
                appium: {
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.appium.start",
                    runtimeId: "physical-stop-appium-runtime",
                    serverPid: 12345,
                },
                recording: {
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.device.recording.start",
                    pid: 12346,
                },
            })));
            const currentLease = JSON.parse(readFileSync(leaseFile, "utf8")) as Record<string, unknown>;
            writeFileSync(leaseFile, JSON.stringify({ ...currentLease, claimNonce: "successor-physical-stop-nonce" }));
            commandRunner.mockClear();
            const staleStop = await invoke("device_stop");
            expect(staleStop.status).toBe(409);
            expect(await staleStop.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-cleanup-failed",
                result: expect.objectContaining({
                    invoked: false,
                    physicalLeaseCleanup: expect.objectContaining({ ok: false, status: 409 }),
                }),
            }));
            expect(commandRunner).not.toHaveBeenCalled();
            const stateAfterStaleStop = JSON.parse(readFileSync(stateFile, "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(stateAfterStaleStop.devices[0]).toEqual(expect.objectContaining({
                status: "attached",
                appium: expect.objectContaining({ runtimeId: "physical-stop-appium-runtime" }),
                recording: expect.objectContaining({ pid: 12346 }),
            }));
            writeFileSync(leaseFile, JSON.stringify(currentLease));

            const stopped = await invoke("device_stop");
            expect(stopped.status).toBe(200);
            expect(await stopped.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: deviceId,
                        status: "detached",
                        leaseClaimId: null,
                        leaseClaimNonce: null,
                    }),
                    physicalLeaseCleanup: expect.objectContaining({ ok: true, status: 200 }),
                    auxiliaryCleanup: expect.objectContaining({
                        ok: true,
                        appium: expect.objectContaining({ cleared: true }),
                        recording: expect.objectContaining({ cleared: true }),
                    }),
                }),
            }));
            expect(existsSync(leaseFile)).toBe(false);

            const restartedWithoutLease = await invoke("device_start");
            expect(restartedWithoutLease.status).toBe(409);
            expect(await restartedWithoutLease.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-device-not-attached",
            }));

            const deleted = await invoke("device_delete");
            expect(deleted.status).toBe(200);
            expect(await deleted.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ device: null }),
            }));
            const state = JSON.parse(readFileSync(stateFile, "utf8")) as { devices: unknown[] };
            expect(state.devices).toEqual([]);
        } finally {
            await close(server);
        }
    });

    it("fences physical backend tools and broker-managed recording with the exact live lease", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-physical-tool-lease-test");
        const deviceId = "android-physical-tools";
        const serial = "USB-PHYSICAL-TOOLS";
        const claimId = "claim-physical-tools";
        const claimNonce = "nonce-physical-tools";
        const attachedDevice = {
            id: deviceId,
            backend: "android-device",
            physical: true,
            serial,
            status: "attached",
            leaseClaimId: claimId,
            leaseClaimNonce: claimNonce,
        };
        writeBrokerDevices(ownerId, "android-device", [attachedDevice]);
        const leaseDir = join(process.env.HOME!, ".ccc/devices/physical-leases/android-device/locks");
        const leaseFile = join(leaseDir, `${encodeURIComponent(serial)}.json`);
        mkdirSync(leaseDir, { recursive: true });
        writeFileSync(leaseFile, JSON.stringify({
            backend: "android-device",
            hardwareId: serial,
            ownerId,
            deviceId,
            claimId,
            claimNonce,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        const commandRunner = vi.fn(() => ({ mode: "exec", provider: "adb", status: 0, stdout: "", stderr: "" }));
        const deviceToolRunner = vi.fn(async () => ({
            status: 200,
            payload: { ok: true, result: { provider: "test-device-tool" } },
        }));
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-tool-lease-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
            deviceToolRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const invokeRpc = (method: string, params: Record<string, unknown>) => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ method, params }),
        });
        const invoke = (tool: string) => invokeRpc("broker.device.tool.invoke", { tool, backend: "android-device", deviceId });
        const invokeLifecycle = (command: "device_status" | "device_start") => invokeRpc("broker.command.invoke", {
            backend: "android-device",
            command,
            deviceId,
        });
        try {
            const status = await invoke("device_status");
            expect(status.status).toBe(200);
            expect(deviceToolRunner).toHaveBeenCalledTimes(1);
            const lifecycleStatus = await invokeLifecycle("device_status");
            expect(lifecycleStatus.status).toBe(200);
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(JSON.parse(readFileSync(leaseFile, "utf8"))).toEqual(expect.objectContaining({
                ownerId,
                deviceId,
                claimId,
                claimNonce,
                heartbeatAt: expect.any(String),
            }));

            const currentLease = JSON.parse(readFileSync(leaseFile, "utf8")) as Record<string, unknown>;
            writeFileSync(leaseFile, JSON.stringify({ ...currentLease, claimNonce: "successor-tool-nonce" }));

            const exec = await invoke("device_exec");
            expect(exec.status).toBe(409);
            expect(await exec.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-device-not-attached",
                leaseError: "physical-lease-operation-mismatch",
            }));
            expect(deviceToolRunner).toHaveBeenCalledTimes(1);

            const staleLifecycleStatus = await invokeLifecycle("device_status");
            expect(staleLifecycleStatus.status).toBe(409);
            expect(await staleLifecycleStatus.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-device-not-attached",
                leaseError: "physical-lease-operation-mismatch",
            }));
            const staleLifecycleStart = await invokeLifecycle("device_start");
            expect(staleLifecycleStart.status).toBe(409);
            expect(await staleLifecycleStart.json()).toEqual(expect.objectContaining({ ok: false, error: "physical-device-not-attached" }));
            expect(commandRunner).toHaveBeenCalledTimes(1);

            const recordStart = await invoke("device_record_video_start");
            expect(recordStart.status).toBe(409);
            expect(await recordStart.json()).toEqual(expect.objectContaining({ ok: false, error: "physical-device-not-attached" }));
            expect(commandRunner).toHaveBeenCalledTimes(1);

            writeBrokerDevices(ownerId, "android-device", [{
                ...attachedDevice,
                recording: { active: true, pid: 24680, provider: "adb-screenrecord", remotePath: "/sdcard/owned.mp4" },
            }]);
            const recordStop = await invoke("device_record_video_stop");
            expect(recordStop.status).toBe(409);
            expect(await recordStop.json()).toEqual(expect.objectContaining({ ok: false, error: "physical-device-not-attached" }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(killSpy).not.toHaveBeenCalled();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("restores the exact physical lease when lifecycle state persistence fails", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-physical-state-write-failure-test");
        const deviceId = "android-physical-state-write-failure";
        const serial = "USB-PHYSICAL-STATE-WRITE-FAILURE";
        const claimId = "claim-state-write-failure";
        const claimNonce = "nonce-state-write-failure";
        const root = writeBrokerDevices(ownerId, "android-device", [{
            id: deviceId,
            backend: "android-device",
            physical: true,
            serial,
            status: "attached",
            leaseClaimId: claimId,
            leaseClaimNonce: claimNonce,
        }]);
        mkdirSync(join(root, "operations"), { recursive: true });
        const leaseDir = join(process.env.HOME!, ".ccc/devices/physical-leases/android-device/locks");
        const leaseFile = join(leaseDir, `${encodeURIComponent(serial)}.json`);
        mkdirSync(leaseDir, { recursive: true });
        const originalExpiry = new Date(Date.now() + 10_000).toISOString();
        writeFileSync(leaseFile, JSON.stringify({
            backend: "android-device",
            hardwareId: serial,
            ownerId,
            deviceId,
            claimId,
            claimNonce,
            expiresAt: originalExpiry,
        }));
        let failProviderCommand = true;
        let failStateWrite = false;
        const rename = fixtureFs.renameSync;
        vi.spyOn(fixtureFs, "renameSync").mockImplementation((source, target) => {
            if (failStateWrite && String(target) === join(root, "devices.json")) throw Object.assign(new Error("injected state write failure"), { code: "EIO" });
            return rename(source, target);
        });
        const commandRunner = vi.fn((command) => {
            // Persistence failure is injected at commit, independent of host chmod semantics.
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: failProviderCommand && command.provider === "android-device" ? 1 : 0,
                stdout: "",
                stderr: "",
            };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-state-write-failure-test",
            host: "127.0.0.1",
            port: 0,
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const stop = () => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
                method: "broker.command.invoke",
                params: { backend: "android-device", command: "device_stop", deviceId, dryRun: false },
            }),
        });
        try {
            const providerFailed = await stop();
            expect(providerFailed.status).toBe(502);
            expect(await providerFailed.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
            }));
            expect(existsSync(leaseFile)).toBe(true);
            const providerFailureState = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(providerFailureState.devices[0]).toEqual(expect.objectContaining({
                status: "attached",
                leaseClaimId: claimId,
                leaseClaimNonce: claimNonce,
            }));

            failProviderCommand = false;
            failStateWrite = true;
            const failed = await stop();
            expect(failed.status).toBe(500);
            expect(await failed.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-state-write-failed",
                result: expect.objectContaining({
                    leaseRollback: expect.objectContaining({
                        attempted: true,
                        ok: true,
                        lease: expect.objectContaining({ ownerId, deviceId, claimId, claimNonce }),
                    }),
                }),
            }));
            const restoredLease = JSON.parse(readFileSync(leaseFile, "utf8")) as Record<string, unknown>;
            expect(restoredLease).toEqual(expect.objectContaining({ ownerId, deviceId, claimId, claimNonce }));
            expect(Date.parse(String(restoredLease.expiresAt))).toBeGreaterThan(Date.parse(originalExpiry));
            const failedState = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(failedState.devices[0]).toEqual(expect.objectContaining({
                status: "attached",
                leaseClaimId: claimId,
                leaseClaimNonce: claimNonce,
            }));

            chmodSync(root, 0o700);
            failStateWrite = false;
            const recovered = await stop();
            expect(recovered.status).toBe(200);
            expect(existsSync(leaseFile)).toBe(false);
        } finally {
            chmodSync(root, 0o700);
            await close(server);
            cleanupOwner(ownerId);
            rmSync(leaseFile, { force: true });
        }
    });

    it("creates broker-routed macOS VM definitions with owner-scoped provider metadata", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-macos-create-test");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-macos-create-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { tart: "/fake/tart" },
            commandRunner: (command) => ({
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args || [],
                status: 0,
                stdout: "ok",
                stderr: "",
            }),
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const created = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "macos-vm",
                        command: "device_create",
                        name: "Broker Mac",
                        deviceId: "macos-broker-mac",
                        provider: "tart",
                        image: "ccc-macos-base",
                        headless: true,
                    },
                }),
            });
            expect(created.status).toBe(200);
            const body = await created.json() as { result: { device: { id: string; provider: string; providerInstance: string; image: string; status: string; ssh?: { user?: string; password?: string; passwordConfigured?: boolean } }; execution: { providerExecution: string; command?: { provider: string; args: string[] } } } };
            expect(body.result.device).toEqual(expect.objectContaining({
                id: "macos-broker-mac",
                provider: "tart",
                providerInstance: `ccc-${ownerId}-macos-broker-mac`,
                image: "ccc-macos-base",
                status: "stopped",
                headless: true,
                authority: "host-broker",
            }));
            expect(body.result.device.ssh?.user).toBe("admin");
            expect(body.result.device.ssh?.password).toBeUndefined();
            expect(body.result.device.ssh?.passwordConfigured).toBe(true);
            const state = JSON.parse(readFileSync(join(backendRoot(ownerId, "macos"), "devices.json"), "utf8")) as { devices: Array<{ ssh?: { user?: string; password?: string } }> };
            expect(state.devices[0]?.ssh?.user).toBe("admin");
            expect(state.devices[0]?.ssh?.password).toBe("admin");
            expect(body.result.execution.providerExecution).toBe("executed");
            expect(body.result.execution.command).toEqual(expect.objectContaining({
                provider: "tart",
                args: ["clone", "ccc-macos-base", `ccc-${ownerId}-macos-broker-mac`],
            }));

            const startPlan = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "macos-broker-mac" },
                }),
            });
            expect(startPlan.status).toBe(200);
            const plan = await startPlan.json() as { result: { providerCommand: { provider: string; executable: string; args: string[] } } };
            expect(plan.result.providerCommand).toEqual(expect.objectContaining({
                provider: "tart",
                executable: "/fake/tart",
                args: ["run", "--no-graphics", `ccc-${ownerId}-macos-broker-mac`],
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("persists the resolved macOS provider when create uses auto", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-macos-auto-provider-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            status: 0,
            stdout: "ok",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-macos-auto-provider-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { tart: "/fake/tart" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "macos-vm",
                        command: "device_create",
                        name: "Auto Mac",
                        deviceId: "macos-auto-provider",
                        provider: "auto",
                        image: "ccc-macos-base",
                    },
                }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    device: expect.objectContaining({ provider: "tart", providerInstance: `ccc-${ownerId}-macos-auto-provider` }),
                }),
            }));
            const state = JSON.parse(readFileSync(join(backendRoot(ownerId, "macos"), "devices.json"), "utf8")) as { devices: Array<{ provider: string }> };
            expect(state.devices[0].provider).toBe("tart");
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("cleans forced macOS VM metadata when Tart reports the provider instance is already missing", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-macos-delete-missing-provider-test");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-macos-delete-missing-provider-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { tart: "/fake/tart" },
            commandRunner: (command) => ({
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args || [],
                status: 2,
                stdout: "",
                stderr: "the specified VM \"ccc-missing\" does not exist\n",
            }),
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "macos", [
                { id: "mac-gone", provider: "tart", providerInstance: "ccc-missing", status: "stopped" },
            ]);
            const deleted = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "macos-vm", command: "device_delete", deviceId: "mac-gone", force: true },
                }),
            });
            expect(deleted.status).toBe(200);
            const body = await deleted.json() as { ok: boolean; result: { device: unknown; execution: { command: { status: number; stderr: string } } } };
            expect(body.ok).toBe(true);
            expect(body.result.device).toBeNull();
            expect(body.result.execution.command).toEqual(expect.objectContaining({
                status: 2,
                stderr: expect.stringContaining("does not exist"),
            }));
            expect(readFileSync(join(backendRoot(ownerId, "macos"), "devices.json"), "utf8")).toContain("\"devices\": []");
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("routes read-only device inventory and recording status without provider execution", async () => {
        const hostProjectPath = resolve("/project/broker-readonly-device-test");
        const ownerId = deviceLabOwnerId(hostProjectPath);
        const commandRunner = vi.fn();
        const deviceToolRunner = vi.fn((owner, parsed, match) => ({
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId: owner,
                    tool: parsed.tool,
                    deviceId: parsed.deviceId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    provider: "fake-device-tool-runner",
                    mcpResult: { content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }] },
                },
            },
        }));
        const server = createDeviceBrokerServer({
            cwd: hostProjectPath,
            host: "127.0.0.1",
            port: 0,
            commandRunner,
            deviceToolRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices("6162636465666768", "windows", [{
                id: "win-other-owner",
                status: "running",
                backend: "windows-sandbox",
                recording: { active: true, sessionId: "other-rec" },
            }]);
            writeBrokerDevices(ownerId, "windows", [{
                id: "win-readonly",
                status: "running",
                backend: "windows-sandbox",
                recording: { active: true, sessionId: "rec-1", localPath: "C:/recording.zip" },
            }]);

            const inventory = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_inventory", backend: "windows-sandbox" },
                }),
            });
            expect(inventory.status).toBe(200);
            expect(await inventory.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId,
                    tool: "device_inventory",
                    backend: "windows-sandbox",
                    devices: [expect.objectContaining({ id: "win-readonly" })],
                    source: "host-broker-owner-state",
                    startsDevices: false,
                }),
            }));

            const ownerMiss = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_status", deviceId: "win-other-owner" },
                }),
            });
            expect(ownerMiss.status).toBe(404);
            expect(await ownerMiss.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-device-not-found",
                deviceId: "win-other-owner",
            }));

            const status = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_status", deviceId: "win-readonly" },
                }),
            });
            expect(status.status).toBe(200);
            expect(await status.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId,
                    tool: "device_record_video_status",
                    backend: "windows-sandbox",
                    stateKey: "windows",
                    deviceId: "win-readonly",
                    provider: "fake-device-tool-runner",
                    mcpResult: { content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }] },
                }),
            }));

            const screenshot = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_screenshot", deviceId: "win-readonly" },
                }),
            });
            expect(screenshot.status).toBe(200);
            expect(await screenshot.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId,
                    tool: "device_screenshot",
                    backend: "windows-sandbox",
                    stateKey: "windows",
                    mcpResult: { content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }] },
                }),
            }));
            expect(deviceToolRunner).toHaveBeenCalledWith(ownerId, expect.objectContaining({
                tool: "device_screenshot",
                deviceId: "win-readonly",
            }), expect.objectContaining({ stateKey: "windows", backend: "windows-sandbox" }), expect.any(Object));

            const containerAppPath = `${deviceLabProjectMountPath(hostProjectPath)}/dist/App.exe`;
            const hostAppPath = join(hostProjectPath, "dist", "App.exe");
            const upload = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_upload", backend: "windows-sandbox", deviceId: "win-readonly", localPath: containerAppPath, remotePath: "C:\\ccc\\uploads\\App.exe" },
                }),
            });
            expect(upload.status).toBe(200);
            expect(deviceToolRunner).toHaveBeenLastCalledWith(ownerId, expect.objectContaining({
                tool: "device_upload",
                deviceId: "win-readonly",
                localPath: hostAppPath,
                params: expect.objectContaining({ localPath: hostAppPath }),
            }), expect.objectContaining({ stateKey: "windows", backend: "windows-sandbox" }), expect.any(Object));

            const hostPathUpload = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_upload", backend: "windows-sandbox", deviceId: "win-readonly", localPath: hostAppPath, remotePath: "C:\\ccc\\uploads\\Host-App.exe" },
                }),
            });
            expect(hostPathUpload.status).toBe(200);
            expect(deviceToolRunner).toHaveBeenLastCalledWith(ownerId, expect.objectContaining({
                tool: "device_upload",
                deviceId: "win-readonly",
                localPath: hostAppPath,
                params: expect.objectContaining({ localPath: hostAppPath }),
            }), expect.objectContaining({ stateKey: "windows", backend: "windows-sandbox" }), expect.any(Object));

            const callsBeforeRejectedPaths = deviceToolRunner.mock.calls.length;
            for (const params of [
                { tool: "device_upload", localPath: "/etc/hosts", remotePath: "C:\\ccc\\uploads\\hosts" },
                { tool: "device_screenshot", path: "C:\\outside\\capture.png" },
            ]) {
                const rejected = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.device.tool.invoke",
                        params: { backend: "windows-sandbox", deviceId: "win-readonly", ...params },
                    }),
                });
                expect(rejected.status).toBe(400);
                expect(await rejected.json()).toEqual(expect.objectContaining({
                    ok: false,
                    error: "device-tool-path-outside-project-mount",
                }));
            }
            expect(deviceToolRunner).toHaveBeenCalledTimes(callsBeforeRejectedPaths);

            const unsupported = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_install_app", deviceId: "win-readonly" },
                }),
            });
            expect(unsupported.status).toBe(501);
            const unsupportedBody = await unsupported.json() as { supportedTools?: string[] };
            expect(unsupportedBody).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-device-tool-backend-not-supported",
                backend: "windows-sandbox",
                tool: "device_install_app",
                supportedTools: expect.not.arrayContaining(["device_install_app"]),
            }));
            expect(unsupportedBody.supportedTools).toEqual(expect.arrayContaining([
                "device_record_video_status",
                "device_record_video_start",
                "device_record_video_stop",
            ]));
            expect(commandRunner).not.toHaveBeenCalled();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            cleanupOwner("6162636465666768");
        }
    });

    it("keeps broker health responsive while a device tool is running", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-concurrent-device-tool-test");
        let completeTool!: (result: { status: number; payload: unknown }) => void;
        const deviceToolRunner = vi.fn(() => new Promise<{ status: number; payload: unknown }>((resolve) => {
            completeTool = resolve;
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-concurrent-device-tool-test",
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        try {
            writeBrokerDevices(ownerId, "windows", [{ id: "win-slow", status: "running", backend: "windows-sandbox" }]);
            const toolRequest = fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_screenshot", backend: "windows-sandbox", deviceId: "win-slow" },
                }),
            });
            await vi.waitFor(() => expect(deviceToolRunner).toHaveBeenCalledOnce());

            const health = await Promise.race([
                fetch(`${baseUrl}/health`),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("broker health was blocked by device tool")), 250)),
            ]);
            expect(health.status).toBe(200);

            completeTool({ status: 200, payload: { ok: true } });
            expect((await toolRequest).status).toBe(200);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("serializes backend-less device tool requests until backend inference completes", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-inferred-backend-serialization-test");
        const completions: Array<(result: { status: number; payload: unknown }) => void> = [];
        const deviceToolRunner = vi.fn(() => new Promise<{ status: number; payload: unknown }>((resolve) => {
            completions.push(resolve);
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-inferred-backend-serialization-test",
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const invoke = () => fetch(endpoint, {
            method: "POST",
            headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({
                method: "broker.device.tool.invoke",
                params: { tool: "device_screenshot", deviceId: "inferred-backend" },
            }),
        });
        try {
            writeBrokerDevices(ownerId, "windows", [{ id: "inferred-backend", status: "running", backend: "windows-sandbox" }]);
            const first = invoke();
            await vi.waitFor(() => expect(deviceToolRunner).toHaveBeenCalledTimes(1));
            const second = invoke();
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(deviceToolRunner).toHaveBeenCalledTimes(1);

            completions[0]({ status: 200, payload: { ok: true, request: 1 } });
            expect((await first).status).toBe(200);
            await vi.waitFor(() => expect(deviceToolRunner).toHaveBeenCalledTimes(2));
            completions[1]({ status: 200, payload: { ok: true, request: 2 } });
            expect((await second).status).toBe(200);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("locks an inferred Hyper-V device before invoking a backend-less tool", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-inferred-hyper-v-lock-test");
        const deviceId = "inferred-linux-vm";
        const commandRunner = vi.fn(() => { throw new Error("incomplete VM metadata must prevent provider execution"); });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-inferred-hyper-v-lock-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { "powershell.exe": "/fixture/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const operationLock = join(
            backendRoot(ownerId, "linux-vm"),
            "operations",
            `${createHash("sha256").update(deviceId).digest("hex").slice(0, 32)}.lock`,
        );
        let releaseLock!: () => void;
        const held = withSharedMutationLockAsync(operationLock, () => new Promise<void>((resolve) => {
            releaseLock = resolve;
        }), { waitMs: 1000, staleMs: 60_000, heartbeatMs: 50 });
        try {
            writeBrokerDevices(ownerId, "linux-vm", [{ id: deviceId, status: "running", backend: "linux-vm" }]);
            await vi.waitFor(() => expect(releaseLock).toBeTypeOf("function"));
            let requestSettled = false;
            let settledResponse: Response | undefined;
            const request = fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_snapshot_list", deviceId },
                }),
            }).then((response) => {
                settledResponse = response;
                return response;
            }).finally(() => { requestSettled = true; });
            await new Promise((resolve) => setTimeout(resolve, 25));
            const earlyResponse = settledResponse
                ? `HTTP ${settledResponse.status}: ${await settledResponse.clone().text()}`
                : "request must remain pending while its inferred device lock is held";
            expect(requestSettled, earlyResponse).toBe(false);

            releaseLock();
            await held;
            const response = await request;
            expect(response.status).toBe(409);
            expect(await response.json()).toMatchObject({
                ok: false,
                error: "missing-provider-metadata",
                missing: ["vmId", "vmName", "diskPath", "incarnationId"],
                backend: "linux-vm",
                deviceId,
            });
            expect(commandRunner).not.toHaveBeenCalled();
        } finally {
            if (releaseLock) releaseLock();
            await held;
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("times out incomplete HTTP request bodies", async () => {
        const hostProjectPath = resolve("/project/broker-request-body-timeout-test");
        const ownerId = deviceLabOwnerId(hostProjectPath);
        const server = createDeviceBrokerServer({
            cwd: hostProjectPath,
            host: "127.0.0.1",
            port: 0,
            requestBodyTimeoutMs: 50,
        });
        const baseUrl = await listen(server);
        try {
            const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
                const req = request(ownerRpcEndpoint(baseUrl, ownerId), {
                    method: "POST",
                    headers: {
                        ...ownerRpcHeaders(ownerId),
                        "content-type": "application/json",
                        "content-length": "100",
                    },
                }, (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (chunk: Buffer) => chunks.push(chunk));
                    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
                });
                req.on("error", reject);
                req.write("{");
            });
            expect(result.status).toBe(408);
            expect(JSON.parse(result.body)).toEqual(expect.objectContaining({ ok: false, error: "request-body-timeout" }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("adds host ADB visibility to Android physical device inventory", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-physical-inventory-test");
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.join(" ") === "devices -l") {
                return {
                    mode: "exec",
                    provider: "adb",
                    executable: command.executable,
                    args: command.args,
                    status: 0,
                    stdout: "List of devices attached\nUSB123 device product:pixel model:Pixel_8\nUNAUTH unauthorized product:pixel model:Pixel_6\nemulator-5554 device product:sdk_gphone model:sdk_gphone\n",
                    stderr: "",
                };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected command" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-physical-inventory-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android-device", [{
                id: "android-owned",
                backend: "android-device",
                serial: "USB123",
                status: "attached",
            }]);

            const inventory = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_inventory", backend: "android-device" },
                }),
            });
            expect(inventory.status).toBe(200);
            expect(await inventory.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId,
                    backend: "android-device",
                    devices: [expect.objectContaining({ id: "android-owned", serial: "USB123" })],
                    hostDevices: expect.arrayContaining([
                        expect.objectContaining({ serial: "USB123", connection: "usb", state: "device", attachable: true, reason: "ready" }),
                        expect.objectContaining({ serial: "UNAUTH", connection: "usb", state: "unauthorized", attachable: false, reason: "adb-state-unauthorized" }),
                        expect.objectContaining({ serial: "emulator-5554", emulator: true, attachable: false, reason: "emulator-not-physical" }),
                    ]),
                    hostInventory: expect.objectContaining({ ok: true, count: 3 }),
                    source: "host-broker-owner-state",
                    startsDevices: false,
                }),
            }));
            expect(commandRunner).toHaveBeenCalledWith(
                expect.objectContaining({ provider: "adb", args: ["devices", "-l"] }),
                expect.objectContaining({ timeoutMs: 15000 }),
            );
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("provisions owner-scoped Android AVDs before persisting broker metadata", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-create-test");
        let avdCreateCalls = 0;
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb") {
                return {
                    mode: command.mode,
                    provider: command.provider,
                    executable: command.executable,
                    args: command.args,
                    status: 0,
                    stdout: "List of devices attached\n",
                    stderr: "",
                };
            }
            if (command.provider === "process-inventory") {
                return {
                    mode: command.mode,
                    provider: command.provider,
                    executable: command.executable,
                    args: command.args,
                    status: 0,
                    stdout: "",
                    stderr: "",
                };
            }
            avdCreateCalls += 1;
            return avdCreateCalls === 1 ? {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                input: command.input,
                status: 0,
                stdout: "created avd",
                stderr: "",
            } : {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                input: command.input,
                status: 1,
                stdout: "avdmanager progress",
                stderr: "bad system image",
                error: "provider timed out during cleanup",
            };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-create-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "C:\\Android\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const created = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Broker Pixel",
                        deviceId: "android-broker-pixel",
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        deviceProfile: "pixel_6",
                        createAvd: true,
                    },
                }),
            });
            expect(created.status).toBe(200);
            expect(await created.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "android-broker-pixel",
                        avdName: `ccc-${ownerId}-broker-pixel`,
                        port: expect.any(Number),
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        headless: true,
                        status: "stopped",
                        authority: "host-broker",
                    }),
                    execution: expect.objectContaining({
                        mode: "exec",
                        providerExecution: "executed",
                        mutatesHost: true,
                        command: expect.objectContaining({
                            provider: "avdmanager",
                            executable: "C:\\Android\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat",
                            args: ["create", "avd", "--name", `ccc-${ownerId}-broker-pixel`, "--package", "system-images;android-35;google_apis;x86_64", "--force", "--device", "pixel_6"],
                            input: "no\n",
                        }),
                    }),
                }),
            }));
            expect(commandRunner).toHaveBeenNthCalledWith(1, expect.objectContaining({
                provider: "adb", args: ["devices", "-l"],
            }), expect.objectContaining({ timeoutMs: 10000 }));
            expect(commandRunner).toHaveBeenNthCalledWith(2, expect.objectContaining({
                mode: "exec",
                provider: "avdmanager",
                input: "no\n",
            }), expect.objectContaining({ timeoutMs: 300000 }));

            const createdState = JSON.parse(readFileSync(join(backendRoot(ownerId, "android"), "devices.json"), "utf8")) as {
                devices: Array<{ id: string; port: number }>;
            };
            expect(createdState.devices[0].port).toBeGreaterThanOrEqual(5554);
            expect(createdState.devices[0].port).toBeLessThanOrEqual(5682);
            expect(createdState.devices[0].port % 2).toBe(0);

            const failed = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Broken Pixel",
                        deviceId: "android-broken-pixel",
                        systemImage: "system-images;android-999;missing;x86_64",
                        createAvd: true,
                    },
                }),
            });
            expect(failed.status).toBe(502);
            const failedBody = await failed.json();
            expect(failedBody).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
                detail: "error: provider timed out during cleanup\nstderr: bad system image\nstdout: avdmanager progress",
                rollback: { ok: true, artifactsRemoved: 0 },
                result: expect.objectContaining({
                    execution: expect.objectContaining({
                        mutatesHost: false,
                        command: expect.objectContaining({ provider: "avdmanager", status: 1, stderr: "bad system image", error: "provider timed out during cleanup" }),
                    }),
                }),
            }));
            expect(JSON.stringify(failedBody)).not.toContain("avdRoot");

            const invalidPort = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Invalid Port Pixel",
                        deviceId: "android-invalid-port",
                        port: 5555,
                    },
                }),
            });
            expect(invalidPort.status).toBe(400);
            expect(await invalidPort.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "invalid-android-emulator-port",
                allowed: "even integer 5554-5682",
            }));
            expect(avdCreateCalls).toBe(2);

            const state = JSON.parse(readFileSync(join(backendRoot(ownerId, "android"), "devices.json"), "utf8")) as { devices: Array<{ id: string }> };
            expect(state.devices.map((device) => device.id)).toEqual(["android-broker-pixel"]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves failed-create AVD artifacts when a matching emulator process is active", async () => {
        const cwd = "/project/broker-android-active-create-rollback-test";
        const ownerId = deviceLabOwnerId(cwd);
        const avdName = `ccc-${ownerId}-active-create-rollback`;
        const avdRoot = join(process.env.HOME!, ".android", "avd");
        const avdDataPath = join(avdRoot, `${avdName}.avd`);
        const avdIniPath = join(avdRoot, `${avdName}.ini`);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "avdmanager") {
                mkdirSync(avdDataPath, { recursive: true });
                writeFileSync(join(avdDataPath, "userdata-qemu.img"), "active");
                writeFileSync(avdIniPath, `path=${avdDataPath}`);
                return { mode: command.mode, provider: command.provider, status: 1, stdout: "", stderr: "create failed" };
            }
            if (command.provider === "adb") {
                return { mode: command.mode, provider: command.provider, status: 0, stdout: "List of devices attached\n", stderr: "" };
            }
            if (command.provider === "process-inventory") {
                return { mode: command.mode, provider: command.provider, status: 0, stdout: `emulator -avd ${avdName} -port 5680\n`, stderr: "" };
            }
            return { mode: command.mode, provider: command.provider, status: 1, stdout: "", stderr: "unexpected command" };
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Active Create Rollback",
                        deviceId: "android-active-create-rollback",
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        createAvd: true,
                    },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                rollback: { ok: false, error: "android-avd-artifact-cleanup-failed" },
            }));
            expect(existsSync(avdDataPath)).toBe(true);
            expect(existsSync(avdIniPath)).toBe(true);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(avdDataPath, { recursive: true, force: true });
            rmSync(avdIniPath, { force: true });
        }
    });

    it("fails closed before Android AVD creation when another project port inventory is corrupt", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-corrupt-port-inventory-test");
        const foreignOwnerId = "6263646566676869";
        const foreignRoot = writeBrokerDevices(foreignOwnerId, "android", [{
            id: "foreign-emulator",
            backend: "android-emulator",
            port: 5554,
        }]);
        const foreignStateFile = join(foreignRoot, "devices.json");
        writeFileSync(foreignStateFile, "{");
        const commandRunner = vi.fn();
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-corrupt-port-inventory-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Blocked Pixel",
                        deviceId: "android-blocked-pixel",
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        createAvd: true,
                    },
                }),
            });
            expect(response.status).toBe(503);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-emulator-port-inventory-unavailable",
                detail: "owner-devices-state-invalid",
            }));
            expect(commandRunner).not.toHaveBeenCalled();
            expect(readFileSync(foreignStateFile, "utf8")).toBe("{");
            expect(existsSync(join(backendRoot(ownerId, "android"), "devices.json"))).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            cleanupOwner(foreignOwnerId);
        }
    });

    it("rejects a persisted Android AVD root that differs from the host-approved root", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-avd-artifact-cleanup-test");
        const avdName = `ccc-${ownerId}-cleanup`;
        const avdHome = mkdtempSync(join(tmpdir(), "ccc-broker-avd-home-"));
        const replacementAvdHome = mkdtempSync(join(tmpdir(), "ccc-broker-avd-replacement-"));
        const avdDataPath = join(avdHome, `${avdName}.avd`);
        const avdIniPath = join(avdHome, `${avdName}.ini`);
        const previousAvdHome = process.env.ANDROID_AVD_HOME;
        process.env.ANDROID_AVD_HOME = avdHome;
        mkdirSync(avdDataPath);
        writeFileSync(join(avdDataPath, "userdata-qemu.img"), "owned-avd-data");
        writeFileSync(avdIniPath, `path=${avdDataPath}`);
        writeBrokerDevices(ownerId, "android", [{
            id: "android-cleanup",
            backend: "android-emulator",
            status: "stopped",
            avdName,
            avdRoot: avdHome,
            port: 5582,
        }]);
        mkdirSync(join(replacementAvdHome, `${avdName}.avd`));
        writeFileSync(join(replacementAvdHome, `${avdName}.ini`), "replacement");
        process.env.ANDROID_AVD_HOME = replacementAvdHome;
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            stdout: "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-avd-artifact-cleanup-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_delete",
                        deviceId: "android-cleanup",
                        deleteAvd: true,
                    },
                }),
            });
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body).toEqual(expect.objectContaining({
                ok: false,
                error: "android-avd-root-unavailable",
            }));
            expect(JSON.stringify(body)).not.toContain("avdRoot");
            expect(JSON.stringify(body)).not.toContain(avdHome);
            expect(existsSync(avdDataPath)).toBe(true);
            expect(existsSync(avdIniPath)).toBe(true);
            expect(existsSync(join(replacementAvdHome, `${avdName}.avd`))).toBe(true);
            expect(existsSync(join(replacementAvdHome, `${avdName}.ini`))).toBe(true);
            expect(commandRunner).not.toHaveBeenCalled();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(avdHome, { recursive: true, force: true });
            rmSync(replacementAvdHome, { recursive: true, force: true });
            if (previousAvdHome === undefined) delete process.env.ANDROID_AVD_HOME;
            else process.env.ANDROID_AVD_HOME = previousAvdHome;
        }
    });

    it("rejects foreign and live Android AVD deletion before avdmanager execution", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-avd-preflight-test");
        const liveAvdName = `ccc-${ownerId}-live`;
        let adbVisible = true;
        let processVisible = false;
        const commandRunner = vi.fn((command) => {
            const avdIdentity = command.provider === "adb"
                && command.args?.slice(-3).join(" ") === "emu avd name";
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                stdout: command.provider === "process-inventory"
                    ? processVisible ? `emulator -avd ${liveAvdName} -port 5680\n` : ""
                    : command.provider === "adb"
                        ? avdIdentity
                            ? `${liveAvdName}\nOK\n`
                            : adbVisible
                                ? "List of devices attached\nemulator-5582\tdevice\n"
                                : "List of devices attached\n"
                        : "",
                stderr: "",
            };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-avd-preflight-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const invokeDelete = () => fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST",
            headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({
                method: "broker.command.invoke",
                params: {
                    backend: "android-emulator",
                    command: "device_delete",
                    deviceId: "android-preflight",
                    deleteAvd: true,
                },
            }),
        });
        try {
            writeBrokerDevices(ownerId, "android", [{
                id: "android-preflight",
                backend: "android-emulator",
                status: "stopped",
                avdName: "Pixel_User",
                port: 5582,
            }]);
            const foreign = await invokeDelete();
            expect(foreign.status).toBe(400);
            expect(await foreign.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-avd-name-not-owner-scoped",
            }));
            expect(commandRunner).not.toHaveBeenCalled();

            writeBrokerDevices(ownerId, "android", [{
                id: "android-preflight",
                backend: "android-emulator",
                status: "stopped",
                avdName: `ccc-${ownerId}-legacy`,
                port: 5582,
            }]);
            const unpinned = await invokeDelete();
            expect(unpinned.status).toBe(409);
            expect(await unpinned.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-avd-root-unavailable",
            }));
            expect(commandRunner).not.toHaveBeenCalled();

            writeBrokerDevices(ownerId, "android", [{
                id: "android-preflight",
                backend: "android-emulator",
                status: "stopped",
                avdName: liveAvdName,
                avdRoot: process.env.ANDROID_AVD_HOME || join(process.env.HOME!, ".android", "avd"),
                port: 5582,
            }]);
            const live = await invokeDelete();
            expect(live.status).toBe(409);
            expect(await live.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-avd-active",
            }));
            expect(commandRunner).toHaveBeenCalledTimes(2);
            expect(commandRunner.mock.calls[0][0]).toEqual(expect.objectContaining({
                provider: "adb",
                args: ["devices", "-l"],
            }));

            adbVisible = false;
            processVisible = true;
            const preAdb = await invokeDelete();
            expect(preAdb.status).toBe(409);
            expect(await preAdb.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-avd-active",
            }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "process-inventory",
            }), expect.any(Object));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("keeps broker AVD deletion fail-closed across the empty console identity retry", async () => {
        const cwd = "/project/broker-android-console-retry";
        const ownerId = deviceLabOwnerId(cwd);
        const avdName = `ccc-${ownerId}-retry`;
        const avdRoot = process.env.ANDROID_AVD_HOME || join(process.env.HOME!, ".android", "avd");
        const artifact = join(avdRoot, `${avdName}.avd`);
        mkdirSync(artifact, { recursive: true });
        writeFileSync(join(artifact, "userdata-qemu.img"), "retain until identity verified");
        writeBrokerDevices(ownerId, "android", [{ id: "android-retry", backend: "android-emulator", status: "stopped", avdName, avdRoot, port: 5582 }]);
        let retryOutput = "";
        const commandRunner = vi.fn((command) => ({
            ...command, status: 0, stderr: "",
            stdout: command.provider !== "adb" ? ""
                : command.args?.[0] === "devices" ? "List of devices attached\nemulator-5584\tdevice\n"
                    : command.args?.at(-1) === "avd name\navd name" ? retryOutput : "",
        }));
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" }, commandRunner });
        const baseUrl = await listen(server);
        const remove = () => fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST", headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({ method: "broker.command.invoke", params: {
                backend: "android-emulator", command: "device_delete", deviceId: "android-retry", deleteAvd: true,
            } }),
        });
        try {
            for (const [output, status, error] of [
                ["", 503, "android-avd-liveness-unverified"],
                ["Other_Avd\nConflicting_Avd\nOK\n", 503, "android-avd-liveness-unverified"],
                [`${avdName}\n${avdName}\nOK\n`, 409, "android-avd-active"],
            ] as const) {
                retryOutput = output;
                const response = await remove();
                expect(response.status).toBe(status);
                expect(await response.json()).toEqual(expect.objectContaining({ ok: false, error }));
                expect(existsSync(artifact)).toBe(true);
                expect(commandRunner.mock.calls.some(([command]) => command.provider === "avdmanager")).toBe(false);
            }
            retryOutput = "Other_Owners_Avd\nOther_Owners_Avd\nOK\n";
            const response = await remove();
            expect(response.status).toBe(200);
            expect((await response.json()).ok).toBe(true);
            expect(existsSync(artifact)).toBe(false);
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "adb", args: ["-s", "emulator-5584", "emu", "avd name\navd name"],
            }), expect.any(Object));
            expect(commandRunner.mock.calls.some(([command]) => command.provider === "process-inventory")).toBe(true);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(artifact, { recursive: true, force: true });
        }
    });

    it("rejects an explicitly requested Android emulator port allocated to another project", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-port-conflict-test");
        const foreignOwnerId = "6364656667686970";
        writeBrokerDevices(foreignOwnerId, "android", [{
            id: "foreign-emulator",
            backend: "android-emulator",
            port: 5554,
        }]);
        const commandRunner = vi.fn();
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-port-conflict-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Conflicting Pixel",
                        deviceId: "android-conflicting-pixel",
                        port: 5554,
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        createAvd: true,
                    },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-emulator-port-conflict",
                detail: "port-5554-already-allocated",
            }));
            expect(commandRunner).not.toHaveBeenCalled();
            expect(existsSync(join(backendRoot(ownerId, "android"), "devices.json"))).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            cleanupOwner(foreignOwnerId);
        }
    });

    it("rejects a port occupied by a live unmanaged Android emulator before AVD provisioning", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-live-port-conflict-test");
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb") {
                return {
                    mode: command.mode,
                    provider: command.provider,
                    executable: command.executable,
                    args: command.args || [],
                    status: 0,
                    stdout: "List of devices attached\nemulator-5554 device product:sdk_gphone\nUSB123 device product:pixel\n",
                    stderr: "",
                };
            }
            return { mode: command.mode, provider: command.provider, status: 0, stdout: "unexpected", stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-live-port-conflict-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Live Port Conflict",
                        deviceId: "android-live-port-conflict",
                        port: 5554,
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        createAvd: true,
                    },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-emulator-port-conflict",
                detail: "port-5554-already-allocated",
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "adb",
                executable: "/fake/adb",
                args: ["devices", "-l"],
            }), expect.objectContaining({ timeoutMs: 10000 }));
            expect(existsSync(join(backendRoot(ownerId, "android"), "devices.json"))).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("fails closed when live Android emulator port discovery fails", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-live-port-read-failure-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            status: 1,
            stdout: "",
            stderr: "adb server unavailable",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-live-port-read-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Unavailable Live Inventory",
                        deviceId: "android-live-port-read-failure",
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        createAvd: true,
                    },
                }),
            });
            expect(response.status).toBe(503);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-emulator-live-port-inventory-unavailable",
                detail: "adb server unavailable",
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(existsSync(join(backendRoot(ownerId, "android"), "devices.json"))).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("refuses to start when an unmanaged emulator takes the reserved broker port", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-start-port-conflict-test");
        writeBrokerDevices(ownerId, "android", [{
            id: "android-start-port-conflict",
            backend: "android-emulator",
            avdName: `ccc-${ownerId}-start-port-conflict`,
            port: 5554,
            serial: "emulator-5554",
            status: "stopped",
        }]);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb") {
                return {
                    mode: command.mode,
                    provider: command.provider,
                    executable: command.executable,
                    args: command.args || [],
                    status: 0,
                    stdout: "List of devices attached\nemulator-5554 device product:sdk_gphone\n",
                    stderr: "",
                };
            }
            return { mode: command.mode, provider: command.provider, status: 0, stdout: "unexpected", stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-start-port-conflict-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", emulator: "/fake/emulator" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_start",
                        deviceId: "android-start-port-conflict",
                        dryRun: false,
                        waitForBoot: false,
                    },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-emulator-port-conflict",
                detail: "port-5554-already-in-use",
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "adb",
                args: ["devices", "-l"],
            }), expect.objectContaining({ timeoutMs: 10000 }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("serializes Android emulator allocation, provider creation, and owner state claim under the host-global port lock", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-port-lock-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            input: command.input,
            status: 0,
            stdout: command.provider === "adb" ? "List of devices attached\n" : "created avd",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-port-lock-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const lockFile = join(process.env.HOME!, ".ccc", "devices", "broker", "locks", "android-emulator-ports.mutation.lock");
        let releaseLock!: () => void;
        let lockEntered!: () => void;
        const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
        const lockReady = new Promise<void>((resolve) => { lockEntered = resolve; });
        const lockHolder = withSharedMutationLockAsync(lockFile, async () => {
            lockEntered();
            await lockGate;
        });
        await lockReady;
        try {
            let settled = false;
            const request = fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Serialized Pixel",
                        deviceId: "android-serialized-pixel",
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        createAvd: true,
                    },
                }),
            }).then((response) => {
                settled = true;
                return response;
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(settled).toBe(false);
            expect(commandRunner).not.toHaveBeenCalled();
            expect(existsSync(join(backendRoot(ownerId, "android"), "devices.json"))).toBe(false);

            releaseLock();
            await lockHolder;
            const response = await request;
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: "android-serialized-pixel", port: expect.any(Number) }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledTimes(2);
            expect(commandRunner).toHaveBeenNthCalledWith(1, expect.objectContaining({
                provider: "adb", args: ["devices", "-l"],
            }), expect.any(Object));
            expect(commandRunner).toHaveBeenNthCalledWith(2, expect.objectContaining({
                provider: "avdmanager", args: expect.arrayContaining(["create", "avd"]),
            }), expect.any(Object));
        } finally {
            releaseLock();
            await lockHolder;
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("fences a concurrent external create and rolls back only the losing broker AVD", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-create-conflict-test");
        const deviceId = "android-shared-create";
        const winner = {
            id: deviceId,
            name: "External winner",
            backend: "android-emulator",
            avdName: `ccc-${ownerId}-external-winner`,
            port: 5554,
            status: "stopped",
        };
        const commandRunner = vi.fn((command) => {
            if (command.args?.[0] === "create") {
                writeBrokerDevices(ownerId, "android", [winner]);
            }
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args || [],
                status: 0,
                stdout: "ok",
                stderr: "",
            };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-create-conflict-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "Broker loser",
                        deviceId,
                        avdName: `ccc-${ownerId}-broker-loser`,
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        createAvd: true,
                    },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-device-id-conflict",
                field: "id",
                value: deviceId,
                existing: expect.objectContaining({ id: deviceId, avdName: winner.avdName }),
                rollback: expect.objectContaining({ attempted: true, ok: true }),
            }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "adb",
                args: ["devices", "-l"],
            }), expect.any(Object));
            expect(commandRunner.mock.calls.some(([command]) => (
                command.provider === "avdmanager" && command.args?.[0] === "delete"
            ))).toBe(false);
            const state = JSON.parse(readFileSync(join(backendRoot(ownerId, "android"), "devices.json"), "utf8")) as { devices: unknown[] };
            expect(state.devices).toEqual([winner]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rolls back a newly provisioned Android AVD when the final owner state exceeds its limit", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-create-state-limit-test");
        const stateFile = join(backendRoot(ownerId, "android"), "devices.json");
        const nearLimitState = JSON.stringify({
            devices: [{ id: "concurrent-growth", payload: "x".repeat((256 * 1024) - 700) }],
        });
        const commandRunner = vi.fn((command) => {
            if (command.args?.[0] === "create") {
                mkdirSync(dirname(stateFile), { recursive: true });
                writeFileSync(stateFile, nearLimitState);
            }
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args || [],
                status: 0,
                stdout: "ok",
                stderr: "",
            };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-create-state-limit-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_create",
                        name: "State limit loser",
                        deviceId: "android-state-limit-loser",
                        avdName: `ccc-${ownerId}-state-limit-loser`,
                        systemImage: "system-images;android-35;google_apis;x86_64",
                        createAvd: true,
                    },
                }),
            });
            expect(response.status).toBe(413);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-devices-file-too-large",
                rollback: expect.objectContaining({ attempted: true, ok: true }),
            }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "adb",
                args: ["devices", "-l"],
            }), expect.any(Object));
            expect(commandRunner.mock.calls.some(([command]) => (
                command.provider === "avdmanager" && command.args?.[0] === "delete"
            ))).toBe(false);
            expect(readFileSync(stateFile, "utf8")).toBe(nearLimitState);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves false network settings through the real broker child parameter boundary", async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-network-forwarding-"));
        const backendDir = join(fakeRoot, "providers", "backends");
        mkdirSync(backendDir, { recursive: true });
        writeFileSync(join(backendDir, "android.mjs"), `export function handleAndroidTool(tool, args) {
            return { content: [{type: 'text', text: JSON.stringify({ok: true, tool, args})}] };
        }`);
        const ownerId = deviceLabOwnerId(fakeRoot);
        writeBrokerDevices(ownerId, "android", [{ id: "network-phone", backend: "android-emulator", status: "running", port: 5580 }]);
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(fakeRoot);
        const server = createIsolatedBrokerServer({ cwd: fakeRoot, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.device.tool.invoke", params: {
                    tool: "mobile_set_network", backend: "android-emulator", deviceId: "network-phone",
                    airplaneMode: false, wifi: false, data: true, confirmDestructive: true,
                } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(200);
            expect(JSON.parse(body.result.mcpResult.content[0].text)).toMatchObject({
                tool: "mobile_set_network", args: { deviceId: "network-phone", airplaneMode: false, wifi: false, data: true, confirmDestructive: true },
            });
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(fakeRoot, { recursive: true, force: true });
        }
    });

    it("keeps broker desktop device tool child execution independent from short provider command timeouts", async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-device-tool-runner-"));
        const backendDir = join(fakeRoot, "providers", "backends");
        mkdirSync(backendDir, { recursive: true });
        mkdirSync(join(fakeRoot, "dist"), { recursive: true });
        writeFileSync(join(backendDir, "windows-sandbox.mjs"), [
            "export async function handleWindowsTool(tool, args) {",
            "  await new Promise((resolve) => setTimeout(resolve, 30));",
            "  return { content: [{ type: 'text', text: JSON.stringify({ tool, deviceId: args.deviceId, stdout: 'slow child ok', status: 0 }) }] };",
            "}",
        ].join("\n"));
        const ownerId = deviceLabOwnerId(fakeRoot);
        writeBrokerDevices(ownerId, "windows", [{
            id: "win-slow-child",
            backend: "windows-sandbox",
            status: "running",
            sandboxId: "11111111-1111-4111-8111-111111111111",
        }]);
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(fakeRoot);
        const server = createIsolatedBrokerServer({
            cwd: fakeRoot,
            cliPath: join(fakeRoot, "dist", "index.js"),
            host: "127.0.0.1",
            port: 0,
            commandTimeoutMs: 1,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_exec", backend: "windows-sandbox", deviceId: "win-slow-child", command: "Write-Output ok" },
                }),
            });
            expect(response.status).toBe(200);
            const body = await response.json() as { result: { mcpResult: { content: Array<{ text: string }> } } };
            expect(JSON.parse(body.result.mcpResult.content[0].text)).toEqual(expect.objectContaining({
                deviceId: "win-slow-child",
                stdout: "slow child ok",
                status: 0,
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(fakeRoot, { recursive: true, force: true });
        }
    });

    it("routes Windows broker desktop device tools through the Windows backend child handler", async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-windows-device-tool-runner-"));
        const backendDir = join(fakeRoot, "providers", "backends");
        mkdirSync(backendDir, { recursive: true });
        mkdirSync(join(fakeRoot, "dist"), { recursive: true });
        writeFileSync(join(backendDir, "windows-sandbox.mjs"), [
            "export async function handleWindowsTool(tool, args) {",
            "  return { content: [{ type: 'text', text: JSON.stringify({ handler: 'windows', tool, args, legacyEnv: { module: process.env.CCC_DEVICE_LAB_BACKEND_MODULE_URL || null, handler: process.env.CCC_DEVICE_LAB_BACKEND_HANDLER || null, tool: process.env.CCC_DEVICE_LAB_TOOL || null, args: process.env.CCC_DEVICE_LAB_TOOL_ARGS || null } }) }] };",
            "}",
        ].join("\n"));
        const ownerId = deviceLabOwnerId(fakeRoot);
        writeBrokerDevices(ownerId, "windows", [{
            id: "win-child",
            backend: "windows-sandbox",
            status: "running",
            sandboxId: "22222222-2222-4222-8222-222222222222",
        }]);
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(fakeRoot);
        const server = createIsolatedBrokerServer({
            cwd: fakeRoot,
            cliPath: join(fakeRoot, "dist", "index.js"),
            host: "127.0.0.1",
            port: 0,
            commandTimeoutMs: 1,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const rejected = await fetch(endpoint, {
                method: "POST", headers,
                body: JSON.stringify({ method: "broker.device.tool.invoke", params: {
                    tool: "device_focus_window", backend: "windows-sandbox", deviceId: "win-child", handle: "42;id",
                } }),
            });
            expect(rejected.status).toBe(400);
            expect(await rejected.json()).toMatchObject({ error: "window-handle-invalid" });
            const cases: Array<[string, Record<string, unknown>?]> = [
                ["device_exec", { command: "Write-Output ok" }],
                ["device_screenshot"],
                ["device_click", { x: 1, y: 2 }],
                ["device_double_click", { x: 3, y: 4 }],
                ["device_key", { key: "Escape" }],
                ["device_type", { text: "hello" }],
                ["device_scroll", { direction: "down", amount: 2 }],
                ["device_cursor_position"],
                ["device_window_list"],
                ["device_focus_window", { handle: "42" }],
                ["device_accessibility_snapshot", { maxDepth: 1, maxNodes: 10 }],
                ["device_upload", { localPath: "in.txt", remotePath: "C:\\ccc\\in.txt" }],
                ["device_download", { remotePath: "C:\\ccc\\out.txt", localPath: "out.txt" }],
            ];
            for (const [tool, extra = {}] of cases) {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.device.tool.invoke",
                        params: { tool, backend: "windows-sandbox", deviceId: "win-child", ...extra },
                    }),
                });
                expect(response.status).toBe(200);
                const body = await response.json() as { result: { mcpResult: { content: Array<{ text: string }> } } };
                expect(JSON.parse(body.result.mcpResult.content[0].text)).toEqual({
                    handler: "windows",
                    tool,
                    args: { backend: "windows-sandbox", deviceId: "win-child", ...extra },
                    legacyEnv: { module: null, handler: null, tool: null, args: null },
                });
            }
            // The sandbox helper now handles actual pointer movement.
            const move = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_cursor_position", deviceId: "win-child", x: 5, y: 6 },
                }),
            });
            expect(move.status).toBe(200);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(fakeRoot, { recursive: true, force: true });
        }
    });

    it("routes macOS VM broker device tools through the macOS backend child handler", async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-macos-device-tool-runner-"));
        const backendDir = join(fakeRoot, "providers", "backends");
        mkdirSync(backendDir, { recursive: true });
        mkdirSync(join(fakeRoot, "dist"), { recursive: true });
        writeFileSync(join(backendDir, "macos-vm.mjs"), [
            "export async function handleMacosTool(tool, args) {",
            "  return { content: [{ type: 'text', text: JSON.stringify({ handler: 'macos', tool, args, legacyEnv: { module: process.env.CCC_DEVICE_LAB_BACKEND_MODULE_URL || null, handler: process.env.CCC_DEVICE_LAB_BACKEND_HANDLER || null, tool: process.env.CCC_DEVICE_LAB_TOOL || null, args: process.env.CCC_DEVICE_LAB_TOOL_ARGS || null } }) }] };",
            "}",
        ].join("\n"));
        const ownerId = deviceLabOwnerId(fakeRoot);
        writeBrokerDevices(ownerId, "macos", [{
            id: "macos-child",
            backend: "macos-vm",
            status: "running",
            provider: "tart",
            providerInstance: "ccc-macos-child",
        }]);
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(fakeRoot);
        const server = createIsolatedBrokerServer({
            cwd: fakeRoot,
            cliPath: join(fakeRoot, "dist", "index.js"),
            host: "127.0.0.1",
            port: 0,
            commandTimeoutMs: 1,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const cases: Array<[string, Record<string, unknown>?]> = [
                ["device_exec", { command: "uname -a" }],
                ["device_screenshot"],
                ["device_click", { x: 1, y: 2 }],
                ["device_double_click", { x: 3, y: 4 }],
                ["device_key", { key: "Escape" }],
                ["device_type", { text: "hello" }],
                ["device_scroll", { direction: "down", amount: 2 }],
                ["device_cursor_position"],
                ["device_window_list"],
                ["device_focus_window", { handle: "macos:123:456:Test Window" }],
                ["device_accessibility_snapshot", { maxDepth: 1, maxNodes: 10 }],
                ["device_upload", { localPath: "in.txt", remotePath: "/tmp/in.txt" }],
                ["device_download", { remotePath: "/tmp/out.txt", localPath: "out.txt" }],
            ];
            for (const [tool, extra = {}] of cases) {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.device.tool.invoke",
                        params: { tool, backend: "macos-vm", deviceId: "macos-child", ...extra },
                    }),
                });
                expect(response.status).toBe(200);
                const body = await response.json() as { result: { mcpResult: { content: Array<{ text: string }> } } };
                expect(JSON.parse(body.result.mcpResult.content[0].text)).toEqual({
                    handler: "macos",
                    tool,
                    args: { backend: "macos-vm", deviceId: "macos-child", ...extra },
                    legacyEnv: { module: null, handler: null, tool: null, args: null },
                });
            }
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(fakeRoot, { recursive: true, force: true });
        }
    });

    it("routes Android broker device tools through Android backend child handlers", { timeout: process.platform === "win32" ? 120000 : 30000 }, async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-android-device-tool-runner-"));
        const backendDir = join(fakeRoot, "providers", "backends");
        mkdirSync(backendDir, { recursive: true });
        mkdirSync(join(fakeRoot, "dist"), { recursive: true });
        writeFileSync(join(backendDir, "android.mjs"), [
            "export async function handleAndroidTool(tool, args) {",
            "  return { content: [{ type: 'text', text: JSON.stringify({ handler: 'android', tool, args, legacyEnv: { module: process.env.CCC_DEVICE_LAB_BACKEND_MODULE_URL || null, handler: process.env.CCC_DEVICE_LAB_BACKEND_HANDLER || null, tool: process.env.CCC_DEVICE_LAB_TOOL || null, args: process.env.CCC_DEVICE_LAB_TOOL_ARGS || null } }) }] };",
            "}",
        ].join("\n"));
        writeFileSync(join(backendDir, "android-device.mjs"), [
            "export async function handleAndroidRealTool(tool, args) {",
            "  return { content: [{ type: 'text', text: JSON.stringify({ handler: 'android-real', tool, args, legacyEnv: { module: process.env.CCC_DEVICE_LAB_BACKEND_MODULE_URL || null, handler: process.env.CCC_DEVICE_LAB_BACKEND_HANDLER || null, tool: process.env.CCC_DEVICE_LAB_TOOL || null, args: process.env.CCC_DEVICE_LAB_TOOL_ARGS || null } }) }] };",
            "}",
        ].join("\n"));
        const ownerId = deviceLabOwnerId(fakeRoot);
        writeBrokerDevices(ownerId, "android", [{
            id: "android-child",
            backend: "android-emulator",
            status: "running",
            port: 5580,
        }]);
        writeBrokerDevices(ownerId, "android-device", [{
            id: "android-real-child",
            backend: "android-device",
            status: "attached",
            serial: "real-serial",
            leaseClaimId: "android-real-child-claim",
            leaseClaimNonce: "android-real-child-nonce",
        }]);
        const androidLeaseDir = join(process.env.HOME!, ".ccc/devices/physical-leases/android-device/locks");
        mkdirSync(androidLeaseDir, { recursive: true });
        writeFileSync(join(androidLeaseDir, `${encodeURIComponent("real-serial")}.json`), JSON.stringify({
            backend: "android-device",
            hardwareId: "real-serial",
            ownerId,
            deviceId: "android-real-child",
            claimId: "android-real-child-claim",
            claimNonce: "android-real-child-nonce",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        const containerApkPath = `${deviceLabProjectMountPath(fakeRoot)}/build/Test.apk`;
        const hostApkPath = join(fakeRoot, "build", "Test.apk");
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(fakeRoot);
        const server = createIsolatedBrokerServer({
            cwd: fakeRoot,
            cliPath: join(fakeRoot, "dist", "index.js"),
            host: "127.0.0.1",
            port: 0,
            commandTimeoutMs: 1,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const expectInvoke = async (backend: string, deviceId: string, handler: string, tool: string, extra: Record<string, unknown> = {}, expectedExtra: Record<string, unknown> = extra) => {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.device.tool.invoke",
                        params: { tool, backend, deviceId, ...extra },
                    }),
                });
                expect(response.status).toBe(200);
                const body = await response.json() as { result: { mcpResult: { content: Array<{ text: string }> } } };
                expect(JSON.parse(body.result.mcpResult.content[0].text)).toEqual({
                    handler,
                    tool,
                    args: { backend, deviceId, ...expectedExtra },
                    legacyEnv: { module: null, handler: null, tool: null, args: null },
                });
            };

            const androidTools: Array<[string, Record<string, unknown>?, Record<string, unknown>?]> = [
                ["device_status"],
                ["device_exec", { command: "echo ok" }],
                ["device_screenshot"],
                ["device_upload", { localPath: "in.txt", remotePath: "/sdcard/in.txt" }],
                ["device_download", { remotePath: "/sdcard/out.txt", localPath: "out.txt" }],
                ["device_reset", { packageName: "com.example.app", confirmDestructive: true }],
                ["device_install_app", { path: containerApkPath, replace: false }, { path: hostApkPath, replace: false }],
                ["device_launch_app", { packageName: "com.example.app" }],
                ["mobile_session_status"],
                ["mobile_dump_ui"],
                ["mobile_tap", { x: 15, y: 25 }],
                ["mobile_double_tap", { x: 16, y: 26 }],
                ["mobile_long_press", { x: 17, y: 27, durationMs: 500 }],
                ["mobile_swipe", { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 100 }],
                ["mobile_drag", { x1: 5, y1: 6, x2: 7, y2: 8, durationMs: 200 }],
                ["mobile_type_text", { text: "hello" }],
                ["mobile_key", { keyCode: 4 }],
                ["mobile_home"],
                ["mobile_back"],
                ["mobile_forward"],
                ["mobile_recents"],
                ["mobile_power"],
                ["mobile_lock"],
                ["mobile_unlock"],
                ["mobile_rotate_left"],
                ["mobile_rotate_right"],
                ["mobile_set_orientation", { orientation: "portrait" }],
                ["mobile_open_url", { url: "https://example.test" }],
                ["mobile_install_app", { path: containerApkPath }, { path: hostApkPath }],
                ["mobile_launch_app", { packageName: "com.example.mobile" }],
                ["mobile_uninstall_app", { packageName: "com.example.mobile", confirmDestructive: true }],
                ["mobile_stop_app", { packageName: "com.example.mobile" }],
                ["mobile_clear_app_data", { packageName: "com.example.mobile", confirmDestructive: true }],
                ["mobile_grant_permission", { packageName: "com.example.mobile", permission: "android.permission.CAMERA" }],
                ["mobile_revoke_permission", { packageName: "com.example.mobile", permission: "android.permission.CAMERA" }],
                ["mobile_set_location", { latitude: 37.7749, longitude: -122.4194 }],
                ["mobile_set_battery", { level: 42, charging: true }],
                ["mobile_set_network", { wifi: true, data: false, confirmDestructive: true }],
                ["mobile_toggle_airplane_mode", { enabled: false, confirmDestructive: true }],
                ["mobile_set_clipboard", { text: "clip" }],
                ["mobile_get_clipboard"],
                ["mobile_wait_for_text", { text: "Ready", timeoutMs: 1, intervalMs: 50 }],
                ["mobile_wait_for_app", { packageName: "com.example.mobile", timeoutMs: 1 }],
                ["mobile_screenshot"],
            ];
            const androidPhysicalUnsupportedBaseTools = new Set([
                "mobile_set_location",
                "mobile_set_battery",
                "mobile_set_network",
                "mobile_toggle_airplane_mode",
            ]);
            for (const [tool, extra, expectedExtra] of androidTools) {
                await expectInvoke("android-emulator", "android-child", "android", tool, extra, expectedExtra);
                if (!androidPhysicalUnsupportedBaseTools.has(tool)) {
                    await expectInvoke("android-device", "android-real-child", "android-real", tool, extra, expectedExtra);
                }
            }
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(fakeRoot, { recursive: true, force: true });
        }
    });

    it("routes iOS broker device tools through iOS backend child handlers", { timeout: process.platform === "win32" ? 120000 : 30000 }, async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-ios-device-tool-runner-"));
        const backendDir = join(fakeRoot, "providers", "backends");
        mkdirSync(backendDir, { recursive: true });
        mkdirSync(join(fakeRoot, "dist"), { recursive: true });
        writeFileSync(join(backendDir, "ios-simulator.mjs"), [
            "export async function handleIosTool(tool, args) {",
            "  return { content: [{ type: 'text', text: JSON.stringify({ handler: 'ios', tool, args, legacyEnv: { module: process.env.CCC_DEVICE_LAB_BACKEND_MODULE_URL || null, handler: process.env.CCC_DEVICE_LAB_BACKEND_HANDLER || null, tool: process.env.CCC_DEVICE_LAB_TOOL || null, args: process.env.CCC_DEVICE_LAB_TOOL_ARGS || null } }) }] };",
            "}",
        ].join("\n"));
        writeFileSync(join(backendDir, "ios-device.mjs"), [
            "export async function handleIosRealTool(tool, args) {",
            "  return { content: [{ type: 'text', text: JSON.stringify({ handler: 'ios-real', tool, args, legacyEnv: { module: process.env.CCC_DEVICE_LAB_BACKEND_MODULE_URL || null, handler: process.env.CCC_DEVICE_LAB_BACKEND_HANDLER || null, tool: process.env.CCC_DEVICE_LAB_TOOL || null, args: process.env.CCC_DEVICE_LAB_TOOL_ARGS || null } }) }] };",
            "}",
        ].join("\n"));
        const ownerId = deviceLabOwnerId(fakeRoot);
        writeBrokerDevices(ownerId, "ios", [{
            id: "ios-sim-child",
            backend: "ios-simulator",
            status: "running",
            udid: "SIM-CHILD",
        }]);
        writeBrokerDevices(ownerId, "ios-device", [{
            id: "ios-real-child",
            backend: "ios-device",
            status: "attached",
            udid: "REAL-CHILD",
            leaseClaimId: "ios-real-child-claim",
            leaseClaimNonce: "ios-real-child-nonce",
        }]);
        const iosLeaseDir = join(process.env.HOME!, ".ccc/devices/physical-leases/ios-device/locks");
        mkdirSync(iosLeaseDir, { recursive: true });
        writeFileSync(join(iosLeaseDir, `${encodeURIComponent("REAL-CHILD")}.json`), JSON.stringify({
            backend: "ios-device",
            hardwareId: "REAL-CHILD",
            ownerId,
            deviceId: "ios-real-child",
            claimId: "ios-real-child-claim",
            claimNonce: "ios-real-child-nonce",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(fakeRoot);
        const server = createIsolatedBrokerServer({
            cwd: fakeRoot,
            cliPath: join(fakeRoot, "dist", "index.js"),
            host: "127.0.0.1",
            port: 0,
            commandTimeoutMs: 1,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const expectInvoke = async (backend: string, deviceId: string, handler: string, tool: string, extra: Record<string, unknown> = {}) => {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.device.tool.invoke",
                        params: { tool, backend, deviceId, ...extra },
                    }),
                });
                expect(response.status).toBe(200);
                const body = await response.json() as { result: { mcpResult: { content: Array<{ text: string }> } } };
                expect(JSON.parse(body.result.mcpResult.content[0].text)).toEqual({
                    handler,
                    tool,
                    args: { backend, deviceId, ...extra },
                    legacyEnv: { module: null, handler: null, tool: null, args: null },
                });
            };

            const iosSimulatorTools: Array<[string, Record<string, unknown>?]> = [
                ["device_status"],
                ["device_exec", { command: "echo ios" }],
                ["device_screenshot"],
                ["device_upload", { localPath: "in.txt", remotePath: "/tmp/in.txt" }],
                ["device_download", { remotePath: "/tmp/out.txt", localPath: "out.txt" }],
                ["device_reset", { bundleId: "com.example.Sim", confirmDestructive: true }],
                ["device_install_app", { path: "Test.app" }],
                ["device_launch_app", { bundleId: "com.example.Sim" }],
                ["mobile_open_url", { url: "https://example.test" }],
                ["mobile_install_app", { path: "Mobile.app" }],
                ["mobile_launch_app", { bundleId: "com.example.Mobile" }],
                ["mobile_screenshot"],
                ["mobile_session_status"],
                ["mobile_dump_ui"],
                ["mobile_tap", { x: 11, y: 22 }],
                ["mobile_double_tap", { x: 12, y: 23 }],
                ["mobile_long_press", { x: 13, y: 24, durationMs: 500 }],
                ["mobile_swipe", { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 100 }],
                ["mobile_drag", { x1: 5, y1: 6, x2: 7, y2: 8, durationMs: 200 }],
                ["mobile_type_text", { text: "hello" }],
                ["mobile_key", { keyCode: 4 }],
                ["mobile_home"],
                ["mobile_lock"],
                ["mobile_unlock"],
                ["mobile_rotate_left"],
                ["mobile_rotate_right"],
                ["mobile_set_orientation", { orientation: "portrait" }],
                ["mobile_uninstall_app", { bundleId: "com.example.Mobile", confirmDestructive: true }],
                ["mobile_stop_app", { bundleId: "com.example.Mobile" }],
                ["mobile_clear_app_data", { bundleId: "com.example.Mobile", confirmDestructive: true }],
                ["mobile_grant_permission", { bundleId: "com.example.Mobile", service: "camera" }],
                ["mobile_revoke_permission", { bundleId: "com.example.Mobile", service: "camera" }],
                ["mobile_set_location", { latitude: 37.7749, longitude: -122.4194 }],
                ["mobile_set_clipboard", { text: "clip" }],
                ["mobile_get_clipboard"],
                ["mobile_wait_for_text", { text: "Ready", timeoutMs: 1, intervalMs: 50 }],
                ["mobile_wait_for_app", { bundleId: "com.example.Mobile", timeoutMs: 1 }],
            ];
            for (const [tool, extra] of iosSimulatorTools) {
                await expectInvoke("ios-simulator", "ios-sim-child", "ios", tool, extra);
            }

            const iosRealTools: Array<[string, Record<string, unknown>?]> = [
                ["device_status"],
                ["device_screenshot"],
                ["device_install_app", { path: "Real.app" }],
                ["device_launch_app", { bundleId: "com.example.Real" }],
                ["mobile_install_app", { path: "MobileReal.app" }],
                ["mobile_launch_app", { bundleId: "com.example.MobileReal" }],
                ["mobile_screenshot"],
                ["mobile_session_status"],
                ["mobile_dump_ui"],
                ["mobile_tap", { x: 31, y: 32 }],
                ["mobile_double_tap", { x: 33, y: 34 }],
                ["mobile_long_press", { x: 35, y: 36, durationMs: 500 }],
                ["mobile_swipe", { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 100 }],
                ["mobile_drag", { x1: 5, y1: 6, x2: 7, y2: 8, durationMs: 200 }],
                ["mobile_type_text", { text: "hello real" }],
                ["mobile_key", { keyCode: 4 }],
                ["mobile_home"],
                ["mobile_lock"],
                ["mobile_unlock"],
                ["mobile_rotate_left"],
                ["mobile_rotate_right"],
                ["mobile_set_orientation", { orientation: "landscape" }],
                ["mobile_wait_for_text", { text: "Ready", timeoutMs: 1, intervalMs: 50 }],
                ["mobile_wait_for_app", { bundleId: "com.example.MobileReal", timeoutMs: 1 }],
                ["mobile_stop_app", { bundleId: "com.example.MobileReal" }],
            ];
            for (const [tool, extra] of iosRealTools) {
                await expectInvoke("ios-device", "ios-real-child", "ios-real", tool, extra);
            }
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(fakeRoot, { recursive: true, force: true });
        }
    });

    it("rejects forged iOS Simulator identities before starting recordings", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-ios-owner-fence-test");
        const simulatorName = `ccc-${ownerId}-forged-alias`;
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            stdout: command.provider === "xcrun" && command.args?.join(" ") === "simctl list devices -j"
                ? JSON.stringify({ devices: { runtime: [{ name: "foreign-simulator", udid: "FOREIGN-UDID", state: "Booted" }] } })
                : "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-recording-ios-owner-fence-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { xcrun: "/fake/xcrun" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "ios", [{
            id: "ios-forged",
            status: "booted",
            backend: "ios-simulator",
            simulatorName,
            udid: "FOREIGN-UDID",
        }]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_start", backend: "ios-simulator", deviceId: "ios-forged" },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "ios-simulator-owner-identity-mismatch",
                backend: "ios-simulator",
                deviceId: "ios-forged",
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(commandRunner.mock.calls.some(([command]) => command.args?.includes("recordVideo"))).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("starts and stops broker-owned Android recordings without touching foreign owner devices", async () => {
        const hostProjectPath = join(process.env.HOME!, "broker-recording-test");
        mkdirSync(hostProjectPath, { recursive: true });
        const ownerA = deviceLabOwnerId(hostProjectPath);
        const containerRecordingPath = `${deviceLabProjectMountPath(hostProjectPath)}/artifacts/owned.mp4`;
        const hostRecordingPath = join(hostProjectPath, "artifacts", "owned.mp4");
        const ownerB = "bbbbaaaaddddcccc";
        const commands: unknown[] = [];
        const commandRunner = vi.fn((command) => {
            commands.push(command);
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                pid: command.mode === "detached" ? 24680 : undefined,
                stdout: "ok",
                stderr: "",
            };
        });
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: hostProjectPath,
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpointA = ownerRpcEndpoint(baseUrl, ownerA);
        const headersA = ownerRpcHeaders(ownerA);
        try {
            writeBrokerDevices(ownerA, "android", [{
                id: "pixel-record",
                status: "running",
                backend: "android-emulator",
                port: 5580,
            }]);
            writeBrokerDevices(ownerB, "android", [{
                id: "pixel-record",
                status: "running",
                backend: "android-emulator",
                port: 5590,
                recording: { active: true, owner: "foreign" },
            }]);

            const unauthenticated = await fetch(endpointA, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_start", backend: "android-emulator", deviceId: "pixel-record" },
                }),
            });
            expect(unauthenticated.status).toBe(401);
            expect(await unauthenticated.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-owner-token" }));
            expect(commandRunner).not.toHaveBeenCalled();

            const start = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: {
                        tool: "device_record_video_start",
                        backend: "android-emulator",
                        deviceId: "pixel-record",
                        remotePath: "/sdcard/owned.mp4",
                        localPath: containerRecordingPath,
                        timeLimitSec: 12,
                    },
                }),
            });
            expect(start.status, JSON.stringify(await start.clone().json())).toBe(200);
            expect(await start.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId: ownerA,
                    tool: "device_record_video_start",
                    backend: "android-emulator",
                    stateKey: "android",
                    provider: "adb-screenrecord",
                    startsDevices: false,
                    recording: expect.objectContaining({
                        active: true,
                        authority: "host-broker",
                        processOwner: "host-broker",
                        remotePath: "/sdcard/owned.mp4",
                        localPath: hostRecordingPath,
                        timeLimitSec: 12,
                        pid: 24680,
                    }),
                }),
            }));
            expect(commandRunner).toHaveBeenNthCalledWith(1, expect.objectContaining({
                mode: "detached",
                provider: "adb",
                executable: "/fake/adb",
                args: ["-s", "emulator-5580", "shell", "screenrecord", "--time-limit", "12", "/sdcard/owned.mp4"],
            }), expect.any(Object));

            const duplicate = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_start", backend: "android-emulator", deviceId: "pixel-record" },
                }),
            });
            expect(duplicate.status).toBe(409);
            expect(await duplicate.json()).toEqual(expect.objectContaining({ ok: false, error: "recording-already-active" }));

            const stop = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_stop", backend: "android-emulator", deviceId: "pixel-record" },
                }),
            });
            expect(stop.status).toBe(200);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    stopped: true,
                    recording: expect.objectContaining({ active: false, localPath: hostRecordingPath }),
                    device: expect.objectContaining({ id: "pixel-record", recording: null }),
                }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
            expect(commands).toEqual([
                expect.objectContaining({ args: ["-s", "emulator-5580", "shell", "screenrecord", "--time-limit", "12", "/sdcard/owned.mp4"] }),
                expect.objectContaining({ args: ["-s", "emulator-5580", "shell", "pkill", "-2", "screenrecord"] }),
                expect.objectContaining({ args: ["-s", "emulator-5580", "pull", "/sdcard/owned.mp4", hostRecordingPath] }),
                expect.objectContaining({ args: ["-s", "emulator-5580", "shell", "rm", "-f", "/sdcard/owned.mp4"] }),
            ]);
            expect(JSON.parse(readFileSync(join(backendRoot(ownerA, "android"), "devices.json"), "utf8")).devices[0].recording).toBeNull();
            expect(JSON.parse(readFileSync(join(backendRoot(ownerB, "android"), "devices.json"), "utf8")).devices[0].recording).toEqual({ active: true, owner: "foreign" });
        } finally {
            await close(server);
            cleanupOwner(ownerA);
            cleanupOwner(ownerB);
        }
    });

    it("routes guest-helper recording providers through the backend tool runner", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-helper-test");
        const deviceToolRunner = vi.fn(async (_ownerId, parsed, match) => {
            const key = createHash("sha256").update(String(parsed.deviceId)).digest("hex").slice(0, 32);
            const lockFile = join(backendRoot(ownerId, "windows"), "operations", `${key}.lock`);
            return withSharedMutationLockAsync(lockFile, async () => ({
                status: 200,
                payload: {
                    ok: true,
                    result: {
                        ownerId,
                        tool: parsed.tool,
                        backend: match.backend,
                        deviceId: parsed.deviceId,
                    },
                },
            }), { waitMs: 100, staleMs: 1000 });
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-recording-helper-test",
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "windows", [{
                id: "win-record",
                status: "running",
                backend: "windows-sandbox",
            }]);
            for (const tool of ["device_record_video_start", "device_record_video_status", "device_record_video_stop"]) {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.device.tool.invoke",
                        params: { tool, backend: "windows-sandbox", deviceId: "win-record" },
                    }),
                });
                expect(response.status).toBe(200);
                expect(await response.json()).toEqual(expect.objectContaining({
                    ok: true,
                    result: expect.objectContaining({ tool, backend: "windows-sandbox", deviceId: "win-record" }),
                }));
            }
            expect(deviceToolRunner).toHaveBeenCalledTimes(3);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rolls back a newly launched recording instead of overwriting a concurrent successor", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-start-generation-race-test");
        const successor = {
            active: true,
            authority: "host-broker",
            processOwner: "host-broker",
            startedBy: "broker.device.recording.start",
            runtimeId: "successor-recording-generation",
            provider: "adb-screenrecord",
            pid: 31001,
            remotePath: "/sdcard/successor.mp4",
            startedAt: "2026-07-14T00:00:00.000Z",
        };
        let root = "";
        const commandRunner = vi.fn((command) => {
            writeFileSync(join(root, "devices.json"), JSON.stringify({
                devices: [{ id: "pixel-record-raced", status: "running", backend: "android-emulator", port: 5586, recording: successor }],
            }));
            return { mode: command.mode, provider: command.provider, executable: command.executable, args: command.args, status: 0, pid: 31002, stdout: "", stderr: "" };
        });
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-recording-start-generation-race-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        root = writeBrokerDevices(ownerId, "android", [{ id: "pixel-record-raced", status: "running", backend: "android-emulator", port: 5586 }]);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_start", backend: "android-emulator", deviceId: "pixel-record-raced" },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "recording-runtime-state-conflict",
                currentRecording: expect.objectContaining({ runtimeId: successor.runtimeId, pid: 31001 }),
                rollback: expect.objectContaining({ attempted: false, ok: true, simulated: true }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
            expect(JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].recording).toEqual(successor);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves a concurrent recording successor while the previous recording stops", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-stop-generation-race-test");
        const previous = {
            active: true,
            authority: "host-broker",
            processOwner: "host-broker",
            startedBy: "broker.device.recording.start",
            runtimeId: "previous-recording-generation",
            provider: "adb-screenrecord",
            pid: 32001,
            remotePath: "/sdcard/previous.mp4",
            startedAt: "2026-07-14T00:00:00.000Z",
        };
        const successor = { ...previous, runtimeId: "successor-recording-generation", pid: 32002, remotePath: "/sdcard/successor.mp4" };
        let root = "";
        const commandRunner = vi.fn((command) => {
            if (command.args?.includes("pkill")) {
                writeFileSync(join(root, "devices.json"), JSON.stringify({
                    devices: [{ id: "pixel-record-raced", status: "running", backend: "android-emulator", port: 5588, recording: successor }],
                }));
            }
            return { mode: command.mode, provider: command.provider, executable: command.executable, args: command.args, status: 0, stdout: "", stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-recording-stop-generation-race-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        root = writeBrokerDevices(ownerId, "android", [{ id: "pixel-record-raced", status: "running", backend: "android-emulator", port: 5588, recording: previous }]);
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_stop", backend: "android-emulator", deviceId: "pixel-record-raced" },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "recording-runtime-state-conflict",
                currentRecording: expect.objectContaining({ runtimeId: successor.runtimeId, pid: 32002 }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
            expect(JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].recording).toEqual(successor);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("reports Android physical device broker recording provider consistently", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-provider-test");
        const server = createDeviceBrokerServer({ cwd: "/project/broker-recording-provider-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android-device", [{
                id: "android-real-record",
                status: "attached",
                backend: "android-device",
                serial: "real-serial",
            }]);
            const status = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_status", backend: "android-device", deviceId: "android-real-record" },
                }),
            });
            expect(status.status).toBe(200);
            expect(await status.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    backend: "android-device",
                    stateKey: "android-device",
                    provider: "adb-screenrecord",
                    supported: true,
                }),
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("clears broker recording status when its pid has been reused", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-reused-pid-test");
        const server = createDeviceBrokerServer({ cwd: "/project/broker-recording-reused-pid-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            const current = readDeviceRuntimeProcessIdentity(process.pid);
            if (!current) throw new Error("current process identity unavailable");
            writeBrokerDevices(ownerId, "android", [{
                id: "android-reused-recording-pid",
                status: "running",
                backend: "android-emulator",
                port: 5584,
                recording: {
                    active: true,
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.device.recording.start",
                    runtimeId: "stale-runtime",
                    pid: process.pid,
                    processIdentity: { ...current, startToken: `${current.startToken}-stale` },
                },
            }]);
            const status = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_status", backend: "android-emulator", deviceId: "android-reused-recording-pid" },
                }),
            });
            expect(status.status).toBe(200);
            expect(await status.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ recording: null }),
            }));
            expect(JSON.parse(readFileSync(join(backendRoot(ownerId, "android"), "devices.json"), "utf8")).devices[0].recording).toBeNull();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("refuses to stop a broker recording when its pid has been reused", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-reused-pid-stop-test");
        const current = readDeviceRuntimeProcessIdentity(process.pid);
        if (!current) throw new Error("current process identity unavailable");
        const recording = {
            active: true,
            authority: "host-broker",
            processOwner: "host-broker",
            startedBy: "broker.device.recording.start",
            runtimeId: "stale-stop-runtime",
            pid: process.pid,
            processIdentity: { ...current, startToken: `${current.startToken}-stale` },
        };
        writeBrokerDevices(ownerId, "android", [{
            id: "android-reused-recording-stop",
            status: "running",
            backend: "android-emulator",
            port: 5584,
            recording,
        }]);
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-recording-reused-pid-stop-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_stop", backend: "android-emulator", deviceId: "android-reused-recording-stop" },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "recording-stop-signal-failed",
                signal: expect.objectContaining({
                    attempted: false,
                    ok: false,
                    reason: "runtime-process-identity-mismatch",
                }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
            expect(JSON.parse(readFileSync(join(backendRoot(ownerId, "android"), "devices.json"), "utf8")).devices[0].recording).toEqual(recording);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("does not persist broker recording state when the detached provider exits before ready", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-early-exit-test");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-recording-early-exit-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: process.execPath },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android", [{
                id: "pixel-early-exit",
                status: "running",
                backend: "android-emulator",
                port: 5582,
            }]);
            const start = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_start", backend: "android-emulator", deviceId: "pixel-early-exit" },
                }),
            });
            expect(start.status).toBe(502);
            expect(await start.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "recording-start-failed",
                execution: expect.objectContaining({
                    provider: "adb",
                    error: expect.stringContaining("exited before it was ready"),
                }),
            }));
            expect(JSON.parse(readFileSync(join(backendRoot(ownerId, "android"), "devices.json"), "utf8")).devices[0].recording).toBeUndefined();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    // This real-runner fixture requires POSIX shell traps and process-group signals.
    it.skipIf(process.platform === "win32")("persists process identity for a default-runner broker recording", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-process-identity-test");
        const fakeAdb = join(process.env.HOME || tmpdir(), "fake-adb-recording");
        writeFileSync(fakeAdb, "#!/bin/sh\ntrap 'exit 0' INT TERM\nwhile :; do sleep 1; done\n");
        chmodSync(fakeAdb, 0o755);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-recording-process-identity-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: fakeAdb },
        });
        const baseUrl = await listen(server);
        let recorderPid: number | null = null;
        try {
            writeBrokerDevices(ownerId, "android", [{
                id: "pixel-process-identity",
                status: "running",
                backend: "android-emulator",
                port: 5582,
            }]);
            const start = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_start", backend: "android-emulator", deviceId: "pixel-process-identity" },
                }),
            });
            expect(start.status).toBe(200);
            const body = await start.json() as { result: { recording: { pid: number; runtimeId: string; processIdentity: { pid: number; startToken: string; commandHash: string } } } };
            recorderPid = body.result.recording.pid;
            expect(body.result.recording).toEqual(expect.objectContaining({
                runtimeId: expect.any(String),
                processIdentity: expect.objectContaining({
                    pid: recorderPid,
                    startToken: expect.any(String),
                    commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                }),
            }));
            expect(body.result.recording.processIdentity).not.toHaveProperty("commandLine");
        } finally {
            if (recorderPid) {
                try { process.kill(recorderPid, "SIGTERM"); } catch { /* already gone */ }
            }
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    // This real-runner fixture requires POSIX shell traps and process-group signals.
    it.skipIf(process.platform === "win32")("finalizes Android recording when the owned host recorder exits but remote pkill is denied", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-pkill-denied-test");
        const fakeAdb = join(process.env.HOME || tmpdir(), "fake-adb-pkill-denied");
        const localPath = join(process.env.HOME || tmpdir(), "recording.mp4");
        writeFileSync(fakeAdb, [
            "#!/bin/sh",
            "if [ \"$4\" = \"pkill\" ]; then echo 'Operation not permitted' >&2; exit 1; fi",
            "if [ \"$3\" = \"pull\" ]; then printf 'video' > \"$5\"; exit 0; fi",
            "exit 0",
            "",
        ].join("\n"));
        chmodSync(fakeAdb, 0o755);
        const recorder = spawn("sh", ["-c", "trap 'exit 0' INT TERM; while :; do sleep 1; done"], {
            detached: true,
            stdio: "ignore",
        });
        recorder.unref();
        const processIdentity = readDeviceRuntimeProcessIdentity(recorder.pid);
        if (!processIdentity) throw new Error("recorder process identity unavailable");
        writeBrokerDevices(ownerId, "android", [{
            id: "pixel-pkill-denied",
            status: "running",
            backend: "android-emulator",
            port: 5584,
            recording: {
                active: true,
                provider: "adb-screenrecord",
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.device.recording.start",
                runtimeId: "pkill-denied-runtime",
                pid: recorder.pid,
                processIdentity,
                remotePath: "/sdcard/denied.mp4",
                localPath,
            },
        }]);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-recording-pkill-denied-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: fakeAdb },
        });
        const baseUrl = await listen(server);
        try {
            const stop = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_stop", backend: "android-emulator", deviceId: "pixel-pkill-denied" },
                }),
            });
            expect(stop.status).toBe(200);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    stopped: true,
                    signal: expect.objectContaining({ attempted: true, ok: true }),
                    executions: expect.arrayContaining([expect.objectContaining({ status: 1, stderr: expect.stringContaining("Operation not permitted") })]),
                }),
            }));
            expect(readFileSync(localPath, "utf8")).toBe("video");
            expect(JSON.parse(readFileSync(join(backendRoot(ownerId, "android"), "devices.json"), "utf8")).devices[0].recording).toBeNull();
        } finally {
            try { process.kill(-recorder.pid, "SIGKILL"); } catch { /* already exited */ }
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    // This real-runner fixture requires POSIX shell traps and process-group signals.
    it.skipIf(process.platform === "win32")("keeps recording state active when a default-runner recorder does not exit on stop", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-recording-stubborn-stop-test");
        const fakeAdb = join(process.env.HOME || tmpdir(), "fake-adb");
        const readyMarker = join(tmpdir(), `ccc-stubborn-recorder-${process.pid}-${Date.now()}.ready`);
        writeFileSync(fakeAdb, "#!/bin/sh\nexit 0\n");
        chmodSync(fakeAdb, 0o755);
        const stubborn = spawn("sh", ["-c", "trap '' INT; : > \"$READY_MARKER\"; while :; do sleep 1; done"], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, READY_MARKER: readyMarker },
        });
        stubborn.unref();
        const stubbornIdentity = readDeviceRuntimeProcessIdentity(stubborn.pid);
        if (!stubbornIdentity) throw new Error("stubborn process identity unavailable");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-recording-stubborn-stop-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: fakeAdb },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const readyDeadline = Date.now() + 5000;
            while (!existsSync(readyMarker) && Date.now() < readyDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(existsSync(readyMarker)).toBe(true);
            writeBrokerDevices(ownerId, "android", [{
                id: "pixel-stubborn-stop",
                status: "running",
                backend: "android-emulator",
                port: 5584,
                recording: {
                    active: true,
                    provider: "adb-screenrecord",
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.device.recording.start",
                    runtimeId: "stubborn-runtime",
                    pid: stubborn.pid,
                    processIdentity: stubbornIdentity,
                    remotePath: "/sdcard/stubborn.mp4",
                    localPath: "/tmp/stubborn.mp4",
                },
            }]);
            const stop = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_record_video_stop", backend: "android-emulator", deviceId: "pixel-stubborn-stop" },
                }),
            });
            expect(stop.status).toBe(502);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "recording-process-still-running",
                recording: expect.objectContaining({ active: true, pid: stubborn.pid }),
                startsDevices: false,
            }));
            expect(JSON.parse(readFileSync(join(backendRoot(ownerId, "android"), "devices.json"), "utf8")).devices[0].recording).toEqual(expect.objectContaining({
                active: true,
                pid: stubborn.pid,
            }));
        } finally {
            if (stubborn.pid) {
                try { process.kill(-stubborn.pid, "SIGKILL"); } catch { /* already gone */ }
            }
            rmSync(readyMarker, { force: true });
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("plans lifecycle commands and dry-run invokes without provider execution", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-command-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: command.mode === "detached" ? 12345 : undefined,
            stdout: command.provider === "adb" ? "1\n" : "started",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-command-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { emulator: "/fake/emulator", adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android", [{ id: "android-owned", status: "stopped", backend: "android-emulator", avdName: "ccc-test-pixel", port: 5580 }]);

            const plan = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-owned" },
                }),
            });
            expect(plan.status).toBe(200);
            expect(await plan.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId,
                    backend: "android-emulator",
                    stateKey: "android",
                    command: "device_start",
                    deviceId: "android-owned",
                    execution: expect.objectContaining({
                        mode: "planned",
                        providerExecution: "available",
                        mutatesHost: false,
                    }),
                }),
            }));

            const invoke = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-owned", dryRun: true },
                }),
            });
            expect(invoke.status).toBe(200);
            expect(await invoke.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: false,
                    dryRun: true,
                    execution: expect.objectContaining({ mode: "dry-run", mutatesHost: false }),
                }),
            }));

            const realInvoke = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-owned", dryRun: false, waitForBoot: true, bootTimeoutMs: 5000 },
                }),
            });
            expect(realInvoke.status).toBe(200);
            expect(await realInvoke.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: true,
                    dryRun: false,
                    device: expect.objectContaining({ status: "running" }),
                    boot: expect.objectContaining({ ready: true, skipped: false, provider: "adb" }),
                    execution: expect.objectContaining({
                        mode: "detached",
                        providerExecution: "executed",
                        mutatesHost: true,
                        command: expect.objectContaining({
                            provider: "emulator",
                            executable: "/fake/emulator",
                            args: ["-avd", "ccc-test-pixel", "-port", "5580", "-no-window", "-no-audio", "-netsim-args", "--no-cli-ui --no-web-ui"],
                            pid: 12345,
                        }),
                    }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                mode: "detached",
                provider: "emulator",
                executable: "/fake/emulator",
                args: ["-avd", "ccc-test-pixel", "-port", "5580", "-no-window", "-no-audio", "-netsim-args", "--no-cli-ui --no-web-ui"],
                windowsHiddenLauncher: true,
            }), expect.objectContaining({ timeoutMs: 5000, outputLimit: 32768 }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                mode: "exec",
                provider: "adb",
                executable: "/fake/adb",
                args: ["-s", "emulator-5580", "shell", "getprop", "sys.boot_completed"],
            }), expect.objectContaining({ timeoutMs: expect.any(Number), outputLimit: 32768 }));
            const adbBootCall = commandRunner.mock.calls.find(([command]) =>
                command.provider === "adb" && command.args?.includes("sys.boot_completed"));
            expect(adbBootCall?.[1].timeoutMs).toBeGreaterThanOrEqual(1000);
            expect(adbBootCall?.[1].timeoutMs).toBeLessThanOrEqual(5000);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it.each(["serial-delayed", "process-delayed", "both-delayed", "unrelated-offline", "serial-stays", "process-stays", "adb-fails", "process-fails", "budget-exhausted", "malformed-inventory"])(
        "confirms Android stop completion with %s observations", async scenario => {
        const cwd = `/project/android-stop-completion-${scenario}`;
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "android-stop-proof";
        const avdName = `ccc-${ownerId}-stop-proof`;
        const serial = "emulator-5586";
        const avdRoot = join(process.env.HOME!, ".android", "avd");
        const artifact = join(avdRoot, `${avdName}.avd`);
        mkdirSync(artifact, { recursive: true });
        writeFileSync(join(artifact, "userdata-qemu.img"), "owned fixture");
        const stateRoot = writeBrokerDevices(ownerId, "android", [{
            id: deviceId, backend: "android-emulator", status: "running", avdName, avdRoot,
            port: 5586, serial, bootReady: true, lastBootCheck: { ready: true },
        }]);
        const state = () => JSON.parse(readFileSync(join(stateRoot, "devices.json"), "utf8")).devices[0];
        const realNow = Date.now.bind(Date);
        let clockOffset = 0;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
        let deleting = false;
        let killed = false;
        let serialChecks = 0;
        let processChecks = 0;
        const commandRunner = vi.fn((command, options) => {
            const result = { ...command, status: 0, stdout: "", stderr: "" };
            if (command.provider === "adb" && command.args?.at(-1) === "kill") {
                expect(killed).toBe(false);
                killed = true;
                return result;
            }
            if (command.provider === "adb" && command.args?.[0] === "devices") {
                serialChecks++;
                if (!deleting) {
                    expect(killed).toBe(true);
                    expect(state().status).toBe("running");
                    expect(options.timeoutMs).toBeGreaterThan(0);
                    expect(options.timeoutMs).toBeLessThanOrEqual(30000);
                    if (scenario === "adb-fails") return { ...result, status: 1, stderr: "inventory unavailable" };
                    if (scenario === "malformed-inventory") return { ...result, stdout: "not an inventory" };
                    if (scenario === "budget-exhausted") clockOffset += 29000;
                    if (scenario === "serial-stays") clockOffset += 60000;
                }
                const active = !deleting && (scenario === "serial-stays"
                    || (["serial-delayed", "both-delayed"].includes(scenario) && serialChecks === 1));
                return { ...result, stdout: `List of devices attached\n${active ? `${serial}\tdevice\n` : ""}${!deleting && scenario === "unrelated-offline" ? "emulator-5666\toffline\n" : ""}` };
            }
            if (command.provider === "process-inventory") {
                processChecks++;
                if (!deleting) {
                    expect(state().status).toBe("running");
                    expect(options.timeoutMs).toBeGreaterThan(0);
                    expect(options.timeoutMs).toBeLessThanOrEqual(30000);
                    if (scenario === "process-fails") return { ...result, status: 1, stderr: "process observation unavailable" };
                    if (scenario === "budget-exhausted") {
                        expect(options.timeoutMs).toBeLessThanOrEqual(1000);
                        clockOffset += 2000;
                    }
                    if (scenario === "process-stays") clockOffset += 60000;
                }
                const active = !deleting && (scenario === "process-stays"
                    || (["process-delayed", "both-delayed"].includes(scenario) && processChecks === 1));
                return { ...result, stdout: active ? `emulator -avd ${avdName} -port 5586\n` : "" };
            }
            return result;
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" }, commandRunner });
        const baseUrl = await listen(server);
        const invoke = (command: string) => fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST", headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({ method: "broker.command.invoke", params: {
                backend: "android-emulator", command, deviceId, deleteAvd: true,
            } }),
        });
        try {
            const response = await invoke("device_stop");
            const body = await response.json();
            const fails = ["serial-stays", "process-stays", "adb-fails", "process-fails", "budget-exhausted", "malformed-inventory"].includes(scenario);
            if (fails) {
                expect(response.status).toBe(502);
                expect(body).toEqual(expect.objectContaining({ ok: false, error: "android-emulator-stop-unconfirmed" }));
                if (scenario === "budget-exhausted") expect(processChecks).toBe(1);
                expect(state()).toEqual(expect.objectContaining({ status: "running", bootReady: true, lastBootCheck: { ready: true } }));
                expect(existsSync(artifact)).toBe(true);
            } else {
                expect(response.status, JSON.stringify(body)).toBe(200);
                expect(body.ok).toBe(true);
                expect(serialChecks).toBeGreaterThan(0);
                expect(processChecks).toBeGreaterThan(0);
                if (scenario.includes("serial") || scenario === "both-delayed") expect(serialChecks).toBeGreaterThan(1);
                if (scenario.includes("process") || scenario === "both-delayed") expect(processChecks).toBeGreaterThan(1);
                expect(state().status).toBe("stopped");
                deleting = true;
                const deleted = await invoke("device_delete");
                expect(deleted.status).toBe(200);
                expect((await deleted.json()).ok).toBe(true);
                expect(existsSync(artifact)).toBe(false);
            }
            expect(commandRunner.mock.calls.filter(([command]) => command.provider === "adb" && command.args?.at(-1) === "kill")).toHaveLength(1);
        } finally {
            clock.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
            rmSync(artifact, { recursive: true, force: true });
        }
    });

    it("confirms stop of a registered non-prefixed AVD while still refusing artifact deletion", async () => {
        const cwd = "/project/android-stop-registered-avd";
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "android-registered-pixel";
        const avdName = "Pixel_User";
        const artifact = join(process.env.HOME!, ".android", "avd", `${avdName}.avd`);
        mkdirSync(artifact, { recursive: true });
        writeFileSync(join(artifact, "userdata-qemu.img"), "registered external AVD must survive");
        let killed = false;
        let serialChecks = 0;
        let processChecks = 0;
        const commandRunner = vi.fn((command) => {
            const result = { ...command, status: 0, stdout: "", stderr: "" };
            if (command.provider === "adb" && command.args?.at(-1) === "kill") {
                expect(killed).toBe(false);
                killed = true;
            } else if (command.provider === "adb" && command.args?.[0] === "devices") {
                if (killed) serialChecks++;
                result.stdout = `List of devices attached\n${killed && serialChecks === 1 ? "emulator-5586\tdevice\n" : ""}`;
            } else if (command.provider === "process-inventory") {
                processChecks++;
                result.stdout = processChecks === 1 ? "emulator -avd Pixel_User -port 5586\n" : "";
            }
            return result;
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0,
            providerPaths: { adb: "/fake/adb", avdmanager: "/fake/avdmanager" }, commandRunner });
        const baseUrl = await listen(server);
        const invoke = (command: string, extra: Record<string, unknown> = {}) => fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST", headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({ method: "broker.command.invoke", params: {
                backend: "android-emulator", command, deviceId, ...extra,
            } }),
        });
        try {
            const created = await invoke("device_create", { name: "Registered Pixel", avdName, createAvd: false, port: 5586 });
            expect(created.status).toBe(200);
            expect(await created.json()).toEqual(expect.objectContaining({ ok: true,
                result: expect.objectContaining({ device: expect.objectContaining({ avdName, provisioned: false }) }) }));
            const stopped = await invoke("device_stop");
            const stopBody = await stopped.json();
            expect(stopped.status, JSON.stringify(stopBody)).toBe(200);
            expect(stopBody).toEqual(expect.objectContaining({ ok: true,
                result: expect.objectContaining({ device: expect.objectContaining({ id: deviceId, status: "stopped" }) }) }));
            expect(serialChecks).toBeGreaterThan(1);
            expect(processChecks).toBeGreaterThan(1);
            expect(commandRunner.mock.calls.filter(([command]) => command.args?.at(-1) === "kill")).toHaveLength(1);
            const deleted = await invoke("device_delete", { deleteAvd: true });
            expect(deleted.status).toBe(400);
            expect(await deleted.json()).toEqual(expect.objectContaining({ ok: false, error: "android-avd-name-not-owner-scoped" }));
            expect(existsSync(artifact)).toBe(true);
            expect(commandRunner.mock.calls.some(([command]) => command.provider === "avdmanager")).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(artifact, { recursive: true, force: true });
        }
    });

    it("reports observed Android status and clears auxiliary runtime on stop", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-observed-status-test");
        const androidRoot = writeBrokerDevices(ownerId, "android", [{
            id: "android-observed-runtime",
            backend: "android-emulator",
            status: "stopped",
            avdName: `ccc-${ownerId}-observed-runtime`,
            port: 5586,
            appium: { processOwner: "host-broker", serverPid: 99999991, port: 27111 },
            bootReady: true,
            lastBootCheck: { ready: true, provider: "adb", result: { status: 0, stdout: "1\n" } },
            recording: {
                active: true,
                pid: 99999992,
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.device.recording.start",
            },
        }]);
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            stdout: command.args?.includes("get-state") ? "device\n"
                : command.provider === "adb" && command.args?.[0] === "devices" ? "List of devices attached\n" : "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-observed-status-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const status = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_status", deviceId: "android-observed-runtime" },
                }),
            });
            expect(status.status).toBe(200);
            expect(await status.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        status: "running",
                        runtimeState: "running",
                        readiness: { state: "ready", provider: "adb" },
                    }),
                }),
            }));
            const afterStatus = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as { devices: Array<{ status: string }> };
            expect(afterStatus.devices[0].status).toBe("stopped");

            const stop = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_stop", deviceId: "android-observed-runtime" },
                }),
            });
            expect(stop.status).toBe(200);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        status: "stopped",
                        appium: null,
                        recording: null,
                        bootReady: false,
                        lastBootCheck: null,
                    }),
                    auxiliaryCleanup: expect.objectContaining({
                        appium: expect.objectContaining({ cleared: true, signal: expect.objectContaining({ ok: true }) }),
                        recording: expect.objectContaining({ cleared: true, signal: expect.objectContaining({ ok: true }) }),
                    }),
                }),
            }));
            const afterStop = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as {
                devices: Array<{ appium: unknown; recording: unknown; status: string; bootReady: boolean; lastBootCheck: unknown }>;
            };
            expect(afterStop.devices[0]).toEqual(expect.objectContaining({
                appium: null,
                recording: null,
                status: "stopped",
                bootReady: false,
                lastBootCheck: null,
            }));

            writeBrokerDevices(ownerId, "android", [{
                id: "android-delete-runtime",
                backend: "android-emulator",
                status: "stopped",
                avdName: "ccc-delete-runtime",
                port: 5588,
                appium: { processOwner: "host-broker", serverPid: 99999993, port: 27113 },
                recording: {
                    active: true,
                    pid: 99999994,
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.device.recording.start",
                },
            }]);
            const deleted = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_delete",
                        deviceId: "android-delete-runtime",
                        deleteAvd: false,
                    },
                }),
            });
            expect(deleted.status).toBe(200);
            expect(await deleted.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: null,
                    auxiliaryCleanup: expect.objectContaining({
                        appium: expect.objectContaining({ cleared: true, signal: expect.objectContaining({ ok: true }) }),
                        recording: expect.objectContaining({ cleared: true, signal: expect.objectContaining({ ok: true }) }),
                    }),
                }),
            }));
            const afterDelete = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as { devices: unknown[] };
            expect(afterDelete.devices).toEqual([]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("reports a stopped Android emulator when its adb target is absent", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-stopped-status-test");
        writeBrokerDevices(ownerId, "android", [{
            id: "android-stopped",
            backend: "android-emulator",
            status: "stopped",
            avdName: "ccc-android-stopped",
            port: 5584,
        }]);
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 1,
            stdout: "",
            stderr: "adb: error: device 'emulator-5584' not found",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-stopped-status-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_status", deviceId: "android-stopped" },
                }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "android-stopped",
                        status: "stopped",
                        runtimeState: "stopped",
                        readiness: { state: "stopped", provider: "adb" },
                    }),
                    execution: expect.objectContaining({
                        mutatesHost: false,
                        command: expect.objectContaining({ status: 1, provider: "adb" }),
                    }),
                }),
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves auxiliary metadata and blocks lifecycle commands when cleanup fails", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-cleanup-failure-test");
        const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!processIdentity) throw new Error("current process identity unavailable");
        const androidRoot = writeBrokerDevices(ownerId, "android", [{
            id: "android-cleanup-failure",
            backend: "android-emulator",
            status: "running",
            avdName: "ccc-cleanup-failure",
            port: 5590,
            recording: {
                active: true,
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.device.recording.start",
                runtimeId: "cleanup-failure-runtime",
                pid: process.pid,
                processIdentity,
            },
        }]);
        const signalError = Object.assign(new Error("permission denied"), { code: "EACCES" });
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
            throw signalError;
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-cleanup-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_stop", deviceId: "android-cleanup-failure" },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "auxiliary-runtime-cleanup-failed",
                result: expect.objectContaining({
                    invoked: false,
                    auxiliaryCleanup: expect.objectContaining({
                        ok: false,
                        changed: false,
                        recording: expect.objectContaining({
                            cleared: false,
                            signal: expect.objectContaining({ attempted: true, ok: false, error: "permission denied" }),
                        }),
                    }),
                    execution: expect.objectContaining({ providerExecution: "blocked", mutatesHost: false }),
                }),
            }));
            const state = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as {
                devices: Array<{ status: string; recording: { pid: number } }>;
            };
            expect(state.devices[0]).toEqual(expect.objectContaining({
                status: "running",
                recording: expect.objectContaining({ pid: process.pid }),
            }));
        } finally {
            killSpy.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("keeps netsimd helper UI disabled when Android emulator display is visible", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-visible-command-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: command.mode === "detached" ? 12346 : undefined,
            stdout: "started",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-visible-command-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { emulator: "/fake/emulator" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android", [{ id: "android-visible", status: "stopped", backend: "android-emulator", avdName: "ccc-test-visible", port: 5584 }]);

            const realInvoke = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-visible", dryRun: false, headless: false },
                }),
            });

            expect(realInvoke.status).toBe(200);
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                mode: "detached",
                provider: "emulator",
                executable: "/fake/emulator",
                args: ["-avd", "ccc-test-visible", "-port", "5584", "-netsim-args", "--no-cli-ui --no-web-ui"],
                windowsHiddenLauncher: true,
            }), expect.objectContaining({ timeoutMs: 5000, outputLimit: 32768 }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("deletes Android broker metadata without avdmanager when deleteAvd is false", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-metadata-delete-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            stdout: command.reason || "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-metadata-delete-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { avdmanager: "C:\\Android\\cmdline-tools\\latest\\bin\\avdmanager.bat" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android", [{
                id: "android-metadata-only",
                status: "stopped",
                backend: "android-emulator",
                avdName: "ccc-metadata-only",
            }]);

            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "android-emulator",
                        command: "device_delete",
                        deviceId: "android-metadata-only",
                        confirmDestructive: true,
                        deleteAvd: false,
                    },
                }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: null,
                    execution: expect.objectContaining({
                        mode: "noop",
                        command: expect.objectContaining({
                            provider: "host-broker-state",
                            stdout: expect.stringContaining("deleteAvd=false"),
                        }),
                    }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                mode: "noop",
                provider: "host-broker-state",
            }), expect.any(Object));
            const state = JSON.parse(readFileSync(join(backendRoot(ownerId, "android"), "devices.json"), "utf8")) as { devices: unknown[] };
            expect(state.devices).toEqual([]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("wraps Windows batch provider commands through cmd.exe", () => {
        expect(providerCommandSpawn({
            mode: "exec",
            provider: "avdmanager",
            executable: "C:\\Users\\TestUser\\Android Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat",
            args: ["delete", "avd", "--name", "ccc smoke"],
        }, "win32")).toEqual({
            executable: "cmd.exe",
            args: [
                "/d",
                "/s",
                "/c",
                "\"C:\\Users\\TestUser\\Android Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat\" delete avd --name \"ccc smoke\"",
            ],
        });

        expect(providerCommandSpawn({
            mode: "exec",
            provider: "adb",
            executable: "C:\\Android\\platform-tools\\adb.exe",
            args: ["devices"],
        }, "win32")).toEqual({
            executable: "C:\\Android\\platform-tools\\adb.exe",
            args: ["devices"],
        });
    });

    it("forces every Windows PowerShell provider command to start hidden", () => {
        expect(providerCommandSpawn({
            mode: "exec",
            provider: "process-inventory",
            executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            args: ["-NoProfile", "-Command", "exit 0"],
        }, "win32")).toEqual({
            executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            args: ["-WindowStyle", "Hidden", "-NoProfile", "-Command", "exit 0"],
        });

        expect(providerCommandSpawn({
            mode: "exec",
            provider: "process-inventory",
            executable: "pwsh.exe",
            args: ["-WindowStyle", "Hidden", "-NoProfile", "-Command", "exit 0"],
        }, "win32").args).toEqual([
            "-WindowStyle",
            "Hidden",
            "-NoProfile",
            "-Command",
            "exit 0",
        ]);
    });

    it("uses hidden child-process options for provider commands by default", () => {
        expect(hiddenChildProcessOptions({ detached: true, stdio: "ignore" as const })).toEqual({
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });
        expect(hiddenChildProcessOptions({ encoding: "utf8", timeout: 1234, windowsHide: false })).toEqual({
            encoding: "utf8",
            timeout: 1234,
            windowsHide: true,
        });
    });

    it("propagates the hidden child policy through every Windows provider process tree", () => {
        const first = hiddenProviderCommandEnv({ NODE_OPTIONS: "--trace-warnings", CUSTOM: "yes" }, "win32");
        expect(first).toEqual(expect.objectContaining({
            CUSTOM: "yes",
            NODE_OPTIONS: expect.stringMatching(/^--trace-warnings --require=".*hidden-child-processes-[a-f0-9]{32}\.cjs"$/),
        }));

        const second = hiddenProviderCommandEnv(first, "win32");
        expect(second?.NODE_OPTIONS?.match(/hidden-child-processes-[a-f0-9]{32}\.cjs/g)).toHaveLength(1);
        expect(hiddenProviderCommandEnv({ CUSTOM: "yes" }, "linux")).toEqual({ CUSTOM: "yes" });
    });

    it("materializes one verified random preload for the current broker process", () => {
        const first = hiddenProviderCommandEnv({}, "win32");
        const second = hiddenProviderCommandEnv({}, "win32");
        const firstPath = [...(first?.NODE_OPTIONS || "").matchAll(/--require="([^"]+)"/g)].map(match => match[1]).find(path => /hidden-child-processes-[a-f0-9]{32}\.cjs$/.test(path));
        const secondPath = [...(second?.NODE_OPTIONS || "").matchAll(/--require="([^"]+)"/g)].map(match => match[1]).find(path => /hidden-child-processes-[a-f0-9]{32}\.cjs$/.test(path));

        expect(firstPath).toBeTruthy();
        expect(secondPath).toBe(firstPath);
        expect(firstPath).toMatch(/hidden-child-processes-[a-f0-9]{32}\.cjs$/);
        expect(lstatSync(firstPath as string)).toEqual(expect.objectContaining({ nlink: 1 }));
        expect(readFileSync(firstPath as string, "utf8")).toBe(windowsHiddenChildProcessPreloadScript());
    });

    it.runIf(process.platform !== "win32")("refuses a hidden preload through a linked launcher directory", () => {
        const brokerDirectory = join(process.env.HOME!, ".ccc", "devices", "broker");
        const launchersDirectory = join(brokerDirectory, "launchers");
        const externalDirectory = join(process.env.HOME!, "external-hidden-preload");
        const marker = join(externalDirectory, "preserve.txt");
        mkdirSync(brokerDirectory, { recursive: true });
        mkdirSync(externalDirectory, { recursive: true });
        writeFileSync(marker, "preserve");
        directorySymlink(externalDirectory, launchersDirectory);

        expect(() => hiddenProviderCommandEnv({}, "win32")).toThrow("windows-provider-launcher-directory-invalid");
        expect(readdirSync(externalDirectory)).toEqual(["preserve.txt"]);
        expect(readFileSync(marker, "utf8")).toBe("preserve");
    });

    it("creates random single-link VBS launchers and rejects unsafe provider paths", () => {
        const command = {
            mode: "detached" as const,
            provider: "emulator",
            executable: "C:\\Android\\emulator.exe",
            args: ["-avd", "Pixel 8"],
            windowsHiddenLauncher: true,
        };
        const first = windowsHiddenVbsLauncherInvocation(command);
        const second = windowsHiddenVbsLauncherInvocation(command);
        const firstPath = first.cleanupPath as string;
        const secondPath = second.cleanupPath as string;

        expect(first).toEqual(expect.objectContaining({ executable: "wscript.exe", args: ["//B", firstPath] }));
        expect(secondPath).not.toBe(firstPath);
        expect(firstPath).toMatch(/[a-f0-9]{16}-[a-f0-9]{32}\.vbs$/);
        expect(lstatSync(firstPath)).toEqual(expect.objectContaining({ nlink: 1 }));
        expect(readFileSync(firstPath, "utf8")).toBe(windowsHiddenVbsLauncherScript(command.executable, command.args));
        expect(() => windowsHiddenVbsLauncherInvocation({ ...command, provider: "../outside" })).toThrow("windows-provider-launcher-provider-invalid");
    });

    it.runIf(process.platform !== "win32")("refuses a VBS launcher through a linked provider directory", () => {
        const launcherRoot = join(process.env.HOME!, ".ccc", "devices", "launchers");
        const providerDirectory = join(launcherRoot, "emulator");
        const externalDirectory = join(process.env.HOME!, "external-vbs-launchers");
        const marker = join(externalDirectory, "preserve.txt");
        mkdirSync(launcherRoot, { recursive: true });
        mkdirSync(externalDirectory, { recursive: true });
        writeFileSync(marker, "preserve");
        directorySymlink(externalDirectory, providerDirectory);

        expect(() => windowsHiddenVbsLauncherInvocation({
            mode: "detached",
            provider: "emulator",
            executable: "C:\\Android\\emulator.exe",
            args: ["-avd", "Pixel 8"],
        })).toThrow("windows-provider-launcher-directory-invalid");
        expect(readdirSync(externalDirectory)).toEqual(["preserve.txt"]);
        expect(readFileSync(marker, "utf8")).toBe("preserve");
    });

    it("forces hidden windows across Appium child-process APIs", () => {
        const calls: Array<{ method: string; options: Record<string, unknown> }> = [];
        const syncBuiltinESMExports = vi.fn();
        const childProcess = Object.fromEntries([
            "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork",
        ].map((method) => [method, (...args: unknown[]) => {
            const options = [...args].reverse().find((arg) => arg && typeof arg === "object" && !Array.isArray(arg)) as Record<string, unknown> | undefined;
            calls.push({ method, options: options || {} });
            return { method };
        }]));

        runInNewContext(windowsHiddenChildProcessPreloadScript(), {
            require: (specifier: string) => {
                if (specifier === "node:child_process") return childProcess;
                if (specifier === "node:module") return { syncBuiltinESMExports };
                throw new Error(`unexpected require: ${specifier}`);
            },
        });

        childProcess.spawn("adb", ["devices"], { windowsHide: false });
        childProcess.spawnSync("adb", ["devices"], {});
        childProcess.exec("adb devices", {});
        childProcess.execSync("adb devices", { windowsHide: false });
        childProcess.execFile("java", ["-version"], {});
        childProcess.execFileSync("java", ["-version"], {});
        childProcess.fork("worker.js", [], {});

        expect(calls.map((call) => call.method)).toEqual([
            "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork",
        ]);
        for (const call of calls) expect(call.options.windowsHide).toBe(true);
        expect(syncBuiltinESMExports).toHaveBeenCalledOnce();
    });

    it("builds a console-free Windows launcher for Android emulator commands", () => {
        const script = windowsHiddenVbsLauncherScript("C:\\Users\\TestUser\\Android Sdk\\emulator\\emulator.exe", [
            "-avd",
            "Pixel 8",
            "-netsim-args",
            "--no-cli-ui --no-web-ui",
        ]);

        expect(script).toContain("WScript.Shell");
        expect(script).toContain("Shell.Run");
        expect(script).toContain("%ComSpec% /d /s /c");
        expect(script).toContain("\"\"C:\\Users\\TestUser\\Android Sdk\\emulator\\emulator.exe\"\"");
        expect(script).toContain("\"\"Pixel 8\"\"");
        expect(script).toContain("\"\"--no-cli-ui --no-web-ui\"\"");
        expect(script).toContain(">NUL 2>NUL");
        expect(script).toContain(", 0, False");
    });

    it("wraps minimized Windows provider commands through PowerShell Start-Process", () => {
        const invocation = providerCommandSpawn({
            mode: "exec",
            provider: "wsb",
            executable: "C:\\Users\\TestUser\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe",
            args: ["start", "--id", "12345678-1234-4234-9234-1234567890ab", "--config", "<Configuration />"],
            windowStyle: "minimized",
        }, "win32");

        expect(invocation.executable).toBe("powershell.exe");
        expect(invocation.args.slice(0, 6)).toEqual(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
        const script = Buffer.from(invocation.args[6], "base64").toString("utf16le");
        expect(script).toContain("$Executable = 'C:\\Users\\TestUser\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe'");
        expect(script).toContain("Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Minimized -Wait -PassThru");
        expect(script).toContain("'start --id 12345678-1234-4234-9234-1234567890ab --config \"<Configuration />\"'");

        const nonWaitingInvocation = providerCommandSpawn({
            mode: "exec",
            provider: "wsb",
            executable: "C:\\Users\\TestUser\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe",
            args: ["start", "--id", "12345678-1234-4234-9234-1234567890ab", "--config", "<Configuration />"],
            windowStyle: "minimized",
            waitForExit: false,
        }, "win32");
        const nonWaitingScript = Buffer.from(nonWaitingInvocation.args[6], "base64").toString("utf16le");
        expect(nonWaitingScript).toContain("Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Minimized -PassThru");
        expect(nonWaitingScript).not.toContain("-Wait -PassThru");
        expect(nonWaitingScript).not.toContain("$Process.ExitCode");

        expect(providerCommandSpawn({
            mode: "exec",
            provider: "wsb",
            executable: "/fake/wsb",
            args: ["start"],
            windowStyle: "minimized",
        }, "linux")).toEqual({
            executable: "/fake/wsb",
            args: ["start"],
        });
    });

    it("builds a hidden watchdog that minimizes the actual Windows Sandbox window", () => {
        const startedAfter = "2026-07-13T16:30:00.000Z";
        const cancelPath = "C:\\owner\\downloads\\cancel.txt";
        const resultPath = "C:\\owner\\downloads\\result.txt";
        const args = windowsSandboxMinimizeWatchdogArgs(5000, startedAfter, cancelPath, [101, 202], resultPath);
        expect(args.slice(0, 6)).toEqual(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
        const script = Buffer.from(args[6], "base64").toString("utf16le");
        expect(script).toContain("ShowWindowAsync(IntPtr hWnd, int nCmdShow)");
        expect(script).toContain("ProcessName -match 'WindowsSandbox|wsb'");
        expect(script).toContain("ShowWindowAsync([IntPtr]$Handle, 6)");
        expect(script).toContain("AddMilliseconds(5000)");
        expect(script).toContain(`$StartedAfter = [DateTime]::Parse('${startedAfter}').ToUniversalTime()`);
        expect(script).toContain("$HasBaselineSnapshot = $true");
        expect(script).toContain("$BaselineHandles = @(101,202)");
        expect(script).toContain("-not ($BaselineHandles -contains $Handle)");
        expect(script).toContain("$NewProcess = (-not $HasBaselineSnapshot) -and $_.StartTime.ToUniversalTime() -ge $StartedAfter");
        expect(script).not.toContain("$ReadyMarkerPath");
        expect(script).toContain(`$CancelPath = '${cancelPath}'`);
        expect(script).toContain(`$ResultPath = '${resultPath}'`);
        expect(script).toContain("Set-Content -LiteralPath $ResultPath -Value 'minimized'");
        expect(script).toContain("Set-Content -LiteralPath $ResultPath -Value 'not-minimized'");
    });

    it("captures and parses pre-launch Windows Sandbox window handles", () => {
        const args = windowsSandboxWindowHandleSnapshotArgs();
        const script = Buffer.from(args[6], "base64").toString("utf16le");
        expect(script).toContain("MainWindowHandle -ne 0");
        expect(script).toContain("ConvertTo-Json -Compress");
        expect(windowsSandboxWindowHandlesFromOutput("[101,202,101]")).toEqual([101, 202]);
        expect(windowsSandboxWindowHandlesFromOutput("303")).toEqual([303]);
        expect(windowsSandboxWindowHandlesFromOutput("")).toEqual([]);
        expect(windowsSandboxWindowHandlesFromOutput("not-json")).toBeNull();
    });

    it("requires an explicit Windows Sandbox minimize confirmation", () => {
        const resultPath = join(process.env.HOME!, "minimize-result.txt");
        writeFileSync(resultPath, "minimized");
        expect(waitForBrokerWindowsMinimizeConfirmation(resultPath, 0)).toEqual(expect.objectContaining({
            provider: "windows-sandbox-window",
            status: 0,
            stdout: "minimized",
        }));
        writeFileSync(resultPath, "not-minimized");
        expect(waitForBrokerWindowsMinimizeConfirmation(resultPath, 0)).toEqual(expect.objectContaining({
            provider: "windows-sandbox-window",
            status: 1,
            stdout: "not-minimized",
        }));
        writeFileSync(resultPath, "x".repeat(65));
        const oversized = waitForBrokerWindowsMinimizeConfirmation(resultPath, 0);
        expect(oversized).toEqual(expect.objectContaining({
            provider: "windows-sandbox-window",
            status: 1,
        }));
        expect(oversized.stderr).toContain("windows-sandbox-minimize-result-file-too-large");
        if (process.platform !== "win32") {
            const external = join(process.env.HOME!, "external-minimize-result.txt");
            writeFileSync(external, "minimized");
            rmSync(resultPath, { force: true });
            symlinkSync(external, resultPath);
            const linked = waitForBrokerWindowsMinimizeConfirmation(resultPath, 0);
            expect(linked).toEqual(expect.objectContaining({
                provider: "windows-sandbox-window",
                status: 1,
            }));
            expect(linked.stderr).toContain("windows-sandbox-minimize-result-state-invalid");
            expect(readFileSync(external, "utf8")).toBe("minimized");
        }
        rmSync(resultPath, { force: true });
        expect(waitForBrokerWindowsMinimizeConfirmation(resultPath, 0)).toEqual(expect.objectContaining({
            provider: "windows-sandbox-window",
            status: null,
            timedOut: true,
        }));
    });

    it("extracts Windows Sandbox ids from raw broker list output", () => {
        expect(windowsSandboxSessionIdsFromBrokerListOutput(JSON.stringify({
            sessions: [{ id: "12345678-1234-4234-9234-1234567890AB" }],
            nested: { sandboxId: "87654321-4321-4234-9234-abcdefabcdef" },
        }))).toEqual([
            "12345678-1234-4234-9234-1234567890ab",
            "87654321-4321-4234-9234-abcdefabcdef",
        ]);
        expect(windowsSandboxSessionIdsFromBrokerListOutput("Sandbox 12345678-1234-4234-9234-1234567890AB")).toEqual([
            "12345678-1234-4234-9234-1234567890ab",
        ]);
    });

    it("waits for Windows Sandbox runtime registration on Windows before marking it running", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-windows-registration-test");
        const windowsRoot = backendRoot(ownerId, "windows");
        const configPath = join(windowsRoot, "registered.wsb");
        const sandboxId = "12345678-1234-4234-9234-1234567890cc";
        const foreignSandboxId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
        const runtimeSandboxId = "87654321-4321-4234-9234-abcdefabcdef";
        mkdirSync(windowsRoot, { recursive: true });
        writeFileSync(configPath, "<Configuration>registered</Configuration>");
        writeBrokerDevices(ownerId, "windows", [
            { id: "win-registered", backend: "windows-sandbox", status: "stopped", configPath, sandboxId },
        ]);
        let listCalls = 0;
        const commandRunner = vi.fn((command) => {
            if (command.provider === "wsb" && command.args?.[0] === "list") {
                listCalls += 1;
                const ids = listCalls === 1 ? [foreignSandboxId] : [foreignSandboxId, runtimeSandboxId];
                return { mode: "exec", provider: "wsb", status: 0, stdout: JSON.stringify({ WindowsSandboxEnvironments: ids.map((Id) => ({ Id })) }), stderr: "" };
            }
            if (command.provider === "powershell" && command.mode === "exec") {
                return { mode: command.mode, provider: command.provider, status: 0, stdout: "[101,202]", stderr: "" };
            }
            if (command.provider === "powershell") {
                mkdirSync(join(windowsRoot, "win-registered", "downloads"), { recursive: true });
                writeFileSync(join(windowsRoot, "win-registered", "downloads", "ccc-minimize-watchdog.result.txt"), "minimized");
                return { mode: command.mode, provider: command.provider, status: 0, pid: 99999995, stdout: "", stderr: "" };
            }
            return { mode: command.mode, provider: command.provider, status: 0, stdout: "", stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-windows-registration-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: "wsb" },
            commandRunner,
            platform: "win32",
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const started = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-registered", dryRun: false },
                }),
            });
            expect(started.status).toBe(200);
            expect(commandRunner).toHaveBeenNthCalledWith(1, expect.objectContaining({
                provider: "wsb",
                args: ["list", "--raw"],
            }), expect.any(Object));
            expect(commandRunner).toHaveBeenNthCalledWith(2, expect.objectContaining({
                mode: "exec",
                provider: "powershell",
                executable: "powershell.exe",
            }), expect.any(Object));
            expect(commandRunner).toHaveBeenNthCalledWith(3, expect.objectContaining({
                provider: "wsb",
                args: ["start", "--id", sandboxId, "--config", "<Configuration>registered</Configuration>"],
            }), expect.any(Object));
            expect(commandRunner).toHaveBeenNthCalledWith(4, expect.objectContaining({
                provider: "wsb",
                args: ["list", "--raw"],
            }), expect.any(Object));
            expect(commandRunner).toHaveBeenNthCalledWith(5, expect.objectContaining({
                mode: "detached",
                provider: "powershell",
                executable: "powershell.exe",
            }), expect.any(Object));
            const watchdogCommand = commandRunner.mock.calls[4][0];
            const watchdogScript = Buffer.from(watchdogCommand.args[6], "base64").toString("utf16le");
            expect(watchdogScript).toContain("$BaselineHandles = @(101,202)");
            expect(commandRunner).not.toHaveBeenCalledWith(expect.objectContaining({
                provider: "wsb",
                args: ["stop", "--id", foreignSandboxId],
            }), expect.any(Object));
            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string; status: string; minimized?: boolean; minimizeConfirmed?: boolean; minimizeWatchdog?: { pid?: number } }> };
            expect(state.devices[0]).toEqual(expect.objectContaining({
                id: "win-registered",
                status: "running",
                minimized: true,
                minimizeConfirmed: true,
                sandboxId: runtimeSandboxId,
                requestedSandboxId: sandboxId,
                minimizeWatchdog: expect.objectContaining({ pid: 99999995 }),
            }));
            const lock = JSON.parse(readFileSync(join(process.env.HOME!, ".ccc/devices/host-locks/windows-sandbox.json"), "utf8")) as { sandboxId: string; requestedSandboxId: string };
            expect(lock).toEqual(expect.objectContaining({ sandboxId: runtimeSandboxId, requestedSandboxId: sandboxId }));

            const stopped = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_stop", deviceId: "win-registered", dryRun: false },
                }),
            });
            expect(stopped.status).toBe(200);
            expect(await stopped.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({ status: "stopped", minimizeWatchdog: null }),
                    auxiliaryCleanup: expect.objectContaining({
                        minimizeWatchdog: expect.objectContaining({
                            cleared: true,
                            cancellation: expect.objectContaining({
                                ok: true,
                                cancelPath: expect.stringContaining("ccc-minimize-watchdog.cancel"),
                            }),
                        }),
                    }),
                }),
            }));
            const stoppedState = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<{ status: string; minimizeWatchdog: unknown }> };
            expect(stoppedState.devices[0]).toEqual(expect.objectContaining({ status: "stopped", minimizeWatchdog: null }));
            expect(existsSync(join(windowsRoot, "win-registered", "downloads", "ccc-minimize-watchdog.cancel"))).toBe(true);
            expect(existsSync(join(process.env.HOME!, ".ccc/devices/host-locks/windows-sandbox.json"))).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("recovers a stopped Windows record from its matching broker singleton lock", async () => {
        const cwd = "/project/broker-windows-stopped-runtime-recovery";
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "win-stopped-runtime-recovery";
        const sandboxId = "12345678-1234-4234-9234-1234567890ac";
        writeBrokerDevices(ownerId, "windows", [
            { id: deviceId, backend: "windows-sandbox", status: "stopped", authority: "host-broker" },
        ]);
        let bootId: string;
        try {
            bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
        } catch {
            bootId = `${hostname()}:${Math.floor((Date.now() - uptime() * 1000) / 1000)}`;
        }
        const lockPath = join(process.env.HOME!, ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, JSON.stringify({
            provider: "windows-sandbox",
            host: hostname(),
            bootId,
            ownerId,
            deviceId,
            sandboxId,
            claimId: "abcdef0123456789abcdef0123456789",
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }));
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            status: 0,
            stdout: "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: "wsb" },
            commandRunner,
            platform: "win32",
        });
        const baseUrl = await listen(server);
        try {
            const stopped = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_stop", deviceId, dryRun: false },
                }),
            });
            expect(stopped.status).toBe(200);
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "wsb",
                args: ["stop", "--id", sandboxId],
            }), expect.any(Object));
            expect(existsSync(lockPath)).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("fails closed when Windows Sandbox start produces no new owned runtime", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-windows-no-new-runtime-test");
        const windowsRoot = backendRoot(ownerId, "windows");
        const configPath = join(windowsRoot, "no-new-runtime.wsb");
        const foreignSandboxId = "12345678-1234-4234-9234-1234567890ee";
        mkdirSync(windowsRoot, { recursive: true });
        writeFileSync(configPath, "<Configuration>no new runtime</Configuration>");
        writeBrokerDevices(ownerId, "windows", [
            { id: "win-no-new-runtime", backend: "windows-sandbox", status: "stopped", configPath, sandboxId: foreignSandboxId, minimized: true },
        ]);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "wsb" && command.args?.[0] === "list") {
                return { mode: "exec", provider: "wsb", status: 0, stdout: JSON.stringify({ WindowsSandboxEnvironments: [{ Id: foreignSandboxId }] }), stderr: "" };
            }
            if (command.provider === "powershell" && command.mode === "exec") {
                return { mode: command.mode, provider: command.provider, status: 0, stdout: "[404]", stderr: "" };
            }
            return { mode: command.mode, provider: command.provider, status: 0, stdout: "", stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-windows-no-new-runtime-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: "wsb" },
            commandRunner,
            platform: "win32",
        });
        const baseUrl = await listen(server);
        try {
            const started = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-no-new-runtime", dryRun: false },
                }),
            });
            expect(started.status).toBe(502);
            expect(await started.json()).toEqual(expect.objectContaining({
                ok: false,
                result: expect.objectContaining({
                    execution: expect.objectContaining({
                        command: expect.objectContaining({
                            registration: expect.objectContaining({
                                error: expect.stringContaining("existed before launch; no new owned runtime appeared"),
                            }),
                        }),
                    }),
                }),
            }));
            expect(commandRunner).not.toHaveBeenCalledWith(expect.objectContaining({
                provider: "wsb",
                args: ["stop", "--id", foreignSandboxId],
            }), expect.any(Object));
            expect(commandRunner).not.toHaveBeenCalledWith(expect.objectContaining({
                mode: "detached",
                provider: "powershell",
            }), expect.any(Object));
            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<{ status: string; sandboxId: string }> };
            expect(state.devices[0]).toEqual(expect.objectContaining({ status: "stopped", sandboxId: foreignSandboxId }));
            expect(existsSync(join(process.env.HOME!, ".ccc/devices/host-locks/windows-sandbox.json"))).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("keeps a registered Windows Sandbox running when its minimize watchdog cannot start", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-windows-watchdog-failure-test");
        const windowsRoot = backendRoot(ownerId, "windows");
        const configPath = join(windowsRoot, "watchdog-failure.wsb");
        const sandboxId = "12345678-1234-4234-9234-1234567890dd";
        mkdirSync(windowsRoot, { recursive: true });
        writeFileSync(configPath, "<Configuration>watchdog failure</Configuration>");
        writeBrokerDevices(ownerId, "windows", [
            { id: "win-watchdog-failure", backend: "windows-sandbox", status: "stopped", configPath, sandboxId, minimized: true },
        ]);
        let listCalls = 0;
        const commandRunner = vi.fn((command) => {
            if (command.provider === "powershell" && command.mode === "detached") {
                return { mode: command.mode, provider: command.provider, status: null, error: "powershell unavailable", stdout: "", stderr: "" };
            }
            if (command.provider === "powershell") {
                return { mode: command.mode, provider: command.provider, status: 0, stdout: "[]", stderr: "" };
            }
            if (command.provider === "wsb" && command.args?.[0] === "list") {
                listCalls += 1;
                const environments = listCalls === 1 ? [] : [{ Id: sandboxId }];
                return { mode: "exec", provider: "wsb", status: 0, stdout: JSON.stringify({ WindowsSandboxEnvironments: environments }), stderr: "" };
            }
            return { mode: command.mode, provider: command.provider, status: 0, stdout: "", stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-windows-watchdog-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: "wsb" },
            commandRunner,
            platform: "win32",
        });
        const baseUrl = await listen(server);
        try {
            const started = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-watchdog-failure", dryRun: false },
                }),
            });
            expect(started.status).toBe(200);
            expect(await started.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        status: "running",
                        minimizeConfirmed: false,
                        minimizeWarning: "powershell unavailable",
                    }),
                    minimizeWatchdog: expect.objectContaining({ status: null, error: "powershell unavailable" }),
                }),
            }));
            expect(commandRunner).not.toHaveBeenCalledWith(expect.objectContaining({
                provider: "wsb",
                args: ["stop", "--id", sandboxId],
            }), expect.any(Object));
            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<{ status: string; minimizeConfirmed: boolean }> };
            expect(state.devices[0]).toEqual(expect.objectContaining({ status: "running", minimizeConfirmed: false }));
            expect(existsSync(join(process.env.HOME!, ".ccc/devices/host-locks/windows-sandbox.json"))).toBe(true);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("validates lifecycle command params and keeps plans owner scoped", async () => {
        const ownerA = deviceLabOwnerId("/project/broker-command-guard-test");
        const ownerBPath = "/project/broker-command-guard-foreign-test";
        const ownerB = deviceLabOwnerId(ownerBPath);
        registerDeviceBrokerOwner(ownerBPath);
        const server = createDeviceBrokerServer({ cwd: "/project/broker-command-guard-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpointA = ownerRpcEndpoint(baseUrl, ownerA);
        const endpointB = ownerRpcEndpoint(baseUrl, ownerB);
        const headersA = ownerRpcHeaders(ownerA);
        const headersB = ownerRpcHeaders(ownerB);
        try {
            writeBrokerDevices(ownerA, "windows", [{ id: "win-owned", status: "stopped", backend: "windows-sandbox" }]);

            const foreignPlan = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "windows-sandbox", command: "device_delete", deviceId: "win-owned" },
                }),
            });
            expect(foreignPlan.status).toBe(404);
            expect(await foreignPlan.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-device-not-found",
                ownerId: ownerB,
            }));

            const invalidBackend = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "unknown", command: "device_start", deviceId: "win-owned" },
                }),
            });
            expect(invalidBackend.status).toBe(400);
            expect(await invalidBackend.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-command-backend" }));

            const invalidCommand = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "windows-sandbox", command: "device_exec", deviceId: "win-owned" },
                }),
            });
            expect(invalidCommand.status).toBe(400);
            expect(await invalidCommand.json()).toEqual(expect.objectContaining({ ok: false, error: "unsupported-lifecycle-command" }));

            const invalidDeviceId = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "../win-owned" },
                }),
            });
            expect(invalidDeviceId.status).toBe(400);
            expect(await invalidDeviceId.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-device-id" }));
        } finally {
            await close(server);
            cleanupOwner(ownerA);
            cleanupOwner(ownerB);
        }
    });

    it("builds provider command plans for each device backend and reports missing metadata", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-provider-plan-test");
        const iosSimulatorName = `ccc-${ownerId}-ios-sim`;
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            stdout: command.provider === "xcrun" && command.args?.join(" ") === "simctl list devices -j"
                ? JSON.stringify({ devices: { runtime: [
                    { name: iosSimulatorName, udid: "SIM-UDID", state: "Shutdown" },
                    { name: "foreign-simulator", udid: "FOREIGN-SIM-UDID", state: "Shutdown" },
                ] } })
                : "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-provider-plan-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: {
                adb: "/fake/adb",
                xcrun: "/fake/xcrun",
                wsb: "/fake/wsb",
                tart: "/fake/tart",
            },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const windowsConfigPath = join(backendRoot(ownerId, "windows"), "win.wsb");
            const externalWindowsConfigPath = join(process.env.HOME!, "external-win.wsb");
            mkdirSync(dirname(windowsConfigPath), { recursive: true });
            writeFileSync(windowsConfigPath, "<Configuration><Networking>Disabled</Networking></Configuration>");
            writeFileSync(externalWindowsConfigPath, "host-secret-configuration");
            writeBrokerDevices(ownerId, "android-device", [{ id: "android-real", serial: "real-serial" }]);
            writeBrokerDevices(ownerId, "ios", [
                { id: "ios-sim", simulatorName: iosSimulatorName, udid: "SIM-UDID" },
                { id: "ios-forged", simulatorName: `ccc-${ownerId}-forged`, udid: "FOREIGN-SIM-UDID" },
            ]);
            writeBrokerDevices(ownerId, "ios-device", [{ id: "ios-real", udid: "REAL-UDID" }]);
            writeBrokerDevices(ownerId, "windows", [
                { id: "win", configPath: windowsConfigPath, sandboxId: "12345678-1234-4234-9234-1234567890ab" },
                { id: "win-external", configPath: externalWindowsConfigPath, sandboxId: "12345678-1234-4234-9234-1234567890ac" },
            ]);
            writeBrokerDevices(ownerId, "macos", [
                { id: "mac", provider: "tart", providerInstance: "ccc-mac" },
                { id: "mac-missing", provider: "tart" },
                { id: "mac-unsafe", provider: "/tmp/unsafe-provider", providerInstance: "ccc-mac" },
            ]);

            const cases = [
                { backend: "android-device", command: "device_status", deviceId: "android-real", provider: "adb", args: ["-s", "real-serial", "get-state"] },
                { backend: "ios-simulator", command: "device_stop", deviceId: "ios-sim", provider: "xcrun", args: ["simctl", "shutdown", "SIM-UDID"] },
                { backend: "ios-device", command: "device_status", deviceId: "ios-real", provider: "xcrun", args: ["devicectl", "device", "info", "details", "--device", "REAL-UDID"] },
                { backend: "windows-sandbox", command: "device_start", deviceId: "win", provider: "wsb", args: ["start", "--id", "12345678-1234-4234-9234-1234567890ab", "--config", "<Configuration><Networking>Disabled</Networking></Configuration>"] },
                { backend: "macos-vm", command: "device_stop", deviceId: "mac", provider: "tart", args: ["stop", "ccc-mac"] },
            ];
            for (const item of cases) {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ method: "broker.command.plan", params: item }),
                });
                expect(response.status).toBe(200);
                const body = await response.json() as { result: { providerCommand: { provider: string; executable: string; args: string[] } } };
                expect(body.result.providerCommand).toEqual(expect.objectContaining({
                    provider: item.provider,
                    executable: `/fake/${item.provider}`,
                    args: item.args,
                }));
            }

            const forged = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "ios-simulator", command: "device_start", deviceId: "ios-forged" },
                }),
            });
            expect(forged.status).toBe(400);
            expect(await forged.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "ios-simulator-owner-identity-mismatch",
            }));
            expect(commandRunner).not.toHaveBeenCalledWith(expect.objectContaining({
                args: ["simctl", "boot", "FOREIGN-SIM-UDID"],
            }), expect.anything());

            const externalConfig = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-external", dryRun: false },
                }),
            });
            expect(externalConfig.status).toBe(400);
            expect(await externalConfig.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "invalid-provider-metadata",
                missing: ["owner-scoped configPath"],
            }));
            expect(readFileSync(externalWindowsConfigPath, "utf8")).toBe("host-secret-configuration");

            const missing = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "android-real" },
                }),
            });
            expect(missing.status).toBe(404);
            expect(await missing.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-device-not-found" }));

            const missingMetadata = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "mac-missing", dryRun: false },
                }),
            });
            expect(missingMetadata.status).toBe(400);
            expect(await missingMetadata.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "missing-provider-metadata",
                missing: ["providerInstance"],
            }));

            const deleteMissingMetadata = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "macos-vm", command: "device_delete", deviceId: "mac-missing", force: true, dryRun: false },
                }),
            });
            expect(deleteMissingMetadata.status).toBe(200);
            const deleteMissingBody = await deleteMissingMetadata.json() as { ok: boolean; result: { device: unknown; execution: { providerExecution: string; command?: { mode?: string; provider?: string } } } };
            expect(deleteMissingBody.ok).toBe(true);
            expect(deleteMissingBody.result.device).toBeNull();
            expect(deleteMissingBody.result.execution.providerExecution).toBe("executed");
            expect(deleteMissingBody.result.execution.command).toEqual(expect.objectContaining({
                mode: "noop",
                provider: "host-broker-state",
            }));

            const unsafeProvider = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "mac-unsafe", dryRun: false },
                }),
            });
            expect(unsafeProvider.status).toBe(400);
            expect(await unsafeProvider.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "unsupported-provider-command",
                missing: ["provider"],
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    // Real /bin/sh executable integration; cross-platform runner contracts are tested above.
    it.skipIf(process.platform === "win32")("bounds default provider execution output, reports timeouts, and preserves state on failures", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-provider-failure-test");
        const ownerStateRoot = ownerRoot(ownerId);
        const windowsRoot = backendRoot(ownerId, "windows");
        const fakeWsb = join(ownerStateRoot, "fake-wsb");
        mkdirSync(windowsRoot, { recursive: true });
        writeFileSync(fakeWsb, [
            "#!/bin/sh",
            "case \"$5\" in",
            "  *slow*) sleep 1; exit 0 ;;",
            "  *loud*) head -c 40000 /dev/zero | tr \"\\0\" x; exit 7 ;;",
            "  *) echo provider failed >&2; exit 9 ;;",
            "esac",
            "",
        ].join("\n"));
        chmodSync(fakeWsb, 0o755);
        const failConfigPath = join(windowsRoot, "fail.wsb");
        const loudConfigPath = join(windowsRoot, "loud.wsb");
        const slowConfigPath = join(windowsRoot, "slow.wsb");
        writeFileSync(failConfigPath, "<Configuration>fail</Configuration>");
        writeFileSync(loudConfigPath, "<Configuration>loud</Configuration>");
        writeFileSync(slowConfigPath, "<Configuration>slow</Configuration>");
        writeBrokerDevices(ownerId, "windows", [
            { id: "win-fail", backend: "windows-sandbox", status: "stopped", configPath: failConfigPath, sandboxId: "12345678-1234-4234-9234-1234567890ab" },
            { id: "win-loud", backend: "windows-sandbox", status: "stopped", configPath: loudConfigPath, sandboxId: "12345678-1234-4234-9234-1234567890ac" },
            { id: "win-slow", backend: "windows-sandbox", status: "stopped", configPath: slowConfigPath, sandboxId: "12345678-1234-4234-9234-1234567890ad" },
        ]);

        const server = createDeviceBrokerServer({
            cwd: "/project/broker-provider-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: fakeWsb },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const failed = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-fail", dryRun: false },
                }),
            });
            expect(failed.status).toBe(502);
            const failedBody = await failed.json();
            expect(failedBody).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: "win-fail", status: "stopped" }),
                    execution: expect.objectContaining({
                        mutatesHost: false,
                        command: expect.objectContaining({
                            status: 9,
                            stderr: expect.stringContaining("provider failed"),
                        }),
                    }),
                }),
            }));
            expect(JSON.stringify(failedBody)).not.toContain("avdRoot");

            const loudServer = createDeviceBrokerServer({
                cwd: "/project/broker-provider-output-test",
                host: "127.0.0.1",
                port: 0,
                providerPaths: { wsb: fakeWsb },
            });
            const loudBaseUrl = await listen(loudServer);
            try {
                const loud = await fetch(`${loudBaseUrl}/v1/owners/${ownerId}/rpc`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.command.invoke",
                        params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-loud", dryRun: false },
                    }),
                });
                expect(loud.status).toBe(502);
                const loudBody = await loud.json() as { result: { execution: { command: { stdout: string; error?: string; timedOut?: boolean } } } };
                expect(loudBody.result.execution.command.stdout).toHaveLength(32768);
                expect(loudBody.result.execution.command.error).toContain("ENOBUFS");
                expect(loudBody.result.execution.command.timedOut).toBe(false);
            } finally {
                await close(loudServer);
            }

            const slowServer = createDeviceBrokerServer({
                cwd: "/project/broker-provider-timeout-test",
                host: "127.0.0.1",
                port: 0,
                providerPaths: { wsb: fakeWsb },
                commandTimeoutMs: 1,
            });
            const slowBaseUrl = await listen(slowServer);
            try {
                const timedOut = await fetch(`${slowBaseUrl}/v1/owners/${ownerId}/rpc`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.command.invoke",
                        params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-slow", dryRun: false },
                    }),
                });
                expect(timedOut.status).toBe(502);
                expect(await timedOut.json()).toEqual(expect.objectContaining({
                    ok: false,
                    error: "provider-command-failed",
                    result: expect.objectContaining({
                        execution: expect.objectContaining({
                            command: expect.objectContaining({ timedOut: true }),
                        }),
                    }),
                }));
            } finally {
                await close(slowServer);
            }

            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string; status: string }> };
            expect(state.devices).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: "win-fail", status: "stopped" }),
                expect.objectContaining({ id: "win-loud", status: "stopped" }),
                expect.objectContaining({ id: "win-slow", status: "stopped" }),
            ]));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("serializes Windows Sandbox starts with a host-wide broker lock", { timeout: 30000 }, async () => {
        const ownerId = deviceLabOwnerId("/project/broker-windows-singleton-test");
        const windowsRoot = backendRoot(ownerId, "windows");
        const firstConfigPath = join(windowsRoot, "first.wsb");
        const secondConfigPath = join(windowsRoot, "second.wsb");
        mkdirSync(windowsRoot, { recursive: true });
        writeFileSync(firstConfigPath, "<Configuration>first</Configuration>");
        writeFileSync(secondConfigPath, "<Configuration>second</Configuration>");
        const secondDeviceRoot = join(windowsRoot, "win-two");
        mkdirSync(secondDeviceRoot, { recursive: true });
        writeFileSync(join(secondDeviceRoot, "helper-artifact.txt"), "owned");
        writeBrokerDevices(ownerId, "windows", [
            { id: "win-one", backend: "windows-sandbox", status: "stopped", configPath: firstConfigPath },
            { id: "win-two", backend: "windows-sandbox", status: "stopped", configPath: secondConfigPath, sandboxId: "12345678-1234-4234-9234-1234567890bb" },
        ]);
        const staleLockPath = join(process.env.HOME!, ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(dirname(staleLockPath), { recursive: true });
        writeFileSync(staleLockPath, JSON.stringify({
            provider: "windows-sandbox",
            bootId: "previous-boot",
            ownerId: "foreign-owner",
            deviceId: "foreign-sandbox",
            sandboxId: "12345678-1234-4234-9234-1234567890ff",
        }));
        const commandRunner = vi.fn(() => ({ mode: "exec", provider: "wsb", status: 0, stdout: "", stderr: "" }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-windows-singleton-test",
            platform: "linux", // Simulated wsb CLI, without native window/session discovery.
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: "wsb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const firstStart = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-one", dryRun: false },
                }),
            });
            expect(firstStart.status).toBe(200);
            expect(commandRunner).toHaveBeenCalledTimes(1);
            const firstStartCommand = commandRunner.mock.calls[0][0] as { args: string[]; sandboxId?: string };
            expect(firstStartCommand.args[0]).toBe("start");
            expect(firstStartCommand.args[2]).toMatch(/^[0-9a-f-]{36}$/);
            expect(firstStartCommand.sandboxId).toBe(firstStartCommand.args[2]);

            const blockedSecondStart = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-two", dryRun: false },
                }),
            });
            expect(blockedSecondStart.status).toBe(409);
            expect(await blockedSecondStart.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "windows-sandbox-host-busy",
                detail: expect.stringContaining("Windows Sandbox is already claimed on this host"),
                lock: expect.objectContaining({ ownerId, deviceId: "win-one" }),
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);

            const firstStop = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_stop", deviceId: "win-one", dryRun: false },
                }),
            });
            expect(firstStop.status).toBe(200);
            expect(commandRunner).toHaveBeenCalledTimes(2);
            expect((commandRunner.mock.calls[1][0] as { args: string[] }).args).toEqual(["stop", "--id", firstStartCommand.args[2]]);

            const secondStart = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-two", dryRun: false },
                }),
            });
            expect(secondStart.status).toBe(200);
            expect(commandRunner).toHaveBeenCalledTimes(3);

            const runningDelete = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_delete", deviceId: "win-two", dryRun: false },
                }),
            });
            expect(runningDelete.status).toBe(200);
            expect(await runningDelete.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    windowsDeviceArtifactCleanup: expect.objectContaining({
                        ok: true,
                        removed: true,
                        deviceRoot: secondDeviceRoot,
                    }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledTimes(4);
            expect((commandRunner.mock.calls[3][0] as { args: string[] }).args).toEqual(["stop", "--id", "12345678-1234-4234-9234-1234567890bb"]);
            expect(existsSync(secondDeviceRoot)).toBe(false);
            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string }> };
            expect(state.devices.some((device) => device.id === "win-two")).toBe(false);

            const restartAfterDelete = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-one", dryRun: false },
                }),
            });
            expect(restartAfterDelete.status).toBe(200);
            expect(commandRunner).toHaveBeenCalledTimes(5);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves Windows device state when owner artifact cleanup fails", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-windows-delete-cleanup-failure-test");
        const windowsRoot = backendRoot(ownerId, "windows");
        const deviceRoot = join(windowsRoot, "win-cleanup-failure");
        mkdirSync(deviceRoot, { recursive: true });
        writeFileSync(join(deviceRoot, "owned.txt"), "preserve");
        writeBrokerDevices(ownerId, "windows", [
            { id: "win-cleanup-failure", backend: "windows-sandbox", status: "stopped" },
        ]);
        const windowsDeviceArtifactCleaner = vi.fn(() => ({
            ok: false,
            removed: false,
            deviceRoot,
            error: "simulated-access-denied",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-windows-delete-cleanup-failure-test",
            host: "127.0.0.1",
            port: 0,
            commandRunner: vi.fn((command) => ({ mode: command.mode, provider: command.provider, status: 0, stdout: "", stderr: "" })),
            windowsDeviceArtifactCleaner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_delete", deviceId: "win-cleanup-failure", dryRun: false },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "windows-sandbox-device-artifact-cleanup-failed",
                result: expect.objectContaining({
                    windowsDeviceArtifactCleanup: expect.objectContaining({ error: "simulated-access-denied" }),
                }),
            }));
            expect(windowsDeviceArtifactCleaner).toHaveBeenCalledWith(ownerId, "win-cleanup-failure");
            expect(existsSync(deviceRoot)).toBe(true);
            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string }> };
            expect(state.devices.some((device) => device.id === "win-cleanup-failure")).toBe(true);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rejects malformed Windows Sandbox ownership state before invoking the provider", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-windows-malformed-lock-test");
        const windowsRoot = backendRoot(ownerId, "windows");
        const configPath = join(windowsRoot, "malformed-lock.wsb");
        mkdirSync(windowsRoot, { recursive: true });
        writeFileSync(configPath, "<Configuration />");
        writeBrokerDevices(ownerId, "windows", [
            { id: "win-malformed-lock", backend: "windows-sandbox", status: "stopped", configPath },
        ]);
        const lockPath = join(process.env.HOME!, ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, "{not-json");
        const commandRunner = vi.fn(() => ({ mode: "exec", provider: "wsb", status: 0, stdout: "", stderr: "" }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-windows-malformed-lock-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: "wsb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-malformed-lock", dryRun: false },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "windows-sandbox-lock-state-invalid",
            }));
            expect(readFileSync(lockPath, "utf8")).toBe("{not-json");
            expect(commandRunner).not.toHaveBeenCalled();
        } finally {
            await close(server);
            rmSync(lockPath, { force: true });
            cleanupOwner(ownerId);
        }
    });

    it("reports detached provider startup failures before mutating owner state", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-detached-failure-test");
        const ownerStateRoot = ownerRoot(ownerId);
        const androidRoot = writeBrokerDevices(ownerId, "android", [{ id: "android-detached-missing", backend: "android-emulator", status: "stopped", avdName: "ccc-missing-provider", port: 5592 }]);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-detached-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { emulator: join(ownerStateRoot, "missing-emulator") },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-detached-missing", dryRun: false },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: "android-detached-missing", status: "stopped" }),
                    execution: expect.objectContaining({
                        mode: "detached",
                        mutatesHost: false,
                        command: expect.objectContaining({
                            provider: "emulator",
                            error: "executable-not-found",
                            status: null,
                        }),
                    }),
                }),
            }));
            const state = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string; status: string }> };
            expect(state.devices).toEqual([expect.objectContaining({ id: "android-detached-missing", status: "stopped" })]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });
});

vi.mock("fs", async (importOriginal) => ({ ...await importOriginal<typeof import("fs")>() }));
