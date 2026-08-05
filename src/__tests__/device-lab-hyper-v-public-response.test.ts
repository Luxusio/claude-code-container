import { describe, expect, it } from "vitest";
import {
    hyperVProviderDiagnosticCode,
    publicHyperVCreateConfiguration,
    redactHyperVDeviceSecrets,
    redactHyperVResultSecrets,
} from "../device-lab/broker/hyper-v/public-response.js";

describe("Hyper-V public response projection", () => {
    it.each([
        "hyper-v-base-image-acl-failed",
        "hyper-v-base-image-final-hash-mismatch",
        "hyper-v-base-image-source-mutated",
        "hyper-v-base-image-partial-mutated",
    ])("preserves the bounded image mutation diagnostic %s", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr: diagnosticCode,
        })).toBe(diagnosticCode);
    });

    it.each([
        "hyper-v-network-marker-inspection-failed",
        "hyper-v-network-marker-classification-failed",
        "hyper-v-network-identity-evidence-inspection-failed",
        "hyper-v-network-identity-adoption-failed",
        "hyper-v-network-persisted-marker-repair-failed",
        "hyper-v-network-persisted-marker-rollback-conflict",
        "hyper-v-network-persisted-marker-rollback-failed",
    ])("preserves the bounded network migration diagnostic %s", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: `CCC_HYPER_V_STAGE:${diagnosticCode}`,
            stderr: "",
        })).toBe(diagnosticCode);
    });

    it("uses an allowlist for persisted device records", () => {
        const result = redactHyperVDeviceSecrets({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            vmName: "ccc-owner-windows-vm-1",
            status: "running",
            deviceRoot: "C:\\private\\device",
            diskPath: "C:\\private\\root.vhdx",
            sourceImage: "C:\\images\\base.vhdx",
            futureSecretPath: "C:\\private\\future.secret",
            snapshots: [{
                id: "snapshot-1",
                name: "baseline",
                providerName: "ccc-owner-baseline",
                createdAt: "2026-07-27T00:00:00.000Z",
                diskPath: "C:\\private\\snapshot.vhdx",
            }],
        });

        expect(result).toEqual({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            vmName: "ccc-owner-windows-vm-1",
            status: "running",
            snapshots: [{
                id: "snapshot-1",
                name: "baseline",
                providerName: "ccc-owner-baseline",
                createdAt: "2026-07-27T00:00:00.000Z",
            }],
        });
    });

    it("reports configured create inputs without exposing source paths or passwords", () => {
        expect(publicHyperVCreateConfiguration({
            name: "Windows VM",
            profile: "windows-11",
            memoryMb: 4096,
            cpus: 2,
            sourceImage: "C:\\images\\windows.vhdx",
            sshPassword: "secret",
            privateRoot: "C:\\private",
        })).toEqual({
            name: "Windows VM",
            profile: "windows-11",
            memoryMb: 4096,
            cpus: 2,
            sourceImageConfigured: true,
            sshPasswordConfigured: true,
        });
    });

    it("drops provider commands and unknown result fields", () => {
        expect(redactHyperVResultSecrets({
            ownerId: "owner",
            backend: "linux-vm",
            command: "device_create",
            create: {
                profile: "ubuntu-lts",
                sourceImage: "C:\\images\\ubuntu.vhdx",
            },
            providerCommand: {
                executable: "powershell.exe",
                args: ["-Command", "secret"],
            },
            device: {
                id: "linux-vm-1",
                backend: "linux-vm",
                provider: "hyper-v",
                seedDiskPath: "C:\\private\\cidata.iso",
            },
            futureInternalPayload: "secret",
        })).toEqual({
            ownerId: "owner",
            backend: "linux-vm",
            command: "device_create",
            create: {
                profile: "ubuntu-lts",
                sourceImageConfigured: true,
            },
            device: {
                id: "linux-vm-1",
                backend: "linux-vm",
                provider: "hyper-v",
                snapshots: [],
            },
        });
    });

    it("bounds rollback errors instead of forwarding provider details", () => {
        expect(redactHyperVResultSecrets({
            rollback: {
                ok: false,
                preserved: true,
                error: "C:\\private\\secret.txt",
            },
        })).toEqual({
            rollback: {
                ok: false,
                preserved: true,
                error: "hyper-v-rollback-failed",
            },
        });
    });

    it("bounds persisted boot-check errors instead of forwarding host details", () => {
        expect(redactHyperVDeviceSecrets({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            lastBootCheck: {
                ready: false,
                provider: "hyper-v-powershell-direct",
                error: "C:\\Users\\Luxus\\secret.txt",
            },
        })).toEqual({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            snapshots: [],
            lastBootCheck: {
                ready: false,
                provider: "hyper-v-powershell-direct",
                error: "hyper-v-guest-not-ready",
            },
        });
    });
});
