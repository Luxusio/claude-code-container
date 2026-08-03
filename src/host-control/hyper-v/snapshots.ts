import {
    type HyperVProviderCommand,
    type HyperVSnapshotOptions,
} from "./contracts.js";
import {
    psQuote,
    jsonScript,
    command,
    ownedVmPrelude,
    ownedSnapshotPrelude,
    hyperVSnapshotName,
} from "./core.js";

export function hyperVSnapshotCreateCommand(options: HyperVSnapshotOptions): HyperVProviderCommand {
    const lines = ownedVmPrelude(options);
    const providerName = hyperVSnapshotName(options.ownerId, options.snapshotName);
    return command(options.executable, jsonScript([
        ...lines,
        `$SnapshotName = ${psQuote(providerName)}`,
        "if (@(Get-VMSnapshot -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $SnapshotName }).Count -ne 0) { throw 'hyper-v-snapshot-already-exists' }",
        "Checkpoint-VM -VM $Vm -SnapshotName $SnapshotName -ErrorAction Stop",
        "$Snapshot = @(Get-VMSnapshot -VM $Vm -ErrorAction Stop | Where-Object { $_.Name -eq $SnapshotName })",
        "if ($Snapshot.Count -ne 1) { throw 'hyper-v-snapshot-create-invalid-result' }",
        "$Snapshot = $Snapshot[0]",
        "$Result = [ordered]@{ ok = $true; snapshotId = [string]$Snapshot.Id; snapshotName = [string]$Snapshot.Name; snapshotType = [string]$Snapshot.SnapshotType }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVSnapshotRestoreCommand(options: HyperVSnapshotOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedSnapshotPrelude(options),
        ...(!options.force ? ["if ($Vm.State -ne 'Off') { throw 'hyper-v-snapshot-restore-requires-stopped-vm' }"] : ["if ($Vm.State -ne 'Off') { Stop-VM -VM $Vm -TurnOff -Force -ErrorAction Stop | Out-Null }"]),
        "Restore-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop",
        "$Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
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
