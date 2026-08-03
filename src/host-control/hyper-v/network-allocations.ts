import {
    type HyperVNetworkAllocationsOptions,
    type HyperVProviderCommand,
} from "./contracts.js";
import {
    assertIdentity,
    command,
    hyperVVmName,
    jsonScript,
    ownershipMarker,
} from "./core.js";

export function hyperVInspectNetworkAllocationsCommand(
    options: HyperVNetworkAllocationsOptions,
): HyperVProviderCommand {
    if (!Array.isArray(options.allocations) || options.allocations.length > 1024) {
        throw new Error("hyper-v-network-allocation-inspection-input-invalid");
    }
    const input = options.allocations.map((allocation) => {
        const vmName = hyperVVmName(allocation.ownerId, allocation.deviceId, allocation.incarnationId);
        assertIdentity({ ...allocation, executable: options.executable, vmName });
        return {
            ...allocation,
            vmName,
            marker: ownershipMarker(allocation.ownerId, allocation.deviceId, allocation.incarnationId),
        };
    });
    return command(options.executable, jsonScript([
        "$Items = @($CccCommandInput | ConvertFrom-Json)",
        "$Observations = @()",
        "$AllVms = @(Get-VM -ErrorAction Stop)",
        "foreach ($Item in $Items) {",
        "  $ExpectedVmName = [string]$Item.vmName",
        "  $Vms = @($AllVms | Where-Object { [string]$_.Name -ceq $ExpectedVmName })",
        "  if ($Vms.Count -gt 1) { throw 'hyper-v-network-allocation-vm-ambiguous' }",
        "  if ($Vms.Count -eq 1 -and [string]$Vms[0].Notes -cne [string]$Item.marker) { throw 'hyper-v-network-allocation-vm-ownership-conflict' }",
        "  $Observations += [ordered]@{ ownerId = [string]$Item.ownerId; deviceId = [string]$Item.deviceId; incarnationId = [string]$Item.incarnationId; vmName = [string]$Item.vmName; present = ($Vms.Count -eq 1); vmId = if ($Vms.Count -eq 1) { [string]$Vms[0].Id } else { $null } }",
        "}",
        "$Result = [ordered]@{ ok = $true; allocations = @($Observations) }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]), JSON.stringify(input));
}
