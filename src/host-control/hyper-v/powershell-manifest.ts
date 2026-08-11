import type { HyperVOwnedVmContractV1 } from "./powershell-contracts.js";

export type HyperVPowerShellRequestMap = {
    "guest-boot-diagnostic": HyperVOwnedVmContractV1;
    "linux-bootstrap-network": HyperVOwnedVmContractV1;
};

export type HyperVPowerShellOperation = keyof HyperVPowerShellRequestMap;

export const HYPER_V_POWERSHELL_MANIFEST = {
    schemaVersion: 1,
    assets: {
        "Ccc.HyperV.Core.psm1": { sha256: "1583f389ed07673280edec7dabf149b695eb2cbeb9044c03ca1b6b4cef37db32" },
        "Ccc.HyperV.Diagnostics.psm1": { sha256: "0d7d4cd26eeb1d3af49dd26e97e0380290ce1815be01ada5f3174c1b60581428" },
        "Ccc.HyperV.Linux.psm1": { sha256: "d75836414802f3b9bfec7e4969b594055f6265e76df0a3f8a7b22b5746932a63" },
        "Get-GuestBootDiagnostic.ps1": { sha256: "f17b2ff0e84c52fd6cb4552bd6f63eb3aad89c37a6f50d52a55d07893b44f943" },
        "Get-LinuxBootstrapNetwork.ps1": { sha256: "3639a76b707216ad75645ac4753d2ad4ab5839bd3a6cfb816c49f489e772e8f3" },
    },
    operations: {
        "guest-boot-diagnostic": {
            requestVersion: 1,
            script: "Get-GuestBootDiagnostic.ps1",
        },
        "linux-bootstrap-network": {
            requestVersion: 1,
            script: "Get-LinuxBootstrapNetwork.ps1",
        },
    },
} as const satisfies {
    schemaVersion: 1;
    assets: Record<string, { sha256: string }>;
    operations: Record<HyperVPowerShellOperation, { requestVersion: 1; script: string }>;
};
