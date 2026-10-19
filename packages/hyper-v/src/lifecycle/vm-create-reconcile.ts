import type {
    HyperVCreateCompensation,
    HyperVCreateEffect,
    HyperVCreateStep,
    HyperVCreateVirtualMachineRequest,
} from "./vm-create-contracts.js";
import { parseHyperVMacAddress } from "../low-level/network-contracts.js";

/**
 * Orders the steps that bring one VM into existence.
 *
 * The order is the behaviour, not an implementation detail, and three parts of it are load
 * bearing:
 *
 * - the disk is copied before `New-VM`, because `New-VM` attaches it and cannot attach a file
 *   that is not there yet;
 * - for a bootstrap guest, `New-VM` is given the *bootstrap* switch, because the adapter it
 *   creates for free is the one that must carry DHCP; the device adapter is added after, so
 *   that the two always land in the same relative order and their names are predictable;
 * - firmware is configured last, because the first boot device it names is the disk, and the
 *   disk is only attached to a VM once that VM exists.
 *
 * Pure: the same request always produces the same steps, and nothing here touches a host.
 */
export function planHyperVVirtualMachineCreation(
    request: HyperVCreateVirtualMachineRequest,
): readonly HyperVCreateStep[] {
    const network = request.network;
    if (network.kind === "managed-and-bootstrap") {
        const macAddressPattern = /^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2})$/i;
        if (typeof network.macAddress !== "string" || typeof network.bootstrapMacAddress !== "string"
            || !macAddressPattern.test(network.macAddress) || !macAddressPattern.test(network.bootstrapMacAddress)) {
            throw new Error("hyper-v-create-bootstrap-mac-address-invalid");
        }
        const managedMacAddress = parseHyperVMacAddress(network.macAddress);
        const bootstrapMacAddress = parseHyperVMacAddress(network.bootstrapMacAddress);
        // Exclude trailing line terminators admitted by the parser's end anchor.
        if (managedMacAddress.length !== 12 || bootstrapMacAddress.length !== 12) {
            throw new Error("hyper-v-create-bootstrap-mac-address-invalid");
        }
        if (managedMacAddress === bootstrapMacAddress) {
            throw new Error("hyper-v-create-bootstrap-mac-address-conflict");
        }
    }
    const diskDirectory = diskDirectoryOf(request.diskPath);
    const steps: HyperVCreateStep[] = [
        { kind: "ensure-directory", path: request.deviceRoot },
        ...(diskDirectory === null || diskDirectory === request.deviceRoot
            ? []
            : [{ kind: "ensure-directory", path: diskDirectory } as const]),
        {
            kind: "copy-base-image",
            source: request.baseImagePath,
            destination: request.diskPath,
            expectedSha256: request.baseImageSha256,
        },
        {
            kind: "create-vm",
            vmName: request.vmName,
            generation: request.firmware.generation,
            memoryStartupBytes: request.memoryStartupBytes,
            vhdPath: request.diskPath,
            switchName: newVMSwitchNameOf(request),
        },
    ];

    if (network.kind === "managed-and-bootstrap") {
        // The adapter New-VM made is on the bootstrap switch but still carries native's
        // default name. Renaming it before adding the second one keeps the two apart by name
        // at every moment in between -- if the device adapter were added first, both would
        // briefly answer to names the caller cannot tell apart.
        steps.push({ kind: "rename-adapter", adapter: { kind: "sole" }, to: network.bootstrapAdapterName });
        steps.push({
            kind: "set-adapter-mac",
            adapter: { kind: "name", name: network.bootstrapAdapterName },
            macAddress: network.bootstrapMacAddress,
        });
        steps.push({ kind: "add-adapter", adapterName: network.adapterName, switchName: network.switchName });
        steps.push({
            kind: "set-adapter-mac",
            adapter: { kind: "name", name: network.adapterName },
            macAddress: network.macAddress,
        });
    } else if (network.kind === "managed") {
        steps.push({ kind: "rename-adapter", adapter: { kind: "sole" }, to: network.adapterName });
        if (network.macAddress !== null) {
            steps.push({
                kind: "set-adapter-mac",
                adapter: { kind: "name", name: network.adapterName },
                macAddress: network.macAddress,
            });
        }
    }

    if (request.nestedVirtualization !== undefined && typeof request.nestedVirtualization !== "boolean") throw new Error("nested-virtualization-invalid");
    steps.push({ kind: "set-processor-count", count: request.processorCount,
        ...(request.nestedVirtualization === true ? { exposeVirtualizationExtensions: true } : {}),
    });
    steps.push({ kind: "disable-dynamic-memory" });
    steps.push({
        kind: "set-vm-settings",
        notes: request.notes,
        checkpointType: request.checkpointType,
        automaticCheckpointsEnabled: false,
    });
    steps.push(request.firmware.generation === 1
        ? { kind: "set-bios-startup-order", startupOrder: request.firmware.startupOrder }
        : {
            kind: "configure-firmware",
            secureBoot: request.firmware.secureBoot,
            firstBootDiskPath: request.diskPath,
        });
    return Object.freeze(steps);
}

