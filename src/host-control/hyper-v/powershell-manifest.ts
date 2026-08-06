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
        "Ccc.HyperV.Diagnostics.psm1": { sha256: "669e1edf3f671eb2d21eee8798cd72c211f8c723c38bc3b86c131d995244eb94" },
        "Ccc.HyperV.Linux.psm1": { sha256: "b1091bb59a3e64250d7e664834c51c8ce2789db2d05a73f2e699b8ea8cbce0c2" },
        "Get-GuestBootDiagnostic.ps1": { sha256: "f17b2ff0e84c52fd6cb4552bd6f63eb3aad89c37a6f50d52a55d07893b44f943" },
        "Get-LinuxBootstrapNetwork.ps1": { sha256: "1ca8dd8fd55bc75feaa5fa88cad92cb80d12fe9fd1b59f9dcc345a399d3dce60" },
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
