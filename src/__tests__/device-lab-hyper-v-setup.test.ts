import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devicesCliAsync, setupHyperVHost, spawnableWindowsExecutablePath } from "../device-lab-admin.js";
import { hyperVSetupCommand } from "../device-lab/providers/hyper-v.js";
import {
    HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
    HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
    readHyperVWindowsEvaluationReceipt,
} from "../device-lab/hyper-v-images.js";

describe("Hyper-V host setup CLI", () => {
    const roots: string[] = [];
    const setupNetwork = {
        ok: true,
        switchName: "CCC Device Lab",
        switchId: "11111111-2222-4333-8444-555555555555",
        natName: "CCCDeviceLab",
        natInstanceId: "ccc-network-instance-1",
        prefix: "172.29.0.0/24",
        gateway: "172.29.0.1",
        interfaceIndex: 42,
        createdSwitch: true,
        createdNat: true,
    };

    afterEach(() => {
        vi.restoreAllMocks();
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("converts a verified extended DOS executable path into a spawn-compatible path", () => {
        expect(spawnableWindowsExecutablePath("\\\\?\\C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
            .toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        expect(spawnableWindowsExecutablePath("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
            .toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        expect(spawnableWindowsExecutablePath("\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
            .toBeNull();
        expect(spawnableWindowsExecutablePath("\\\\?\\UNC\\server\\share\\powershell.exe")).toBeNull();
    });

    it("runs diagnostics without enabling Windows features when confirmation is absent", () => {
        const root = join(tmpdir(), `ccc-hyper-v-diagnostic-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const runner = vi.fn(() => ({
            command: "powershell.exe",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                available: false,
                platform: "win32",
                moduleAvailable: false,
                hypervisorPresent: false,
                vmmsRunning: false,
                rebootPending: false,
                totalMemoryMb: 32768,
                freeMemoryMb: 16384,
                logicalProcessors: 16,
                missing: ["hyper-v-powershell-module", "hypervisor", "vmms-service"],
            }),
            stderr: "",
        }));

        const result = setupHyperVHost(false, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: runner,
        });

        expect(result.ok).toBe(true);
        expect(result.text).toContain("mode: diagnostic");
        expect(result.text).toContain("verify that the Windows edition supports Hyper-V and firmware virtualization is enabled");
        expect(result.text).toContain("ccc devices setup hyper-v --confirm");
        expect(result.text).toContain("start the Hyper-V Virtual Machine Management (vmms) service");
        expect(result.text).toContain("windowsEvaluationLicenseAccepted: false");
        const encodedScript = Buffer.from(runner.mock.calls[0][1].at(-1), "base64").toString("utf16le");
        expect(encodedScript).not.toContain("Enable-WindowsOptionalFeature");
    });

    it("records explicit Windows evaluation license acceptance and reports it later", () => {
        const root = join(tmpdir(), `ccc-hyper-v-license-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const mutationLockFile = join(root, "host-locks", "hyper-v.mutation.lock");
        const runner = vi.fn(() => {
            expect(existsSync(mutationLockFile)).toBe(true);
            expect(existsSync(join(root, "network", "hyper-v.json"))).toBe(false);
            return {
                command: "powershell.exe",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    featureName: "Microsoft-Hyper-V-All",
                    beforeState: "Enabled",
                    afterState: "Enabled",
                    changed: false,
                    elevated: true,
                    rebootRequired: false,
                    network: setupNetwork,
                }),
                stderr: "",
            };
        });

        const accepted = setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: runner,
            acceptWindowsEvaluationLicense: true,
        });

        expect(accepted.ok).toBe(true);
        expect(accepted.text).toContain("windowsEvaluationLicenseAccepted: true");
        expect(accepted.text).toContain("windowsEvaluationImageSourceTrust: microsoft-evaluation-https-tofu-v1");
        expect(accepted.text).toContain("networkPrepared: true");
        expect(existsSync(mutationLockFile)).toBe(false);
        expect(JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8"))).toMatchObject({
            switchId: setupNetwork.switchId,
            natInstanceId: setupNetwork.natInstanceId,
            managedNat: false,
            allocations: [],
        });
        const receiptPath = join(root, "hyper-v-windows-evaluation-license.json");
        expect(existsSync(receiptPath)).toBe(true);
        expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
            version: 2,
            licenseId: "windows-server-2025-evaluation",
            sourceTrustId: "microsoft-evaluation-https-tofu-v1",
            sourceUrl: "https://go.microsoft.com/fwlink/?clcid=0x409&country=us&culture=en-us&linkid=2345826",
        });
    });

    it("preserves an existing evaluation-license acceptance after the trust label was clarified", () => {
        const root = join(tmpdir(), `ccc-hyper-v-legacy-license-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "hyper-v-windows-evaluation-license.json"), JSON.stringify({
            version: 2,
            licenseId: HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
            licenseUrl: HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
            sourceTrustId: "microsoft-evaluation-allowlisted-https-v1",
            sourceUrl: "https://go.microsoft.com/fwlink/?clcid=0x409&country=us&culture=en-us&linkid=2345826",
            acceptedAt: "2026-07-01T00:00:00.000Z",
        }));

        expect(readHyperVWindowsEvaluationReceipt(root)).toEqual(expect.objectContaining({
            sourceTrustId: "microsoft-evaluation-https-tofu-v1",
            acceptedAt: "2026-07-01T00:00:00.000Z",
        }));
    });

    it("does not overwrite a matching network identity with malformed allocations", () => {
        const root = join(tmpdir(), `ccc-hyper-v-network-state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const networkRoot = join(root, "network");
        const stateFile = join(networkRoot, "hyper-v.json");
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(stateFile, JSON.stringify({
            version: 1,
            switchName: setupNetwork.switchName,
            switchId: setupNetwork.switchId,
            marker: "ccc-device-lab:hyper-v-network:v1",
            natName: setupNetwork.natName,
            natInstanceId: setupNetwork.natInstanceId,
            prefix: setupNetwork.prefix,
            gateway: setupNetwork.gateway,
            outboundPolicy: "nat",
            managedNat: false,
            allocations: [{ ownerId: "../outside" }],
        }));
        const original = readFileSync(stateFile, "utf8");
        const runner = vi.fn(() => ({
            command: "powershell.exe",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                featureName: "Microsoft-Hyper-V-All",
                beforeState: "Enabled",
                afterState: "Enabled",
                changed: false,
                elevated: true,
                rebootRequired: false,
                network: setupNetwork,
            }),
            stderr: "",
        }));

        const result = setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: runner,
        });

        expect(result).toEqual({
            ok: false,
            text: "CCC Hyper-V setup failed: hyper-v-network-state-identity-conflict",
        });
        expect(readFileSync(stateFile, "utf8")).toBe(original);
    });

    it("preserves valid existing network allocations while refreshing setup identity", () => {
        const root = join(tmpdir(), `ccc-hyper-v-network-preserve-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const networkRoot = join(root, "network");
        const stateFile = join(networkRoot, "hyper-v.json");
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(stateFile, JSON.stringify({
            version: 1,
            switchName: setupNetwork.switchName,
            switchId: setupNetwork.switchId,
            marker: "ccc-device-lab:hyper-v-network:v1",
            natName: setupNetwork.natName,
            natInstanceId: setupNetwork.natInstanceId,
            prefix: setupNetwork.prefix,
            gateway: setupNetwork.gateway,
            outboundPolicy: "nat",
            managedNat: false,
            allocations: [{
                ownerId: "0123456789abcdef",
                deviceId: "windows-vm-1",
                incarnationId: "0123456789abcdef0123456789abcdef",
                address: "172.29.0.10",
                allocatedAt: "2026-07-23T00:00:00.000Z",
            }],
        }));
        const runner = vi.fn(() => ({
            command: "powershell.exe",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                featureName: "Microsoft-Hyper-V-All",
                beforeState: "Enabled",
                afterState: "Enabled",
                changed: false,
                elevated: true,
                rebootRequired: false,
                network: setupNetwork,
            }),
            stderr: "",
        }));

        const result = setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: runner,
        });

        expect(result.ok).toBe(true);
        expect(JSON.parse(readFileSync(stateFile, "utf8")).allocations).toEqual([
            expect.objectContaining({
                ownerId: "0123456789abcdef",
                deviceId: "windows-vm-1",
                address: "172.29.0.10",
                macAddress: expect.stringMatching(/^02(?::[a-f0-9]{2}){5}$/),
            }),
        ]);
    });

    it.each([
        ["malformed JSON", "{"],
        ["oversized content", " ".repeat(4097)],
        ["wrong legal fields", JSON.stringify({
            version: 2,
            licenseId: "different-license",
            licenseUrl: "https://example.invalid/license",
            acceptedAt: "2026-01-01T00:00:00.000Z",
        })],
        ["invalid acceptance timestamp", JSON.stringify({
            version: 2,
            licenseId: HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
            licenseUrl: HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
            sourceTrustId: "microsoft-evaluation-https-tofu-v1",
            sourceUrl: "https://go.microsoft.com/fwlink/?clcid=0x409&country=us&culture=en-us&linkid=2345826",
            acceptedAt: "not-a-timestamp",
        })],
    ])("fails closed for a %s receipt", (_case, content) => {
        const root = join(tmpdir(), `ccc-hyper-v-invalid-license-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "hyper-v-windows-evaluation-license.json"), content);

        expect(() => readHyperVWindowsEvaluationReceipt(root)).toThrow(/hyper-v-windows-evaluation-license/);
    });

    it("does not suggest feature installation for a VMMS-only failure", () => {
        const runner = vi.fn(() => ({
            command: "powershell.exe",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                available: false,
                platform: "win32",
                moduleAvailable: true,
                hypervisorPresent: true,
                vmmsRunning: false,
                rebootPending: false,
                totalMemoryMb: 32768,
                freeMemoryMb: 16384,
                logicalProcessors: 16,
                missing: ["vmms-service"],
            }),
            stderr: "",
        }));

        const result = setupHyperVHost(false, { platform: "win32", powershell: "powershell.exe", commandRunner: runner });

        expect(result.ok).toBe(true);
        expect(result.text).toContain("start the Hyper-V Virtual Machine Management (vmms) service");
        expect(result.text).not.toContain("verify that the Windows edition supports Hyper-V");
    });

    it("enables Hyper-V only through the confirmed setup path and reports a pending reboot", () => {
        const root = join(tmpdir(), `ccc-hyper-v-setup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        mkdirSync(root, { recursive: true });
        const runner = vi.fn(() => ({
            command: "powershell.exe",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                featureName: "Microsoft-Hyper-V-All",
                beforeState: "Disabled",
                afterState: "Enabled",
                changed: true,
                elevated: true,
                rebootRequired: true,
                network: setupNetwork,
            }),
            stderr: "",
        }));

        const result = setupHyperVHost(true, { platform: "win32", powershell: "powershell.exe", stateRoot: root, commandRunner: runner });

        expect(result.ok).toBe(true);
        expect(result.text).toContain("mode: confirmed");
        expect(result.text).toContain("rebootRequired: true");
        expect(result.text).toContain("hostRebooted: false");
        const encodedScript = runner.mock.calls[0][3]
            ? Buffer.from(runner.mock.calls[0][3], "base64").toString("utf8")
            : Buffer.from(runner.mock.calls[0][1].at(-1), "base64").toString("utf16le");
        expect(encodedScript).toContain("Start-Process -FilePath $Executable -Verb RunAs");
        expect(encodedScript).not.toContain("Restart-Computer");
    });

    it("reduces raw PowerShell setup failures to bounded categories", () => {
        const root = join(tmpdir(), `ccc-hyper-v-errors-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const rawFailure = setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: () => ({
                command: "powershell.exe",
                status: 1,
                stdout: "",
                stderr: "#< CLIXML C:\\Users\\private\\module.psd1 failed",
            }),
        });
        expect(rawFailure).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-host-operation-failed" });
        expect(rawFailure.text).not.toContain("C:\\Users\\private");

        const categorized = setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: () => ({
                command: "powershell.exe",
                status: 1,
                stdout: "",
                stderr: "wrapper: hyper-v-setup-pipe-client-mismatch",
            }),
        });
        expect(categorized).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-pipe-client-mismatch" });

        const wrapped = setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: () => ({
                command: "powershell.exe",
                status: 1,
                stdout: "",
                stderr: "hyper-v-setup-pipe-_x000D__x000A_ handshake-timeout",
            }),
        });
        expect(wrapped).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-pipe-handshake-timeout" });

        const partial = setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: () => ({ command: "powershell.exe", status: 1, stdout: "", stderr: "hyper-v-setup-pipe-handshake-" }),
        });
        expect(partial).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-host-operation-failed" });

        for (const stderr of ["hyper-v-setup-pipe-handshake-timeout-extra", "prefixhyper-v-setup-enable-failedsuffix"]) {
            const extended = setupHyperVHost(true, {
                platform: "win32",
                powershell: "powershell.exe",
                stateRoot: root,
                commandRunner: () => ({ command: "powershell.exe", status: 1, stdout: "", stderr }),
            });
            expect(extended).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-host-operation-failed" });
        }
    });

    it("pins elevated setup module resolution to the canonical Windows PowerShell modules", () => {
        const originalModulePath = process.env.PSModulePath;
        process.env.PSModulePath = "C:\\Users\\attacker\\Documents\\WindowsPowerShell\\Modules";
        try {
            const command = hyperVSetupCommand("\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
            const outerScript = command.input
                ? Buffer.from(command.input, "base64").toString("utf8")
                : Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
            const innerEncoded = /\$InnerEncoded = '([^']+)'/.exec(outerScript)?.[1];
            expect(innerEncoded).toBeTruthy();
            const innerScript = Buffer.from(innerEncoded!, "base64").toString("utf16le");

            expect(innerScript).toContain("$env:PSModulePath = $TrustedModuleRoot");
            expect(innerScript).toContain("Join-Path $PSHOME 'Modules'");
            expect(innerScript).toContain("Microsoft.PowerShell.Core\\Get-Module -ListAvailable -Name $Name");
            expect(innerScript).toContain("$_.Path.StartsWith($TrustedModulePrefix, [StringComparison]::OrdinalIgnoreCase)");
            expect(innerScript).toContain("Microsoft.PowerShell.Core\\Import-Module -Name $DismModule -Force -ErrorAction Stop");
            expect(innerScript).toContain("Microsoft.PowerShell.Core\\Import-Module -Name $LocalAccountsModule -Force -ErrorAction Stop");
            expect(innerScript).not.toContain("Microsoft.PowerShell.LocalAccounts\\Microsoft.PowerShell.LocalAccounts.psd1");
            expect(innerScript).not.toContain(process.env.PSModulePath);
            expect(innerScript).toContain("Dism\\Enable-WindowsOptionalFeature");
            expect(innerScript).toContain("Microsoft.PowerShell.LocalAccounts\\Add-LocalGroupMember");
            expect(innerScript).toContain("Get-CimInstance -ClassName Win32_OptionalFeature");
            expect(innerScript).not.toContain("Dism\\Get-WindowsOptionalFeature");
            expect(outerScript).not.toContain("Dism\\Get-WindowsOptionalFeature");
            expect(outerScript).not.toContain("Microsoft.PowerShell.LocalAccounts\\Get-LocalGroupMember");
            expect(outerScript).not.toContain("Hyper-V\\Get-VM");
            expect(outerScript).toContain("Start-Process -FilePath $Executable -Verb RunAs");
            expect(outerScript).toContain("[IO.Pipes.PipeSecurity]::new()");
            expect(outerScript).toContain("[IO.Pipes.PipeAccessRule]::new($ElevatedAdministratorsSid");
            expect(outerScript).toContain("CCC_HYPER_V_SETUP_PIPE_NAME");
            expect(outerScript).toContain("$InnerSource.Replace('__CCC_HYPER_V_SETUP_PIPE_NAME__', $PipeName)");
            expect(outerScript).not.toContain("$env:CCC_HYPER_V_SETUP_PIPE_NAME");
            expect(outerScript).not.toContain("$env:CCC_HYPER_V_SETUP_USER_SID");
            expect(outerScript).toContain("$Wait.AsyncWaitHandle.WaitOne(30000)");
            expect(outerScript).toContain("GetNamedPipeClientProcessId");
            expect(outerScript).toContain("$ClientProcessId -ne [uint32]$Child.Id");
            expect(outerScript).not.toContain("GetTempFileName");
            expect(innerScript).toContain("[IO.Pipes.NamedPipeClientStream]::new");
            expect(innerScript).toContain("$PipeName = '__CCC_HYPER_V_SETUP_PIPE_NAME__'");
            expect(innerScript).toContain("$SetupUserSid = '__CCC_HYPER_V_SETUP_USER_SID__'");
            expect(innerScript.indexOf("$Pipe.Connect(5000)")).toBeLessThan(innerScript.indexOf("Get-CimInstance -ClassName Win32_OptionalFeature"));
            expect(innerScript).toContain("$SelfStartTicks = (Get-Process -Id $PID");
            expect(innerScript).toContain("$ParentPid = [int]'__CCC_HYPER_V_SETUP_PARENT_PID__'");
            expect(innerScript).toContain("$Parent.StartTime.ToUniversalTime().Ticks -ne $ParentStartTicks");
            expect(innerScript).toContain("$Target.StartTime.ToUniversalTime().Ticks -eq $SelfStartTicks");
            expect(innerScript).toContain("$WatchdogStartTicks = $Watchdog.StartTime.ToUniversalTime().Ticks");
            expect(innerScript).toContain("$ObservedWatchdog.StartTime.ToUniversalTime().Ticks -eq $WatchdogStartTicks");
            expect(innerScript).not.toContain("Set-Content");
            expect(outerScript).toContain("$ChildStartTicks = $Child.StartTime.ToUniversalTime().Ticks");
            expect(outerScript).toContain("-not $OperationCompleted");
            expect(outerScript).toContain("$ObservedChild.StartTime.ToUniversalTime().Ticks -eq $ChildStartTicks");
            expect(outerScript).toContain("$Child.WaitForExit(5000)");
            expect(outerScript).toContain("hyper-v-setup-elevated-child-termination-unconfirmed");
        } finally {
            if (originalModulePath === undefined) delete process.env.PSModulePath;
            else process.env.PSModulePath = originalModulePath;
        }
    });

    it("uses only the canonical system PowerShell path at the UAC elevation boundary", () => {
        const root = join(tmpdir(), `ccc-hyper-v-system-powershell-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const powershell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        mkdirSync(join(root, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
        writeFileSync(powershell, "not executed by the injected runner");
        const runner = vi.fn(() => ({
            command: powershell,
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                featureName: "Microsoft-Hyper-V-All",
                beforeState: "Enabled",
                afterState: "Enabled",
                changed: false,
                elevated: false,
                rebootRequired: false,
                hyperVAdministratorsMember: true,
                membershipChanged: false,
                managementAccess: true,
                sessionRefreshRequired: false,
                network: setupNetwork,
            }),
            stderr: "",
        }));

        const result = setupHyperVHost(true, {
            platform: "win32",
            systemRoot: root,
            stateRoot: join(root, "state"),
            commandRunner: runner,
        });

        expect(result.ok).toBe(true);
        expect(runner).toHaveBeenCalledWith(powershell, expect.any(Array), 900_000, expect.any(String));
    });

    it("does not trust spoofed SystemRoot or WINDIR values at the UAC elevation boundary", () => {
        const root = join(tmpdir(), `ccc-hyper-v-spoofed-system-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const fakePowerShell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        mkdirSync(join(root, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
        writeFileSync(fakePowerShell, "repository-controlled fake");
        const originalSystemRoot = process.env.SystemRoot;
        const originalWindir = process.env.WINDIR;
        process.env.SystemRoot = root;
        process.env.WINDIR = root;
        const runner = vi.fn();
        try {
            const result = setupHyperVHost(true, {
                platform: "win32",
                stateRoot: join(root, "state"),
                commandRunner: runner,
            });
            expect(result).toEqual({ ok: false, text: "CCC Hyper-V setup failed: PowerShell was not found." });
            expect(runner).not.toHaveBeenCalled();
        } finally {
            if (originalSystemRoot === undefined) delete process.env.SystemRoot;
            else process.env.SystemRoot = originalSystemRoot;
            if (originalWindir === undefined) delete process.env.WINDIR;
            else process.env.WINDIR = originalWindir;
        }
    });

    it("rejects a reparse-like setup root before elevated execution", () => {
        const parent = join(tmpdir(), `ccc-hyper-v-reparse-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const target = join(parent, "target");
        const linked = join(parent, "linked");
        roots.push(parent);
        mkdirSync(target, { recursive: true });
        symlinkSync(target, linked, "dir");
        const runner = vi.fn();

        const result = setupHyperVHost(true, { platform: "win32", powershell: "powershell.exe", stateRoot: linked, commandRunner: runner });

        expect(result).toEqual(expect.objectContaining({ ok: false }));
        expect(result.text).toContain("hyper-v-setup-root-path-invalid");
        expect(runner).not.toHaveBeenCalled();
    });

    it("routes the public CLI confirmation and rejects malformed setup commands", async () => {
        const setupHyperV = vi.fn(() => ({ ok: true, text: "setup-ok" }));
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(await devicesCliAsync(["setup", "hyper-v", "--confirm"], "/project/setup-test", undefined, { setupHyperV })).toBe(0);
        expect(setupHyperV).toHaveBeenCalledWith(true, { acceptWindowsEvaluationLicense: false });
        expect(log).toHaveBeenCalledWith("setup-ok");

        expect(await devicesCliAsync(["setup", "hyper-v", "--confirm", "--accept-windows-evaluation-license"], "/project/setup-test", undefined, { setupHyperV })).toBe(0);
        expect(setupHyperV).toHaveBeenLastCalledWith(true, { acceptWindowsEvaluationLicense: true });

        expect(await devicesCliAsync(["setup", "hyper-v", "--force"], "/project/setup-test", undefined, { setupHyperV })).toBe(1);
        expect(await devicesCliAsync(["setup", "hyper-v", "--accept-windows-evaluation-license"], "/project/setup-test", undefined, { setupHyperV })).toBe(1);
        expect(error).toHaveBeenCalledWith("Usage: ccc devices setup hyper-v [--confirm [--accept-windows-evaluation-license]]");
    });
});
