import { basename, join } from "path";
import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";

import {
    createHyperVWindowsClient,
    createHyperVWindowsPowerShellExecutor,
    HYPER_V_WINDOWS_POWERSHELL_ASSET,
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_INPUT_LIMIT_BYTES,
    hyperVWindowsPowerShellMemoryInput,
    HyperVWindowsError,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsExecutionContext,
    type HyperVWindowsExecutionResult,
    type HyperVWindowsExecutor,
    type HyperVWindowsOperation,
} from "../hyper-v-windows/low-level/index.js";
import { HYPER_V_POWERSHELL_MANIFEST } from "../host-control/hyper-v/powershell-manifest.js";

const vmId = "12345678-1234-1234-1234-123456789ABC";
const canonicalVmId = vmId.toLowerCase();
const selector = { kind: "id", id: vmId } as const;

const virtualMachine = {
    id: vmId,
    name: "library-test",
    state: "FutureState",
    status: "FutureStatus",
    notes: "opaque-notes",
    uptimeMilliseconds: 42,
    generation: 2,
    checkpointType: "FutureCheckpoint",
};

function response(
    operation: HyperVWindowsOperation,
    items: readonly unknown[] = [],
): HyperVWindowsExecutionResult {
    return {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }),
    };
}

function executorUsing(
    execute: (request: HyperVWindowsExecutionRequest) => HyperVWindowsExecutionResult | Promise<HyperVWindowsExecutionResult>,
): HyperVWindowsExecutor {
    return { execute };
}

