import { lstatSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { describe, expect, it } from "vitest";

import { hyperVPowerShellAssetPath, hyperVPowerShellFileCommand } from "../host-control/hyper-v/powershell-assets.js";
import { hyperVOwnedVmContractV1 } from "../host-control/hyper-v/powershell-contracts.js";
import { hyperVVmName } from "../host-control/hyper-v/core.js";

const identityBase = {
    executable: "powershell.exe",
    ownerId: "0123456789abcdef",
    deviceId: "linux-ci-01",
    incarnationId: "11111111111111111111111111111111",
    vmId: "12345678-1234-1234-1234-123456789abc",
};
const identity = {
    ...identityBase,
    vmName: hyperVVmName(identityBase.ownerId, identityBase.deviceId, identityBase.incarnationId),
};

describe("Hyper-V PowerShell assets", () => {
    it("builds a file command with a typed bounded JSON contract", () => {
        const request = hyperVOwnedVmContractV1(identity);
        const command = hyperVPowerShellFileCommand("powershell.exe", "linux-bootstrap-network", request);

        expect(command.provider).toBe("hyper-v");
        expect(command.args.slice(0, -1)).toEqual([
            "-WindowStyle",
            "Hidden",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        expect(basename(command.args.at(-1)!)).toBe("Get-LinuxBootstrapNetwork.ps1");
        expect(JSON.parse(command.input!)).toEqual(request);
        expect(command.input!.endsWith("\n")).toBe(true);
    });

    it("resolves only regular package-owned scripts", () => {
        const bootstrap = hyperVPowerShellAssetPath("linux-bootstrap-network");
        const diagnostic = hyperVPowerShellAssetPath("guest-boot-diagnostic");
        const root = realpathSync(dirname(bootstrap));

        for (const asset of [bootstrap, diagnostic]) {
            expect(lstatSync(asset).isFile()).toBe(true);
            expect(relative(root, realpathSync(asset)).startsWith("..")).toBe(false);
            expect(readFileSync(asset, "utf8")).toContain("Read-CccJsonContract");
        }
        expect(readFileSync(join(root, "Ccc.HyperV.Core.psm1"), "utf8")).toContain("Assert-CccOwnedVmContract");
    });

    it("rejects missing VM identity before spawning PowerShell", () => {
        expect(() => hyperVOwnedVmContractV1({ ...identity, vmId: null })).toThrow("hyper-v-vm-id-missing");
        expect(() => hyperVOwnedVmContractV1({ ...identity, ownerId: "wrong" })).toThrow("hyper-v-owner-id-invalid");
    });
});
