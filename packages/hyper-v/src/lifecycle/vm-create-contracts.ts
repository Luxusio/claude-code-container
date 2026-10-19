import type {
    HyperVBiosStartupDevice,
    HyperVSecureBootSetting,
    HyperVVirtualMachineGeneration,
    HyperVVMNetworkAdapterTarget,
} from "../low-level/contracts.js";

/**
 * What one VM creation needs, with the parts that cannot vary together already resolved.
 *
 * Paths arrive as plain strings. Where they point and who may write them is consumer policy,
 * and the library is not the place that decides it -- but the library does decide the order
 * they are used in and what happens when a step fails partway.
 */
export type HyperVCreateVirtualMachineRequest = {
    readonly vmName: string;
    // Generation and the firmware settings that belong to it, as one value. A generation-1 VM
    // carries a BIOS startup order and a generation-2 VM carries Secure Boot; neither can be
    // written against the other, which is the invariant the legacy command enforced with a
    // runtime throw.
    readonly firmware: HyperVVirtualMachineGeneration;
    readonly memoryStartupBytes: number;
    readonly processorCount: number;
    readonly nestedVirtualization?: boolean;
    readonly notes: string;
    readonly checkpointType: "Disabled" | "Production" | "ProductionOnly" | "Standard";
    // The directory the device owns, and the disk inside it. Both may already exist; the plan
    // records which ones creation actually made, because only those may be removed on failure.
    readonly deviceRoot: string;
    readonly diskPath: string;
    readonly baseImagePath: string;
    readonly baseImageSha256: string;
    readonly network: HyperVCreateNetworkIntent;
};

/**
 * Which adapters the VM gets. `none` is not the absence of a setting -- it is the decision to
 * create a VM with no network, which native expresses by being given no switch at all.
 *
 * `managed-and-bootstrap` exists because a Linux guest needs DHCP from the default switch
 * before it can be reached on the device network. Its two adapters are created by different
 * cmdlets -- the first comes free with `New-VM`, the second needs `Add-VMNetworkAdapter` --
 * so the pairing is recorded here rather than rediscovered at execution time.
 */
export type HyperVCreateNetworkIntent =
    | { readonly kind: "none" }
    | {
        readonly kind: "managed";
        readonly switchName: string;
        readonly adapterName: string;
        readonly macAddress: string | null;
    }
    | {
        readonly kind: "managed-and-bootstrap";
        readonly switchName: string;
        readonly adapterName: string;
        readonly macAddress: string;
        readonly bootstrapSwitchName: string;
        readonly bootstrapAdapterName: string;
        readonly bootstrapMacAddress: string;
    };
// Adapter addresses are caller policy. Both are explicit, and the planner rejects equal
// identities so creation cannot assign the same static address to two adapters.

/**
 * One step of creation, in the order it must run.
 *
 * Steps that change nothing on the host carry no compensation and are not represented here at
 * all: host capacity and path inspection belong to the caller, which can refuse before any of
 * this starts. What this describes is only the part that leaves residue if it stops halfway.
 */
