import { win32 } from "path";

import type {
    HyperVAttachmentDrift,
    HyperVAttachmentExpectation,
    HyperVPendingOutcome,
    HyperVUnexpectedAttachment,
    HyperVVirtualMachineExpectation,
    HyperVVirtualMachineInspection,
    HyperVVirtualMachineIntent,
    HyperVVirtualMachineReconciliationOutcome,
} from "./contracts.js";

function normalizedWindowsPath(path: string): string {
    return win32.normalize(path).toLowerCase();
}

function pathIsWithinRoot(path: string, root: string): boolean {
    const relative = win32.relative(normalizedWindowsPath(root), normalizedWindowsPath(path));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative));
}

function attachmentIsAllowed(
    path: string,
    expectation: HyperVAttachmentExpectation,
    kind: HyperVUnexpectedAttachment["kind"],
): boolean {
    const normalized = normalizedWindowsPath(path);
    const exactPaths = [...expectation.allowedPaths, ...(expectation.expectedPaths ?? [])];
    const kindRoots = kind === "hard-disk"
        ? expectation.allowedHardDiskRoots ?? []
        : expectation.allowedDvdRoots ?? [];
    return exactPaths.some((allowed) => normalizedWindowsPath(allowed) === normalized)
        || [...expectation.allowedRoots ?? [], ...kindRoots].some((root) => pathIsWithinRoot(path, root));
}

function observedAttachmentPaths(inspection: HyperVVirtualMachineInspection): readonly string[] {
    return [
        ...inspection.hardDiskDrives.map((drive) => drive.path),
        ...inspection.dvdDrives.map((drive) => drive.path),
    ].filter((path): path is string => path !== null);
}

function attachmentDrift(
    inspection: HyperVVirtualMachineInspection,
    expectation: HyperVAttachmentExpectation,
): HyperVAttachmentDrift {
    const observed = new Set(observedAttachmentPaths(inspection).map(normalizedWindowsPath));
    return {
        missingExpectedPaths: (expectation.expectedPaths ?? []).filter(
            (path) => !observed.has(normalizedWindowsPath(path)),
        ),
    };
}

function unexpectedAttachments(
    inspection: HyperVVirtualMachineInspection,
    expectation: HyperVAttachmentExpectation,
): readonly HyperVUnexpectedAttachment[] {
    return [
        ...inspection.hardDiskDrives.flatMap<HyperVUnexpectedAttachment>((drive) => drive.path === null
            ? [{ kind: "hard-disk" as const, path: null, diskNumber: drive.diskNumber }]
            : !attachmentIsAllowed(drive.path, expectation, "hard-disk")
                ? [{ kind: "hard-disk" as const, path: drive.path }]
                : []),
        ...inspection.dvdDrives.flatMap<HyperVUnexpectedAttachment>((drive) => drive.path !== null && !attachmentIsAllowed(drive.path, expectation, "dvd")
            ? [{ kind: "dvd" as const, path: drive.path }]
            : []),
    ];
}

function attachmentIdentityMatches(inspection: HyperVVirtualMachineInspection): boolean {
    const virtualMachine = inspection.virtualMachines[0];
    return [...inspection.hardDiskDrives, ...inspection.dvdDrives].every(
        (drive) => drive.vmId.toLowerCase() === virtualMachine.id.toLowerCase()
            && drive.vmName === virtualMachine.name,
    );
}

function pending(
    intent: HyperVVirtualMachineIntent,
    inspection: HyperVVirtualMachineInspection,
    drift: HyperVAttachmentDrift,
    reason: HyperVPendingOutcome["reason"],
    action: HyperVPendingOutcome["action"],
): HyperVPendingOutcome {
    return {
        kind: "pending",
        intent,
        virtualMachine: inspection.virtualMachines[0],
        inspection,
        drift,
        reason,
        action,
    };
}

export function reconcileHyperVVirtualMachine(
    inspection: HyperVVirtualMachineInspection,
    expectation: HyperVVirtualMachineExpectation,
    intent: HyperVVirtualMachineIntent,
): HyperVVirtualMachineReconciliationOutcome {
    if (inspection.virtualMachines.length === 0) {
        return {
            kind: "absent",
            intent,
            inspection,
            satisfiesIntent: intent === "remove",
        };
    }
    if (inspection.virtualMachines.length !== 1) {
        return { kind: "identity-conflict", intent, inspection, reason: "ambiguous" };
    }

    const virtualMachine = inspection.virtualMachines[0];
    if (virtualMachine.id.toLowerCase() !== expectation.id.toLowerCase()) {
        return { kind: "identity-conflict", intent, inspection, reason: "id-mismatch" };
    }
    if (virtualMachine.name !== expectation.name) {
        return { kind: "identity-conflict", intent, inspection, reason: "name-mismatch" };
    }
    if (expectation.notes !== undefined && virtualMachine.notes !== expectation.notes) {
        return { kind: "identity-conflict", intent, inspection, reason: "notes-mismatch" };
    }
    if (!attachmentIdentityMatches(inspection)) {
        return { kind: "identity-conflict", intent, inspection, reason: "attachment-identity-mismatch" };
    }

    const unexpected = unexpectedAttachments(inspection, expectation.attachments);
    if (unexpected.length > 0) {
        return {
            kind: "attachment-conflict",
            intent,
            virtualMachine,
            inspection,
            unexpectedAttachments: unexpected,
        };
    }

    const drift = attachmentDrift(inspection, expectation.attachments);
    if (intent === "remove") {
        return pending(intent, inspection, drift, "removal-required", "remove");
    }

    const state = virtualMachine.state.toLowerCase();
    const desiredState = intent === "stop" ? "off" : "running";
    if (state === desiredState) {
        return { kind: "settled", intent, virtualMachine, inspection, drift };
    }
    if (state === "running" || state === "off") {
        return pending(
            intent,
            inspection,
            drift,
            "terminal-state-mismatch",
            intent === "stop" ? "stop" : "start",
        );
    }
    return pending(intent, inspection, drift, "transitioning-or-unknown", "wait");
}
