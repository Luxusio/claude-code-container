import type {
    HyperVDvdDrive,
    HyperVHardDiskDrive,
    HyperVVirtualMachine,
} from "../low-level/index.js";

export type HyperVVirtualMachineIntent = "start" | "stop" | "restart" | "remove";

export type HyperVAttachmentExpectation = {
    readonly allowedPaths: readonly string[];
    readonly allowedRoots?: readonly string[];
    readonly allowedHardDiskRoots?: readonly string[];
    readonly allowedDvdRoots?: readonly string[];
    readonly expectedPaths?: readonly string[];
};

export type HyperVVirtualMachineExpectation = {
    readonly id: string;
    readonly name: string;
    readonly notes?: string;
    readonly attachments: HyperVAttachmentExpectation;
};

export type HyperVVirtualMachineInspection = {
    readonly virtualMachines: readonly HyperVVirtualMachine[];
    readonly hardDiskDrives: readonly HyperVHardDiskDrive[];
    readonly dvdDrives: readonly HyperVDvdDrive[];
};

export type HyperVAttachmentDrift = {
    readonly missingExpectedPaths: readonly string[];
};

export type HyperVUnexpectedAttachment = {
    readonly kind: "hard-disk" | "dvd";
    readonly path: string | null;
    readonly diskNumber?: number | null;
};

export type HyperVSettledOutcome = {
    readonly kind: "settled";
    readonly intent: HyperVVirtualMachineIntent;
    readonly virtualMachine: HyperVVirtualMachine;
    readonly inspection: HyperVVirtualMachineInspection;
    readonly drift: HyperVAttachmentDrift;
};

export type HyperVPendingOutcome = {
    readonly kind: "pending";
    readonly intent: HyperVVirtualMachineIntent;
    readonly virtualMachine: HyperVVirtualMachine;
    readonly inspection: HyperVVirtualMachineInspection;
    readonly drift: HyperVAttachmentDrift;
    readonly reason: "terminal-state-mismatch" | "transitioning-or-unknown" | "removal-required";
    readonly action: "start" | "stop" | "remove" | "wait";
};

export type HyperVAbsentOutcome = {
    readonly kind: "absent";
    readonly intent: HyperVVirtualMachineIntent;
    readonly inspection: HyperVVirtualMachineInspection;
    readonly satisfiesIntent: boolean;
};

export type HyperVIdentityConflictOutcome = {
    readonly kind: "identity-conflict";
    readonly intent: HyperVVirtualMachineIntent;
    readonly inspection: HyperVVirtualMachineInspection;
    readonly reason:
        | "ambiguous"
        | "id-mismatch"
        | "name-mismatch"
        | "notes-mismatch"
        | "attachment-identity-mismatch";
};

export type HyperVAttachmentConflictOutcome = {
    readonly kind: "attachment-conflict";
    readonly intent: HyperVVirtualMachineIntent;
    readonly virtualMachine: HyperVVirtualMachine;
    readonly inspection: HyperVVirtualMachineInspection;
    readonly unexpectedAttachments: readonly HyperVUnexpectedAttachment[];
};

export type HyperVVirtualMachineReconciliationOutcome =
    | HyperVSettledOutcome
    | HyperVPendingOutcome
    | HyperVAbsentOutcome
    | HyperVIdentityConflictOutcome
    | HyperVAttachmentConflictOutcome;

export type HyperVLifecycleRetryContext = {
    readonly attempt: number;
    readonly signal?: AbortSignal;
};

export type HyperVLifecycleSleeper = (
    delayMilliseconds: number,
    signal?: AbortSignal,
) => void | Promise<void>;

export type HyperVLifecycleRetryOptions = {
    readonly maxAttempts: number;
    readonly delayMilliseconds?: number | ((completedAttempts: number) => number);
    readonly signal?: AbortSignal;
    readonly sleeper?: HyperVLifecycleSleeper;
    readonly shouldRetryError?: (error: unknown, completedAttempts: number) => boolean;
};
