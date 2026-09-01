export { inspectHyperVVirtualMachine } from "./inspect.js";
export { reconcileHyperVVirtualMachine } from "./reconcile.js";
export { retryHyperVLifecycle } from "./retry.js";
export type {
    HyperVAbsentOutcome,
    HyperVAttachmentConflictOutcome,
    HyperVAttachmentDrift,
    HyperVAttachmentExpectation,
    HyperVIdentityConflictOutcome,
    HyperVLifecycleRetryContext,
    HyperVLifecycleRetryOptions,
    HyperVLifecycleSleeper,
    HyperVPendingOutcome,
    HyperVSettledOutcome,
    HyperVUnexpectedAttachment,
    HyperVVirtualMachineExpectation,
    HyperVVirtualMachineInspection,
    HyperVVirtualMachineIntent,
    HyperVVirtualMachineReconciliationOutcome,
} from "./contracts.js";