/**
 * Says how to undo what creation actually did, given what it recorded doing.
 *
 * Derived from effects rather than from the request, and that distinction is the point. A
 * device root that was already on disk produces no `directory-created` effect, so nothing here
 * can remove it -- creation must never delete a directory it found rather than made. The
 * legacy script kept the same fact in `$DeviceRootExisted` and consulted it in its rollback;
 * this is that variable, made explicit and made plural.
 *
 * Undone in reverse, because the later a change was made the more it depends on the earlier
 * ones: the VM must go before the disk it has attached, and the disk before the directory that
 * holds it. Applied to what the legacy script recorded, reverse order reproduces its rollback
 * sequence exactly -- remove the VM, delete the disk, then the directories.
 *
 * Every entry is best-effort and independent. A caller that stops at the first failure leaves
 * the residue the remaining entries exist to clear, and is not running this plan.
 */
export function planHyperVVirtualMachineCreationCompensation(
    effects: readonly HyperVCreateEffect[],
): readonly HyperVCreateCompensation[] {
    const compensations: HyperVCreateCompensation[] = [];
    for (let index = effects.length - 1; index >= 0; index -= 1) {
        const effect = effects[index];
        if (effect === undefined) continue;
        // Every effect kind is named. There is deliberately no catch-all: an `else` here would
        // make the next path-carrying effect anyone adds silently become a recursive delete of
        // whatever path it happens to carry, which is exactly the one thing this design exists
        // to forbid. A new kind must break compilation below instead.
        switch (effect.kind) {
            case "vm-created":
                compensations.push({ kind: "remove-vm", vmId: effect.vmId });
                break;
            case "file-created":
                compensations.push({ kind: "delete-file", path: effect.path });
                break;
            case "directory-created":
                compensations.push({ kind: "delete-directory", path: effect.path });
                break;
            default:
                assertEveryEffectCompensated(effect);
        }
    }
    return Object.freeze(compensations);
}

// The switch New-VM itself attaches to. For a bootstrap guest that is deliberately the
// bootstrap switch and not the device switch: New-VM creates exactly one adapter, and the one
// it creates has to be the one the guest can reach DHCP on.
function newVMSwitchNameOf(request: HyperVCreateVirtualMachineRequest): string | null {
    const network = request.network;
    if (network.kind === "none") return null;
    if (network.kind === "managed-and-bootstrap") return network.bootstrapSwitchName;
    return network.switchName;
}

// A disk path with no directory part has no directory to create, and one whose only separator
// is the drive root resolves to that root. Returning the disk's own path -- which a naive
// `lastIndexOf` does for a bare filename -- would ask the executor to create a directory where
// the disk is about to be written.
function diskDirectoryOf(diskPath: string): string | null {
    const separator = Math.max(diskPath.lastIndexOf("\\"), diskPath.lastIndexOf("/"));
    if (separator < 0) return null;
    if (separator === 0) return diskPath.slice(0, 1);
    // "C:\\x.vhdx" -> "C:\\", not "C:", which names the drive's current directory instead.
    if (diskPath[separator - 1] === ":") return diskPath.slice(0, separator + 1);
    return diskPath.slice(0, separator);
}

/**
 * Says which effect a step can produce, or `null` when it changes nothing that has to be
 * undone. Not "when it succeeds": a step that fails partway can already have created the thing
 * it was making, and `HyperVCreateEffect` says the executor records it at that moment rather
 * than at the end of the step. Compensation for a half-finished copy is the reason.
 *
 * This is what makes "a step cannot be added without saying how to undo it" true rather than
 * merely intended. The switch is exhaustive, so a new step kind fails to compile until it is
 * named here -- and naming it forces the author to decide whether it leaves residue. An
 * `ensure-directory` that found the directory already there produces nothing, which is why
 * this answers in terms of a kind and the executor supplies whether it actually created it.
 */
export function effectKindOfStep(step: HyperVCreateStep): HyperVCreateEffect["kind"] | null {
    switch (step.kind) {
        case "ensure-directory":
            // Only when it did not already exist. The executor decides that; the plan decides
            // that this is the step which can produce it.
            return "directory-created";
        case "copy-base-image":
            return "file-created";
        case "create-vm":
            return "vm-created";
        case "rename-adapter":
        case "set-adapter-mac":
        case "add-adapter":
        case "set-processor-count":
        case "disable-dynamic-memory":
        case "set-vm-settings":
        case "set-bios-startup-order":
        case "configure-firmware":
            // These change the VM, and removing the VM undoes all of them at once. None leaves
            // residue that outlives it, so none has an effect of its own.
            return null;
        default:
            return assertEveryStepAccountedFor(step);
    }
}

// Reached only if a new member is added to the union without being handled. The parameter type
// makes that a compile error at the call site rather than a surprise at runtime.
function assertEveryStepAccountedFor(step: never): never {
    throw new Error(`hyper-v-create-step-unhandled:${JSON.stringify(step)}`);
}

function assertEveryEffectCompensated(effect: never): never {
    throw new Error(`hyper-v-create-effect-uncompensated:${JSON.stringify(effect)}`);
}
