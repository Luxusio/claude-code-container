import type {
    HyperVBiosStartupDevice,
    HyperVSecureBootSetting,
    HyperVVirtualMachineGeneration,
} from "@ccc/hyper-v/low-level/contracts.js";
import type {
    HyperVCreateEffect,
    HyperVCreateNetworkIntent,
    HyperVCreateStep,
} from "@ccc/hyper-v/lifecycle/vm-create-contracts.js";

// These assertions fail by COMPILING. Each `@ts-expect-error` is a claim that the combination
// below it cannot be written; if a future change makes one writable, the directive becomes
// unused and this file stops compiling. The legacy command enforced the first two with a
// runtime `throw` reached only on a real host.

// A generation-1 VM has a BIOS and no firmware object, so Secure Boot has nowhere to live.
// This is the invariant `vm-create.ts` spent a runtime check on.
export const secureBootNeedsGeneration2: HyperVVirtualMachineGeneration = {
    generation: 1,
    // @ts-expect-error Secure Boot is a generation-2 firmware setting
    secureBoot: { enabled: true, template: "MicrosoftWindows" },
};

// A generation-2 VM has firmware and no BIOS, so a startup order has nowhere to live.
export const startupOrderNeedsGeneration1: HyperVVirtualMachineGeneration = {
    generation: 2,
    // @ts-expect-error a BIOS startup order is a generation-1 setting
    startupOrder: ["IDE"],
};

// Native rejects a template when Secure Boot is off, so the pair cannot be expressed.
export const disabledSecureBootCarriesNoTemplate: HyperVSecureBootSetting = {
    enabled: false,
    // @ts-expect-error a disabled Secure Boot has no template
    template: "MicrosoftWindows",
};

// Each generation must still be writable in its own shape, or the union above would be
// proving its point by forbidding everything.
export const generation1IsWritable: HyperVVirtualMachineGeneration = {
    generation: 1,
    startupOrder: ["IDE", "CD"],
};

export const generation2IsWritable: HyperVVirtualMachineGeneration = {
    generation: 2,
    secureBoot: { enabled: false },
};

// @ts-expect-error a startup device outside the four native accepts is not a startup device
export const unknownStartupDevice: HyperVBiosStartupDevice = "USB";

// A bootstrap guest needs an explicit address on both adapters. A missing-field consumer
// proves that bootstrapMacAddress is required; a null excess property alone cannot prove it.
// @ts-expect-error the caller must supply a bootstrap address instead of asking the library to derive one
export const bootstrapAddressIsNotOptional: HyperVCreateNetworkIntent = {
    kind: "managed-and-bootstrap",
    switchName: "ccc-internal",
    adapterName: "CCC Device Network",
    macAddress: "02:15:5d:01:1a:2c",
    bootstrapSwitchName: "Default Switch",
    bootstrapAdapterName: "CCC Bootstrap DHCP",
};

export const bootstrapAddressCannotBeNull: HyperVCreateNetworkIntent = {
    kind: "managed-and-bootstrap",
    switchName: "ccc-internal",
    adapterName: "CCC Device Network",
    macAddress: "02:15:5d:01:1a:2c",
    bootstrapSwitchName: "Default Switch",
    bootstrapAdapterName: "CCC Bootstrap DHCP",
    // @ts-expect-error a bootstrap adapter with no address cannot be reached, so null is not a value here
    bootstrapMacAddress: null,
};

export const bootstrapAddressCannotBeUndefined: HyperVCreateNetworkIntent = {
    kind: "managed-and-bootstrap",
    switchName: "ccc-internal",
    adapterName: "CCC Device Network",
    macAddress: "02:15:5d:01:1a:2c",
    bootstrapSwitchName: "Default Switch",
    bootstrapAdapterName: "CCC Bootstrap DHCP",
    // @ts-expect-error the required explicit address is a string, including with exact optional properties enabled
    bootstrapMacAddress: undefined,
};

export const bootstrapManagedAddressCannotBeNull: Extract<HyperVCreateNetworkIntent, { kind: "managed-and-bootstrap" }> = {
    kind: "managed-and-bootstrap",
    switchName: "ccc-internal",
    adapterName: "CCC Device Network",
    // @ts-expect-error a guest with both adapters must also supply its managed address
    macAddress: null,
    bootstrapSwitchName: "Default Switch",
    bootstrapAdapterName: "CCC Bootstrap DHCP",
    bootstrapMacAddress: "0A-2B-3C-4D-5E-6F",
};

export const explicitBootstrapPairIsWritable: HyperVCreateNetworkIntent = {
    kind: "managed-and-bootstrap",
    switchName: "ccc-internal",
    adapterName: "CCC Device Network",
    macAddress: "02:15:5d:01:1a:2c",
    bootstrapSwitchName: "Default Switch",
    bootstrapAdapterName: "CCC Bootstrap DHCP",
    bootstrapMacAddress: "0A-2B-3C-4D-5E-6F",
};

export const managedNetworkWithoutAnAddressIsWritable: HyperVCreateNetworkIntent = {
    kind: "managed",
    switchName: "ccc-internal",
    adapterName: "CCC Device Network",
    macAddress: null,
};

// A VM with no network carries no switch to name.
export const noNetworkCarriesNoSwitch: HyperVCreateNetworkIntent = {
    kind: "none",
    // @ts-expect-error a VM with no network has no switch
    switchName: "ccc-internal",
};

// An effect records what happened, so a directory effect cannot carry a VM id and a VM effect
// cannot carry a path. Mixing them is how a compensation aims at the wrong thing.
export const directoryEffectCarriesNoVmId: HyperVCreateEffect = {
    kind: "directory-created",
    path: "C:\\ccc\\devices\\device-1",
    // @ts-expect-error a directory was not a virtual machine
    vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
};

// Generation 1 and generation 2 are different steps because they are different cmdlets, and
// the boot disk rides only on the one that can use it. What these two prove is the absence:
// the field is on no other member either, so the error stands with or without the narrowing
// above it. That the narrowing itself works -- that `kind` alone is enough to reach a member
// without the field -- is a separate claim, and it is proven by compiling a consumer against
// the barrel, not here.
export function biosStartupOrderHasNoBootDisk(step: HyperVCreateStep): string {
    if (step.kind !== "set-bios-startup-order") return "";
    // @ts-expect-error Set-VMBios takes a startup order and resolves no disk
    return step.firstBootDiskPath;
}

// That `kind` alone narrows to a member is the whole justification for splitting the step, and
// it was the one claim nothing in this repo checked -- it was proven by compiling a consumer
// against the barrel, which lives in no commit. This passes by compiling. Remove the guard and
// it fails with TS2339, which is the control that makes it mean something.
export function biosStepNarrowsToItsOwnFields(step: HyperVCreateStep): readonly HyperVBiosStartupDevice[] {
    if (step.kind !== "set-bios-startup-order") return [];
    return step.startupOrder;
}

// The converse: the UEFI step has no startup order, because Set-VMFirmware does not take one.
export function firmwareStepHasNoStartupOrder(step: HyperVCreateStep): readonly string[] {
    if (step.kind !== "configure-firmware") return [];
    // @ts-expect-error a startup order belongs to Set-VMBios, not Set-VMFirmware
    return step.startupOrder;
}

// And the boot disk is not optional on the step that does read it: a generation-2 VM that
// names no first boot device is the legacy's silent-boot-order bug, not a valid plan.
// @ts-expect-error Set-VMFirmware names the disk to boot, so the path is required
export const firmwareStepNeedsItsBootDisk: HyperVCreateStep = {
    kind: "configure-firmware",
    secureBoot: { enabled: false },
};
