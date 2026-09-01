import {
    type HyperVProviderCommand,
    type HyperVSnapshotOptions,
} from "./contracts.js";
import {
    jsonScript,
    command,
    ownedSnapshotPrelude,
    hyperVSnapshotName,
} from "./core.js";
import { hyperVPowerShellFileCommand } from "./powershell-assets.js";
import { hyperVSnapshotCreateContractV1, hyperVSnapshotRepairContractV1 } from "./powershell-contracts.js";

export function hyperVSnapshotCreateCommand(
    options: HyperVSnapshotOptions,
    expectedCheckpointPolicy: "Production" | "ProductionOnly",
): HyperVProviderCommand {
    const providerName = hyperVSnapshotName(options.ownerId, options.snapshotName);
    return hyperVPowerShellFileCommand(
        options.executable,
        "snapshot-create",
        hyperVSnapshotCreateContractV1(options, providerName, expectedCheckpointPolicy),
    );
}

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

export function hyperVSnapshotRestoreCommand(options: HyperVSnapshotOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedSnapshotPrelude(options),
        ...(!options.force ? ["if ($Vm.State -ne 'Off') { throw 'hyper-v-snapshot-restore-requires-stopped-vm' }"] : ["if ($Vm.State -ne 'Off') { Stop-VM -VM $Vm -TurnOff -Force -ErrorAction Stop | Out-Null }"]),
        "Restore-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop",
        "$Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        ...(options.startAfterRestore ? ["if ($Vm.State -ne 'Running') { Start-VM -VM $Vm -ErrorAction Stop | Out-Null; $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop }"] : []),
        "$Result = [ordered]@{ ok = $true; snapshotId = [string]$Snapshot.Id; snapshotName = [string]$Snapshot.Name; snapshotType = [string]$Snapshot.SnapshotType; state = [string]$Vm.State }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVSnapshotDeleteCommand(options: HyperVSnapshotOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedSnapshotPrelude(options),
        "Remove-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop",
        "$Result = [ordered]@{ ok = $true; snapshotId = [string]$Snapshot.Id; snapshotName = [string]$Snapshot.Name; deleted = $true }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}
