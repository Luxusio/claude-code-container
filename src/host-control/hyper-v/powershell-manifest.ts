import type { HyperVOwnedVmContractV1, HyperVSnapshotCreateContractV1, HyperVSnapshotRepairContractV1 } from "./powershell-contracts.js";

export type HyperVPowerShellRequestMap = {
    "guest-boot-diagnostic": HyperVOwnedVmContractV1;
    "linux-bootstrap-network": HyperVOwnedVmContractV1;
    "snapshot-create": HyperVSnapshotCreateContractV1;
    "snapshot-repair": HyperVSnapshotRepairContractV1;
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
        "Ccc.HyperV.Snapshots.psm1": { sha256: "d43dc6acf96378dbb9c0bb4de22e4c065e2f1833b04ef72606383e1474a449db" },
        "New-Snapshot.ps1": { sha256: "85e2e19f79bfe7f83b068b8e668b0f270358738759e436b101ccd9ff73d76c69" },
        "Repair-SnapshotState.ps1": { sha256: "0300e2e6c6fa1dd4ab5ddfd5de6dbdada366249856c36dd0f403fbfe7d757257" },
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
        "snapshot-create": {
            requestVersion: 1,
            script: "New-Snapshot.ps1",
        },
        "snapshot-repair": {
            requestVersion: 1,
            script: "Repair-SnapshotState.ps1",
        },
    },
} as const satisfies {
    schemaVersion: 1;
    assets: Record<string, { sha256: string }>;
    operations: Record<HyperVPowerShellOperation, { requestVersion: 1; script: string }>;
};
