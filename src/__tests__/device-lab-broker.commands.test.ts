import { spawn } from "child_process";
import { createHash } from "crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { request } from "http";
import { hostname, tmpdir, uptime } from "os";
import { dirname, join } from "path";
import { runInNewContext } from "vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer, hiddenChildProcessOptions, hiddenProviderCommandEnv, providerCommandSpawn, redactProviderCommandInput, registerDeviceBrokerOwner, waitForBrokerWindowsMinimizeConfirmation, windowsHiddenChildProcessPreloadScript, windowsHiddenVbsLauncherInvocation, windowsHiddenVbsLauncherScript, windowsProcessTreeOutcome, windowsSandboxMinimizeWatchdogArgs, windowsSandboxSessionIdsFromBrokerListOutput, windowsSandboxWindowHandleSnapshotArgs, windowsSandboxWindowHandlesFromOutput } from "../device-lab-broker.js";
import { deviceLabOwnerId, deviceLabProjectMountPath } from "../device-lab-owner.js";
import { readDeviceRuntimeProcessIdentity } from "../device-lab-process-identity.js";
import { withSharedMutationLockAsync } from "../device-lab-shared-state.js";
import { hyperVVmName } from "../host-control/hyper-v/index.js";
import { backendRoot, cleanupOwner, close, listen, ownerRoot, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";

function providerScript(command: { args: string[]; input?: string }): string {
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

    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-device-broker-test-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
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

    it.each([
        ["missing deleted", JSON.stringify({ ok: true, snapshotId: "87654321-4321-4321-4321-cba987654321", snapshotName: "placeholder" })],
        ["false deleted", JSON.stringify({ ok: true, snapshotId: "87654321-4321-4321-4321-cba987654321", snapshotName: "placeholder", deleted: false })],
        ["malformed output", "not-json"],
    ])("preserves snapshot journal evidence when create rollback returns %s", async (_name, rollbackOutput) => {
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
        const commandRunner = vi.fn((command) => {
            const script = providerScript(command);
            if (script.includes("$Snapshots = @(Get-VMSnapshot")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId, vmName, state: "Off", status: "Operating normally", diskPath, checkpointPolicy: "ProductionOnly", snapshots: [] }), stderr: "" };
            }
            if (script.includes("Checkpoint-VM") || script.includes("New-CccVmSnapshot")) {
                const state = JSON.parse(readFileSync(stateFile, "utf8"));
                writeFileSync(stateFile, JSON.stringify({ devices: state.devices.map((device: Record<string, unknown>) => ({ ...device, concurrentMutation: true })) }));
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, snapshotId, snapshotName: providerName, snapshotType: "Recovery" }), stderr: "" };
            }
            if (script.includes("Remove-VMSnapshot")) {
                return {
                    ...command,
                    executable: `C:\\host-secret\\${rollbackSecret}\\powershell.exe`,
                    args: ["-EncodedCommand", rollbackSecret],
                    status: 0,
                    stdout: rollbackOutput.replace("placeholder", providerName),
                    stderr: "",
                    error: `host error at C:\\host-secret\\${rollbackSecret}`,
                };
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
        let snapshotExists = false;
        let orphanRecoveryCalls = 0;
        let preparedSourcePath = "";
        let networkCleanupFailure: false | "nonzero" | "invalid" | "in-use" = false;
        let deleteConfirmationFailure = false;
        let snapshotDeleteConfirmationFailure = false;
        let snapshotProviderFailure = false;
        let snapshotRestoreProviderFailure = false;
        let restoreRetryJournalObserved = false;
        let checkpointPolicy: "Disabled" | "ProductionOnly" = "ProductionOnly";
        const commandRunner = vi.fn((command) => {
            const script = providerScript(command);
            if (script.includes("Start-VM")) vmState = "Running";
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
            if (vmCreate) vmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
            if (orphanRecovery) orphanRecoveryCalls += 1;
            const guestProvision = script.includes("Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND'");
            const guestReady = script.includes("hyper-v-guest-ready-timeout");
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
                    : { ok: true, vmId, vmName, state: vmState, status: "Operating normally", generation: 2, diskPath, checkpointPolicy, snapshots: snapshotExists ? [{ snapshotId, snapshotName: `ccc-${ownerId}-before-install`, snapshotType: "Recovery" }] : [], ...(deleting ? { deleted: !deleteConfirmationFailure } : {}) }),
                stderr: snapshotOperation
                    ? "host path C:\\snapshot-provider-host-secret"
                    : "",
            };
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
            expect(commandRunner.mock.calls.some(([command]) => {
                const script = providerScript(command);
                return script.includes(`$ExpectedBaseImageHash = '${imageSha256}'`)
                    && script.includes(`$BaseImage = '${imagePath.replaceAll("'", "''")}'`)
                    && script.includes("[IO.FileShare]::Read")
                    && script.includes("$DiskCopySource.CopyTo($DiskCopyOutput, 8MB)")
                    && script.includes("hyper-v-created-disk-format-mismatch");
            })).toBe(true);
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
            expect(await status.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ vmId, runtimeState: "Running" }) }) }));
            expect(existsSync(operationPath)).toBe(false);

            const guestExec = await invokeTool("device_exec", { command: "Write-Output guest-ok" });
            expect(guestExec.status).toBe(200);
            expect(await guestExec.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ provider: "hyper-v-powershell-direct", stdout: "guest-ok\r\n", status: 0 }) }));

            const uploaded = await invokeTool("device_upload", { localPath: uploadPath, remotePath: "C:\\ccc\\upload.txt" });
            expect(uploaded.status).toBe(200);
            expect(await uploaded.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ provider: "hyper-v-powershell-direct", bytes: 6 }) }));

            const largeUploadPath = join(cwd, "packaged-node.exe");
            writeFileSync(largeUploadPath, Buffer.alloc(16 * 1024 * 1024 + 1));
            const largeUpload = await invokeTool("device_upload", { localPath: largeUploadPath, remotePath: "C:\\ccc\\node.exe", maxFileBytes: 128 * 1024 * 1024 });
            expect(largeUpload.status, JSON.stringify(await largeUpload.clone().json())).toBe(200);

            const downloaded = await invokeTool("device_download", { remotePath: "C:\\ccc\\download.txt", localPath: downloadPath });
            expect(downloaded.status).toBe(200);
            expect(await downloaded.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ provider: "hyper-v-powershell-direct", remotePath: "C:\\ccc\\download.txt" }) }));

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
            expect(failedRestore.status).toBe(409);
            expect(await failedRestore.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-restore-outcome-indeterminate" }));
            expect((JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as { devices: Array<{ activeSnapshotId?: string | null }> }).devices[0].activeSnapshotId ?? null).toBeNull();
            expect(existsSync(join(deviceRoot, "snapshot-operation.json"))).toBe(true);
            const retriedRestore = await invokeTool("device_snapshot_restore", { snapshotId, confirmDestructive: true });
            expect(retriedRestore.status).toBe(200);
            expect(await retriedRestore.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ activeSnapshotId: snapshotId }) }) }));
            expect(restoreRetryJournalObserved).toBe(true);

            snapshotProviderFailure = true;
            const failedSnapshot = await invokeTool("device_snapshot_create", { snapshotName: "provider-failure" });
            expect(failedSnapshot.status).toBe(502);
            expect(await failedSnapshot.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-provider-failed" }));
            snapshotProviderFailure = false;

            const snapshotOperationPath = join(deviceRoot, "snapshot-operation.json");
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

            writeFileSync(networkStatePath, validNetworkState);
            networkCleanupFailure = "nonzero";
            const providerCleanupFailed = await invoke({ backend: "windows-vm", command: "device_delete", deviceId, incarnationId });
            expect(providerCleanupFailed.status).toBe(502);
            const providerCleanupFailureBody = await providerCleanupFailed.json();
            expect(providerCleanupFailureBody).toEqual(expect.objectContaining({
                error: "hyper-v-delete-reconciliation-cleanup-failed",
                detail: expect.stringContaining("hyper-v-network-cleanup-failed"),
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
                detail: expect.stringContaining(
                    "hyper-v-network-cleanup-invalid-result",
                ),
            }));
            expect(JSON.stringify(invalidProviderCleanupBody))
                .not.toContain("network-cleanup-invalid-secret");
            expect(existsSync(networkStatePath)).toBe(true);
            writeFileSync(networkStatePath, validNetworkState);
            networkCleanupFailure = "in-use";
            const deleted = await invoke({ backend: "windows-vm", command: "device_delete", deviceId, incarnationId });
            expect(deleted.status).toBe(200);
            expect(existsSync(privateRoot)).toBe(false);
            expect((JSON.parse(readFileSync(join(backendRoot(ownerId, "windows-vm"), "devices.json"), "utf8")) as { devices: unknown[] }).devices).toEqual([]);
            expect(JSON.parse(readFileSync(networkStatePath, "utf8"))).toMatchObject({ allocations: [] });

            networkCleanupFailure = false;
            const recreated = await invoke({ backend: "windows-vm", command: "device_create", deviceId, name: "Windows VM E2E cached", profile: "windows-11", memoryMb: 4096, cpus: 2 });
            expect(recreated.status).toBe(200);
            const recreatedIncarnationId = (await recreated.clone().json()).result.device.incarnationId as string;
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
            expect(commandRunner.mock.calls.filter(([command]) => providerScript(command).includes("hyper-v-base-image-profile-conflict"))).toHaveLength(1);
            expect(commandRunner.mock.calls.filter(([command]) => providerScript(command).includes("hyper-v-orphan-vm-ownership-mismatch"))).toHaveLength(1);
            expect(commandRunner.mock.calls.filter(([command]) => providerScript(command).includes("New-NetNat -Name $NatName"))).toHaveLength(2);
            expect(commandRunner.mock.calls.filter(([command]) => isHyperVNetworkCleanupScript(providerScript(command)))).toHaveLength(4);
            const snapshotRepairCalls = commandRunner.mock.calls.filter(([command]) => providerScript(command).includes("Repair-CccVmSnapshotState"));
            expect(snapshotRepairCalls).toHaveLength(6);
            for (const [command] of snapshotRepairCalls) {
                expect(JSON.parse(command.input)).toMatchObject({ expectedCheckpointPolicy: "ProductionOnly" });
            }
            expect(commandRunner).toHaveBeenCalledTimes(51);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(imageProfileRoot, { recursive: true, force: true });
        }
    });

    it("rolls back Hyper-V resources when create output cannot be trusted", async () => {
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
        const variants = ["nonzero", "timeout", "overflow", "malformed", "wrong-name", "wrong-disk", "artifact-cleanup-failure", "allocation-cleanup-failure", "provision-failure", "provision-ownership-failure", "provision-untagged-failure", "state-claim-conflict"] as const;
        const cleanupOutside = join(cwd, "cleanup-outside");
        mkdirSync(cleanupOutside, { recursive: true });
        let createIndex = 0;
        let recoveryCalls = 0;
        let activeVariant: typeof variants[number] | null = null;
        const provisioningSecretEcho = "hyper-v-secret-provider-echo";
        const rollbackSecretEcho = "hyper-v-rollback-provider-echo";
        const createdVmNames = new Map<string, string>();
        const commandRunner = vi.fn((command) => {
            const script = providerScript(command);
            if (isHyperVNetworkCleanupScript(script)) {
                return { mode: command.mode, provider: command.provider, status: 0, stdout: JSON.stringify({ ok: true, removedSwitch: true, removedNat: true, removedGateway: true, alreadyMissing: false }), stderr: "" };
            }
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                recoveryCalls += 1;
                const recoveryVmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                expect(script).toContain("if ([string]$Vm.Notes -and [string]$Vm.Notes -cne $ExpectedMarker)");
                expect(recoveryVmName).toBe(createdVmNames.get(`invalid-create-${activeVariant}`));
                return {
                    mode: command.mode,
                    provider: command.provider,
                    executable: `C:\\host-secret\\${rollbackSecretEcho}\\powershell.exe`,
                    args: ["-EncodedCommand", rollbackSecretEcho],
                    status: 0,
                    stdout: JSON.stringify({ ok: true, recoveredVm: true, removedDisk: true }),
                    stderr: "",
                };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                return { mode: command.mode, provider: command.provider, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command)), stderr: "" };
            }
            if (script.includes("Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND'")
                && (activeVariant === "provision-failure" || activeVariant === "provision-ownership-failure" || activeVariant === "provision-untagged-failure" || activeVariant === "state-claim-conflict")) {
                const deviceId = `invalid-create-${activeVariant}`;
                const vmName = script.match(/\$ExpectedName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", deviceId);
                const deviceRoot = join(privateRoot, "artifacts");
                const credentialPath = join(privateRoot, "secrets", "guest.credential.xml");
                const provisioningMediaPath = join(deviceRoot, "disks", "autounattend.iso");
                mkdirSync(dirname(credentialPath), { recursive: true });
                writeFileSync(credentialPath, "fake-dpapi-credential");
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
                const stateFile = join(backendRoot(ownerId, "windows-vm"), "devices.json");
                mkdirSync(dirname(stateFile), { recursive: true });
                writeFileSync(stateFile, JSON.stringify({ devices: [{ id: deviceId, backend: "windows-vm", ownerId, vmId: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb", vmName: "foreign-vm", diskPath: join(cwd, "foreign.vhdx"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
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
                    symlinkSync(cleanupOutside, privateRoot, "dir");
                }
                if (variant === "allocation-cleanup-failure") {
                    const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
                    writeFileSync(networkStatePath, "{malformed");
                }
                const stdout = variant === "malformed" || variant === "artifact-cleanup-failure" || variant === "allocation-cleanup-failure"
                    ? "not-json"
                    : JSON.stringify({ ok: true, vmId: "12345678-1234-1234-1234-123456789abc", vmName: variant === "wrong-name" ? "foreign-vm" : vmName, generation: 2, diskPath: variant === "wrong-disk" ? join(cwd, "foreign.vhdx") : diskPath });
                return { mode: command.mode, provider: command.provider, status: 0, stdout, stderr: "" };
            }
            throw new Error("unexpected Hyper-V command");
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
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "windows-vm", command: "device_create", deviceId: `invalid-create-${variant}`, name: "Invalid VM", profile: "windows-11" } }),
                });
                const body = await response.json();
                expect(JSON.stringify(body)).not.toContain(rollbackSecretEcho);
                expect(response.status, JSON.stringify(body)).toBe(variant === "state-claim-conflict" ? 409 : 502);
                const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "windows-vm", `invalid-create-${variant}`);
                const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
                if (variant === "artifact-cleanup-failure") {
                    expect(body).toEqual(expect.objectContaining({ error: "hyper-v-create-invalid-result", rollback: expect.objectContaining({ ok: false, error: "hyper-v-recovery-cleanup-failed" }) }));
                    expect(lstatSync(privateRoot).isSymbolicLink()).toBe(true);
                    const allocations = existsSync(networkStatePath) ? JSON.parse(readFileSync(networkStatePath, "utf8")).allocations : [];
                    expect(allocations).not.toEqual(expect.arrayContaining([expect.objectContaining({ ownerId, deviceId: `invalid-create-${variant}` })]));
                    rmSync(privateRoot, { force: true });
                } else if (variant === "allocation-cleanup-failure") {
                    expect(body).toEqual(expect.objectContaining({ error: "hyper-v-create-invalid-result", rollback: expect.objectContaining({ ok: false, error: "hyper-v-recovery-cleanup-failed" }) }));
                    expect(existsSync(privateRoot)).toBe(true);
                    rmSync(networkStatePath, { force: true });
                } else if (variant === "provision-failure" || variant === "provision-ownership-failure" || variant === "provision-untagged-failure" || variant === "state-claim-conflict") {
                    expect(body).toEqual(expect.objectContaining({
                        error: variant === "state-claim-conflict" ? "owner-device-id-conflict" : "hyper-v-guest-provision-failed",
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
                    expect(existsSync(privateRoot)).toBe(false);
                    const allocations = existsSync(networkStatePath) ? JSON.parse(readFileSync(networkStatePath, "utf8")).allocations : [];
                    expect(allocations).not.toEqual(expect.arrayContaining([expect.objectContaining({ ownerId, deviceId: `invalid-create-${variant}` })]));
                } else {
                    expect(body).toEqual(expect.objectContaining({
                        error: ["nonzero", "timeout", "overflow"].includes(variant) ? "provider-command-failed" : "hyper-v-create-invalid-result",
                        rollback: expect.objectContaining({ ok: true, recoveredVm: true, removedDisk: true }),
                    }));
                    if (variant === "nonzero") {
                        expect(body.detail).toBe("hyper-v-vm-create-failed");
                        expect(JSON.stringify(body)).not.toContain("host-specific secret");
                    }
                    expect(existsSync(privateRoot)).toBe(false);
                    const allocations = existsSync(networkStatePath) ? JSON.parse(readFileSync(networkStatePath, "utf8")).allocations : [];
                    expect(allocations).not.toEqual(expect.arrayContaining([expect.objectContaining({ ownerId, deviceId: `invalid-create-${variant}` })]));
                }
            }
            expect(createIndex).toBe(12);
            expect(recoveryCalls).toBe(12);
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
        const commandRunner = vi.fn((command) => {
            if (failStateWrite && command.provider === "android-device") chmodSync(root, 0o500);
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
                args: ["run", `ccc-${ownerId}-macos-broker-mac`],
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
        const hostProjectPath = "/project/broker-readonly-device-test";
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
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-inferred-hyper-v-lock-test",
            host: "127.0.0.1",
            port: 0,
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
            const request = fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_snapshot_list", deviceId },
                }),
            }).finally(() => { requestSettled = true; });
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(requestSettled).toBe(false);

            releaseLock();
            await held;
            expect([400, 501]).toContain((await request).status);
        } finally {
            if (releaseLock) releaseLock();
            await held;
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("times out incomplete HTTP request bodies", async () => {
        const hostProjectPath = "/project/broker-request-body-timeout-test";
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
            providerPaths: { avdmanager: "C:\\Android\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat" },
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
            stdout: "created avd",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-android-port-lock-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { avdmanager: "/fake/avdmanager" },
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
            expect(commandRunner).toHaveBeenCalledTimes(1);
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

    it("keeps broker desktop device tool child execution independent from short provider command timeouts", async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-device-tool-runner-"));
        const backendDir = join(fakeRoot, "device-lab-mcp", "src", "backends");
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
        const server = createDeviceBrokerServer({
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
        const backendDir = join(fakeRoot, "device-lab-mcp", "src", "backends");
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
        const server = createDeviceBrokerServer({
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
                ["device_exec", { command: "Write-Output ok" }],
                ["device_screenshot"],
                ["device_click", { x: 1, y: 2 }],
                ["device_double_click", { x: 3, y: 4 }],
                ["device_key", { key: "Escape" }],
                ["device_type", { text: "hello" }],
                ["device_scroll", { direction: "down", amount: 2 }],
                ["device_cursor_position"],
                ["device_window_list"],
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
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(fakeRoot, { recursive: true, force: true });
        }
    });

    it("routes macOS VM broker device tools through the macOS backend child handler", async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-macos-device-tool-runner-"));
        const backendDir = join(fakeRoot, "device-lab-mcp", "src", "backends");
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
        const server = createDeviceBrokerServer({
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

    it("routes Android broker device tools through Android backend child handlers", async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-android-device-tool-runner-"));
        const backendDir = join(fakeRoot, "device-lab-mcp", "src", "backends");
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
        const server = createDeviceBrokerServer({
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

    it("routes iOS broker device tools through iOS backend child handlers", async () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), "ccc-ios-device-tool-runner-"));
        const backendDir = join(fakeRoot, "device-lab-mcp", "src", "backends");
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
        const server = createDeviceBrokerServer({
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
        const hostProjectPath = "/project/broker-recording-test";
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
            expect(start.status).toBe(200);
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

    it("persists process identity for a default-runner broker recording", async () => {
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

    it("finalizes Android recording when the owned host recorder exits but remote pkill is denied", async () => {
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

    it("keeps recording state active when a default-runner recorder does not exit on stop", async () => {
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

    it("reports observed Android status and clears auxiliary runtime on stop", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-android-observed-status-test");
        const androidRoot = writeBrokerDevices(ownerId, "android", [{
            id: "android-observed-runtime",
            backend: "android-emulator",
            status: "stopped",
            avdName: "ccc-observed-runtime",
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
            stdout: command.args?.includes("get-state") ? "device\n" : "",
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
        const firstPath = first?.NODE_OPTIONS?.match(/--require="([^"]+)"/)?.[1];
        const secondPath = second?.NODE_OPTIONS?.match(/--require="([^"]+)"/)?.[1];

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
        symlinkSync(externalDirectory, launchersDirectory);

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
        symlinkSync(externalDirectory, providerDirectory);

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

    it("bounds default provider execution output, reports timeouts, and preserves state on failures", async () => {
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

    it("serializes Windows Sandbox starts with a host-wide broker lock", async () => {
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
