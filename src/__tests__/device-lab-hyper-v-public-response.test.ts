import { describe, expect, it } from "vitest";
import {
    publicHyperVCreateConfiguration,
    redactHyperVDeviceSecrets,
    redactHyperVResultSecrets,
} from "../device-lab/broker/hyper-v/public-response.js";

describe("Hyper-V public response projection", () => {
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