export type HyperVCreateStep =
    | { readonly kind: "ensure-directory"; readonly path: string }
    | {
        readonly kind: "copy-base-image";
        readonly source: string;
        readonly destination: string;
        readonly expectedSha256: string;
    }
    | {
        readonly kind: "create-vm";
        readonly vmName: string;
        readonly generation: 1 | 2;
        readonly memoryStartupBytes: number;
        readonly vhdPath: string;
        // The switch New-VM attaches the first adapter to, if any. For the bootstrap case this
        // is the bootstrap switch, because the adapter New-VM creates is the one that must
        // carry DHCP -- the device adapter is added afterwards.
        readonly switchName: string | null;
    }
    // Carries no source name. The adapter New-VM creates is spelled in the host's display
    // language, so naming it would be a literal that is wrong on a localized Hyper-V -- and
    // the PowerShell this replaces never named it either: it asserted the VM had exactly one
    // adapter and took that one. `sole` is that assertion.
    | { readonly kind: "rename-adapter"; readonly adapter: HyperVVMNetworkAdapterTarget; readonly to: string }
    | { readonly kind: "set-adapter-mac"; readonly adapter: HyperVVMNetworkAdapterTarget; readonly macAddress: string }
    | { readonly kind: "add-adapter"; readonly adapterName: string; readonly switchName: string }
    | { readonly kind: "set-processor-count"; readonly count: number; readonly exposeVirtualizationExtensions?: boolean }
    | { readonly kind: "disable-dynamic-memory" }
    | {
        readonly kind: "set-vm-settings";
        readonly notes: string;
        readonly checkpointType: "Disabled" | "Production" | "ProductionOnly" | "Standard";
        // Typed `false` rather than `boolean` because there is no correct `true`. On a client
        // Hyper-V host automatic checkpoints default ON, and then every `Start-VM` switches the
        // OS disk onto an AVHDX differencing chain -- which breaks the created-disk identity
        // check, collides with the snapshot machinery, and grows storage with nothing asking
        // it to. `checkpointType` does not cover this: it picks which kind of checkpoint is
        // taken, not whether the host takes one unasked. The literal can widen to `boolean`
        // the day a caller needs it; widening is compatible, narrowing later would not be.
        readonly automaticCheckpointsEnabled: false;
    }
    // Two kinds, not one carrying an optional path. Three reasons, in order of weight.
    //
    // A generation-1 VM routes to `Set-VMBios` and a generation-2 VM to `Set-VMFirmware`.
    // Every other step kind here names exactly one cmdlet; a single `configure-firmware`
    // naming two was the only place that stopped being true.
    //
    // The boot-disk path has no generation-1 consumer -- `Set-VMBios` takes a selector and a
    // startup order and resolves no disk -- so carrying it on a shared member would be a field
    // no decision reads, which this slice adopted as a defect.
    //
    // And the discriminant has to be `kind` to do any work: TypeScript does not narrow a union
    // by a nested property, so two members distinguished only by `firmware.generation` would
    // still hand a consumer a union it cannot narrow. Splitting on `kind` is what makes the
    // absence reachable by the executor rather than merely true on paper.
    | {
        readonly kind: "set-bios-startup-order";
        readonly startupOrder: readonly HyperVBiosStartupDevice[];
    }
    | {
        readonly kind: "configure-firmware";
        readonly secureBoot: HyperVSecureBootSetting;
        readonly firstBootDiskPath: string;
    };

/**
 * A change creation actually made, recorded as it is made.
 *
 * This is the whole reason compensation is trustworthy. The legacy script did the same thing
 * with local variables -- `$CreatedVm`, `$DeviceRootExisted` -- and its rollback consulted
 * those rather than re-deriving intent from the request. A directory that was already there
 * produces no effect and is therefore never removed, which is the single most important
 * property here: creation must not delete a device root it did not create.
 *
 * WHEN each is recorded is part of the contract, not an executor detail. `directory-created`
 * and `file-created` are recorded the moment the host object comes into existence -- not when
 * the step that makes it succeeds. A base-image copy that creates its destination and then
 * fails partway (hash mismatch, length mismatch, plain I/O) has already put a partial
 * multi-gigabyte VHDX in the device root, and recording only on success would leave it there
 * forever. The legacy rollback deleted the disk path unconditionally, so recording late would
 * make this plan strictly weaker than the script it replaces on exactly that sequence.
 * `vm-created` has no such window: native either returns a VM or it does not.
 */
export type HyperVCreateEffect =
    | { readonly kind: "directory-created"; readonly path: string }
    | { readonly kind: "file-created"; readonly path: string }
    | { readonly kind: "vm-created"; readonly vmId: string };

/**
 * One undo, in the order it must run.
 *
 * Every compensation is best-effort and independent: the legacy rollback wrapped each in its
 * own `catch` so that a failure to remove the disk still let it remove the device root. That
 * is a property of the plan, not of the executor, so it is stated here -- a caller that stops
 * the sequence on the first error is not running this plan.
 */
export type HyperVCreateCompensation =
    | { readonly kind: "remove-vm"; readonly vmId: string }
    | { readonly kind: "delete-file"; readonly path: string }
    | { readonly kind: "delete-directory"; readonly path: string };