describe("Hyper-V Windows low-level client", () => {
    it("maps each method to one exact native operation and normalized parameters", async () => {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const contexts: HyperVWindowsExecutionContext[] = [];
        const executor: HyperVWindowsExecutor = {
            execute(request, context) {
                requests.push(request);
                contexts.push(context);
                return response(request.operation, request.operation === "Get-VM" ? [virtualMachine] : []);
            },
        };
        const client = createHyperVWindowsClient(executor);

        await client.getVM(selector);
        await client.getVMHardDiskDrives(selector);
        await client.getVMDvdDrives(selector);
        await client.startVM({ selector });
        await client.stopVM({ selector, mode: "shutdown" });
        await client.removeVM({ selector, force: true });

        expect(requests).toEqual([
            { schemaVersion: 1, operation: "Get-VM", selector: { kind: "id", id: canonicalVmId } },
            { schemaVersion: 1, operation: "Get-VMHardDiskDrive", selector: { kind: "id", id: canonicalVmId } },
            { schemaVersion: 1, operation: "Get-VMDvdDrive", selector: { kind: "id", id: canonicalVmId } },
            { schemaVersion: 1, operation: "Start-VM", selector: { kind: "id", id: canonicalVmId } },
            { schemaVersion: 1, operation: "Stop-VM", selector: { kind: "id", id: canonicalVmId }, mode: "shutdown", force: false },
            { schemaVersion: 1, operation: "Remove-VM", selector: { kind: "id", id: canonicalVmId }, force: true },
        ]);
        expect(contexts).toEqual(Array.from({ length: 6 }, () => ({
            timeoutMilliseconds: 120_000,
            maximumOutputBytes: 65_536,
        })));
    });

    it("preserves zero, one, and many attachment records in native order", async () => {
        const outputs = new Map<HyperVWindowsOperation, readonly unknown[]>([
            ["Get-VM", []],
            ["Get-VMHardDiskDrive", [
                {
                    vmId,
                    vmName: "library-test",
                    path: "C:\\VMs\\one.vhdx",
                    controllerType: "SCSI",
                    controllerNumber: 0,
                    controllerLocation: 0,
                    diskNumber: null,
                },
                {
                    vmId,
                    vmName: "library-test",
                    path: null,
                    controllerType: "FutureController",
                    controllerNumber: 0,
                    controllerLocation: 1,
                    diskNumber: 7,
                },
            ]],
            ["Get-VMDvdDrive", [
                {
                    vmId,
                    vmName: "library-test",
                    path: null,
                    controllerType: "SCSI",
                    controllerNumber: 0,
                    controllerLocation: 2,
                },
            ]],
        ]);
        const client = createHyperVWindowsClient(executorUsing((request) => response(
            request.operation,
            outputs.get(request.operation) ?? [],
        )));

        await expect(client.getVM(selector)).resolves.toEqual([]);
        await expect(client.getVMHardDiskDrives(selector)).resolves.toEqual([
            expect.objectContaining({ path: "C:\\VMs\\one.vhdx", controllerLocation: 0 }),
            expect.objectContaining({ path: null, controllerType: "FutureController", diskNumber: 7 }),
        ]);
        await expect(client.getVMDvdDrives(selector)).resolves.toEqual([
            expect.objectContaining({ path: null, controllerLocation: 2 }),
        ]);
    });

    it("preserves unknown native VM strings and canonicalizes GUIDs", async () => {
        const client = createHyperVWindowsClient(executorUsing((request) => response(request.operation, [virtualMachine])));

        await expect(client.getVM(selector)).resolves.toEqual([{
            ...virtualMachine,
            id: canonicalVmId,
        }]);
    });

    it("rejects invalid requests before invoking the executor", async () => {
        const execute = vi.fn(() => response("Get-VM"));
        const client = createHyperVWindowsClient(executorUsing(execute));

        await expect(client.getVM({ kind: "id", id: "not-a-guid" })).rejects.toMatchObject({
            category: "validation",
            operation: "Get-VM",
            code: "selector-id-invalid",
        });
        await expect(client.startVM({ selector: { kind: "name", name: "unsafe*" } })).rejects.toMatchObject({
            category: "validation",
            operation: "Start-VM",
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([
        ["malformed", { status: 0, stdout: "not-json" }, "protocol", "response-malformed"],
        ["oversized", { status: null, stdout: "x".repeat(65 * 1024), error: "spawn ENOBUFS", outputLimitExceeded: true }, "protocol", "response-too-large"],
        ["ambiguous", response("Start-VM", [virtualMachine]), "protocol", "result-ambiguous"],
        ["timeout", { status: null, stdout: "", timedOut: true }, "transport", "timeout"],
        ["cancellation", { status: null, stdout: "", cancelled: true }, "transport", "cancelled"],
        ["executor error", { status: null, stdout: "", error: "private process detail" }, "transport", "executor-failed"],
    ] as const)("normalizes %s without leaking executor details", async (_label, execution, category, code) => {
        const client = createHyperVWindowsClient(executorUsing(() => execution));
        const caught = await client.startVM({ selector }).catch((failure: unknown) => failure);

        expect(caught).toBeInstanceOf(HyperVWindowsError);
        expect(caught).toMatchObject({ category, operation: "Start-VM", code });
        expect(String(caught)).not.toContain("private process detail");
    });

    it("normalizes a bounded native failure envelope", async () => {
        const client = createHyperVWindowsClient(executorUsing(() => ({
            status: 1,
            stdout: JSON.stringify({
                schemaVersion: 1,
                operation: "Remove-VM",
                ok: false,
                errorCode: "virtual-machine-not-found",
            }),
            stderr: "unbounded native detail",
        })));

        const caught = await client.removeVM({ selector }).catch((failure: unknown) => failure);
        expect(caught).toMatchObject({
            category: "native",
            operation: "Remove-VM",
            code: "virtual-machine-not-found",
            nativeStatus: 1,
        });
        expect(String(caught)).not.toContain("unbounded native detail");
    });

    it("normalizes rejected executors and already-aborted calls as transport failures", async () => {
        const rejected = createHyperVWindowsClient(executorUsing(() => Promise.reject(new Error("secret"))));
        await expect(rejected.getVM(selector)).rejects.toMatchObject({
            category: "transport",
            operation: "Get-VM",
            code: "executor-failed",
        });

        const execute = vi.fn(() => response("Get-VM"));
        const aborted = createHyperVWindowsClient(executorUsing(execute));
        const controller = new AbortController();
        controller.abort();
        await expect(aborted.getVM(selector, { signal: controller.signal })).rejects.toMatchObject({
            category: "transport",
            code: "cancelled",
        });
        expect(execute).not.toHaveBeenCalled();
    });
});

describe("Hyper-V Windows PowerShell transport", () => {
    it("defines one bounded in-memory execution envelope for transport consumers", () => {
        const processInput = hyperVWindowsPowerShellMemoryInput({
            scriptSource: "$global:CccHyperVJsonInput | Out-Null",
            input: "{\"ok\":true}\n",
        });

        expect(JSON.parse(Buffer.from(processInput, "base64").toString("utf8"))).toEqual({
            script: "$global:CccHyperVJsonInput | Out-Null",
            input: "{\"ok\":true}\n",
        });
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).toContain("ScriptBlock");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).toContain("[Convert]::FromBase64String([Console]::In.ReadToEnd())");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).not.toContain("[Console]::InputEncoding =");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).not.toContain("[Console]::OutputEncoding =");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).not.toContain("StreamReader");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).not.toContain("StreamWriter");
        expect(() => hyperVWindowsPowerShellMemoryInput({
            scriptSource: "x".repeat(HYPER_V_WINDOWS_POWERSHELL_MEMORY_INPUT_LIMIT_BYTES),
            input: "{}\n",
        })).toThrow("hyper-v-windows-powershell-memory-input-too-large");
    });

    it("uses the integrity-pinned generic asset and a bounded JSON request", async () => {
        const run = vi.fn((request: { scriptPath: string; scriptSource: string; input: string }) => response("Get-VM"));
        const executor = createHyperVWindowsPowerShellExecutor({ executable: "powershell.exe", run });
        const request: HyperVWindowsExecutionRequest = {
            schemaVersion: 1,
            operation: "Get-VM",
            selector: { kind: "id", id: canonicalVmId },
        };

        await executor.execute(request, { timeoutMilliseconds: 120_000, maximumOutputBytes: 65_536 });

        expect(run).toHaveBeenCalledOnce();
        const fileRequest = run.mock.calls[0][0];
        expect(basename(fileRequest.scriptPath)).toBe("Invoke-HyperVWindowsOperation.ps1");
        expect(JSON.parse(fileRequest.input)).toEqual(request);
        expect(fileRequest.input.endsWith("\n")).toBe(true);
        const source = fileRequest.scriptSource;
        expect(source).toBe(readFileSync(fileRequest.scriptPath, "utf8"));
        expect(source).toContain('[Environment]::SystemDirectory');
        expect(source).toContain('Import-Module -Name $ModulePath -Force -PassThru');
        expect(source).toContain("Resolve-HyperVWindowsTrustedModulePath");
        expect(source).toContain("$ModulePath = Resolve-HyperVWindowsTrustedModulePath");
        expect(source).toContain("Get-ChildItem -LiteralPath $ModuleRoot -Directory");
        expect(source).toContain("[Version]$VersionDirectory.Name");
        expect(source).toContain("[string]$_.ModuleBase");
        expect(source).toContain("[IO.FileAttributes]::ReparsePoint");
        expect(source).toContain('Hyper-V\\Get-VM -ErrorAction Stop');
        expect(source).toContain('Hyper-V\\Remove-VM -VM $VirtualMachine');
        expect(source).toContain('$RawRequest = [string]$global:CccHyperVJsonInput');
        expect(source).not.toContain('[Console]::In.ReadToEnd()');
        expect(source).toContain("Get-VMHardDiskDrive");
        expect(source).toContain("Get-VMDvdDrive");
        expect(source).toContain("Start-VM");
        expect(source).toContain("Stop-VM");
        expect(source).not.toMatch(/Stop-VM[^\r\n]*-Shutdown/);
        expect(source).toContain("Remove-VM -VM $VirtualMachine");
        expect(source).not.toContain("Remove-Item");
        expect(source).not.toContain("Get-VM -Id ([Guid][string]$Selector.id) -ErrorAction SilentlyContinue");
        expect(source).toContain("Get-VM -ErrorAction Stop | Where-Object");
        expect(source).not.toContain('CategoryInfo.Category -eq "ObjectNotFound"');
        expect(source).not.toContain("CommandNotFoundException");
        expect(source).toContain("Get-VMHardDiskDrive -VM $VirtualMachine -ErrorAction Stop");
        expect(source).toContain("Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop");
        // Every operation except Get-VM itself resolves exactly one virtual machine first.
        expect(source.match(/\$VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine \$VirtualMachines/g))
            .toHaveLength(9);
        expect(source).toContain("Get-VMSnapshot -VM $VirtualMachine -ErrorAction Stop");
        expect(source).toContain("Checkpoint-VM -VM $VirtualMachine -SnapshotName $SnapshotName -Passthru -ErrorAction Stop");
        expect(source).toContain("Remove-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop");
        expect(source).toContain("Remove-VMSnapshot -VMSnapshot $Snapshot -IncludeAllChildSnapshots -Confirm:$false -ErrorAction Stop");
        expect(source).toContain("Restore-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop");
        // Snapshot resolution is exact-match only, with no consumer naming convention baked in.
        expect(source).toContain('if ($Matched.Count -eq 0) { throw "snapshot-not-found" }');
        expect(source).toContain('if ($Matched.Count -ne 1) { throw "snapshot-selector-ambiguous" }');
        expect(source).not.toContain("ccc-");
        expect(HYPER_V_POWERSHELL_MANIFEST.operations["windows-operation"].script).toBe(basename(fileRequest.scriptPath));
        expect(HYPER_V_POWERSHELL_MANIFEST.assets[HYPER_V_WINDOWS_POWERSHELL_ASSET.name].sha256)
            .toBe(HYPER_V_WINDOWS_POWERSHELL_ASSET.sha256);
    });

    it("accepts only an integrity-pinned embedded operation asset", async () => {
        const assetPath = join(process.cwd(), "scripts", "host-control", "hyper-v", HYPER_V_WINDOWS_POWERSHELL_ASSET.name);
        const scriptSource = readFileSync(assetPath, "utf8");
        const run = vi.fn(() => response("Get-VM"));
        const request: HyperVWindowsExecutionRequest = {
            schemaVersion: 1,
            operation: "Get-VM",
            selector: { kind: "id", id: canonicalVmId },
        };
        const embedded = createHyperVWindowsPowerShellExecutor({
            executable: "powershell.exe",
            run,
            operationAsset: { scriptPath: "embedded:Invoke-HyperVWindowsOperation.ps1", scriptSource },
        });
        await embedded.execute(request, { timeoutMilliseconds: 1, maximumOutputBytes: 1 });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            scriptPath: "embedded:Invoke-HyperVWindowsOperation.ps1",
            scriptSource,
        }), expect.any(Object));

        const tampered = createHyperVWindowsPowerShellExecutor({
            executable: "powershell.exe",
            run,
            operationAsset: { scriptPath: "embedded:Invoke-HyperVWindowsOperation.ps1", scriptSource: `${scriptSource}\n# tampered` },
        });
        expect(() => tampered.execute(request, { timeoutMilliseconds: 1, maximumOutputBytes: 1 }))
            .toThrow("hyper-v-windows-powershell-asset-integrity-failed");
    });
});
