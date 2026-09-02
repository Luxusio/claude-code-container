import {
    type HyperVProviderCommand,
    type HyperVSnapshotOptions,
} from "./contracts.js";
import { hyperVSnapshotName } from "./core.js";
import { hyperVPowerShellFileCommand } from "./powershell-assets.js";
import { hyperVSnapshotRepairContractV1 } from "./powershell-contracts.js";

// Snapshot create, delete, and restore moved to the typed Hyper-V Windows library; Device Lab drives
// them through src/device-lab/broker/hyper-v/snapshots.ts. Repair still runs as its own PowerShell
// asset because it reconciles checkpoint state rather than issuing a single native primitive.
export function hyperVSnapshotRepairCommand(
    options: HyperVSnapshotOptions,
    expectedCheckpointPolicy: "Production" | "ProductionOnly",
): HyperVProviderCommand {
    return hyperVPowerShellFileCommand(
        options.executable,
        "snapshot-repair",
        hyperVSnapshotRepairContractV1(
            options,
            hyperVSnapshotName(options.ownerId, options.snapshotName),
            expectedCheckpointPolicy,
        ),
    );
}
