import type {
    HyperVHostNetworkAdapter,
    HyperVNatIdentity,
    HyperVNetIPAddress,
    HyperVNetNat,
    HyperVVirtualSwitch,
    HyperVVirtualSwitchIdentity,
    HyperVVMNetworkAdapter,
    IPv4Address,
    IPv4PrefixLength,
} from "../low-level/network-contracts.js";

export type HyperVHostNetworkPrivilege = "standard" | "administrator";

export type HyperVHostNetworkNatEvidence =
    | { readonly kind: "unrecorded" }
    | { readonly kind: "absent" }
    | { readonly kind: "exact"; readonly identity: HyperVNatIdentity };

export type HyperVHostNetworkEnsureProvenance =
    | {
        readonly kind: "fresh";
        readonly expectedSwitchNotes: string;
    }
    | {
        readonly kind: "recognized-adoption";
        readonly expectedSwitchNotes: string;
        readonly switchIdentity: HyperVVirtualSwitchIdentity;
        readonly nat: HyperVHostNetworkNatEvidence;
    }
    | {
        readonly kind: "persisted";
        readonly expectedSwitchNotes: string;
        readonly switchIdentity: HyperVVirtualSwitchIdentity;
        readonly nat: HyperVHostNetworkNatEvidence;
    };

export type HyperVHostNetworkObservation = {
    readonly privilege: HyperVHostNetworkPrivilege;
    readonly provenance: HyperVHostNetworkEnsureProvenance;
    readonly virtualSwitches: readonly HyperVVirtualSwitch[];
    readonly hostAdapters: readonly HyperVHostNetworkAdapter[];
    readonly ipv4Addresses: readonly HyperVNetIPAddress[];
    readonly nats: readonly HyperVNetNat[];
    readonly vmNetworkAdapters: readonly HyperVVMNetworkAdapter[];
};

export type HyperVHostNetworkManagedResource<Identity> =
    | { readonly kind: "unmanaged" }
    | { readonly kind: "managed"; readonly identity: Identity };

export type HyperVHostNetworkCleanupProvenance = {
    readonly switch: HyperVHostNetworkManagedResource<HyperVVirtualSwitchIdentity>;
    readonly gateway: HyperVHostNetworkManagedResource<{
        readonly switchIdentity: HyperVVirtualSwitchIdentity;
        readonly address: IPv4Address;
        readonly prefixLength: IPv4PrefixLength;
    }>;
    readonly nat: HyperVHostNetworkManagedResource<HyperVNatIdentity>;
};

export type HyperVHostNetworkCleanupObservation = {
    readonly privilege: HyperVHostNetworkPrivilege;
    readonly virtualSwitches: readonly HyperVVirtualSwitch[];
    readonly hostAdapters: readonly HyperVHostNetworkAdapter[];
    readonly ipv4Addresses: readonly HyperVNetIPAddress[];
    readonly nats: readonly HyperVNetNat[];
    readonly vmNetworkAdapters: readonly HyperVVMNetworkAdapter[];
};

export type HyperVHostNetworkSettledIdentity = {
    readonly switchIdentity: HyperVVirtualSwitchIdentity;
    readonly interfaceIndex: HyperVHostNetworkAdapter["interfaceIndex"];
    readonly natIdentity: HyperVNatIdentity;
};

type HyperVHostNetworkCommonConflictReason =
    | "switch-ambiguous"
    | "switch-identity-conflict"
    | "switch-successor-conflict"
    | "switch-type-unsupported"
    | "host-adapter-ambiguous"
    | "gateway-conflict"
    | "nat-ambiguous"
    | "nat-identity-conflict"
    | "nat-successor-conflict"
    | "nat-prefix-conflict";

type HyperVHostNetworkEnsureOnlyConflictReason =
    | "switch-notes-conflict"
    | "switch-notes-repair-unproven"
    | "host-adapter-status-unsupported"
    | "foreign-nat-subnet-overlap"
    | "foreign-interface-subnet-overlap"
    | "gateway-address-state-unsupported";

export type HyperVHostNetworkConflictReason =
    | HyperVHostNetworkCommonConflictReason
    | HyperVHostNetworkEnsureOnlyConflictReason;

export type HyperVHostNetworkConflictReasonFor<Operation extends HyperVHostNetworkOperation> =
    | HyperVHostNetworkCommonConflictReason
    | (Operation extends "ensure" ? HyperVHostNetworkEnsureOnlyConflictReason : never);

export type HyperVHostNetworkActionKind =
    | "create-switch"
    | "repair-switch-notes"
    | "create-gateway"
    | "create-nat"
    | "remove-nat"
    | "remove-gateway"
    | "remove-switch";

export type HyperVHostNetworkOperation = "ensure" | "cleanup";

type HyperVHostNetworkSettledOutcomeByOperation =
    | {
        readonly kind: "settled";
        readonly operation: "ensure";
        readonly identity: HyperVHostNetworkSettledIdentity;
    }
    | {
        readonly kind: "settled";
        readonly operation: "cleanup";
        readonly disposition: "complete";
    }
    | {
        readonly kind: "settled";
        readonly operation: "cleanup";
        readonly disposition: "deferred-switch-in-use";
        readonly switchIdentity: HyperVVirtualSwitchIdentity;
        readonly attachments: readonly HyperVVMNetworkAdapter[];
    };

export type HyperVHostNetworkSettledOutcome<
    Operation extends HyperVHostNetworkOperation = HyperVHostNetworkOperation,
> = Extract<HyperVHostNetworkSettledOutcomeByOperation, { readonly operation: Operation }>;

export type HyperVHostNetworkConflictOutcome<
    Operation extends HyperVHostNetworkOperation = HyperVHostNetworkOperation,
> = Operation extends HyperVHostNetworkOperation
    ? {
        readonly kind: "conflict";
        readonly operation: Operation;
        readonly reason: HyperVHostNetworkConflictReasonFor<Operation>;
    }
    : never;

export type HyperVHostNetworkActionKindFor<Operation extends HyperVHostNetworkOperation> =
    Operation extends "ensure"
        ? "create-switch" | "repair-switch-notes" | "create-gateway" | "create-nat"
        : "remove-nat" | "remove-gateway" | "remove-switch";

export type HyperVHostNetworkNeedsAdministratorOutcome<
    Operation extends HyperVHostNetworkOperation = HyperVHostNetworkOperation,
> = Operation extends HyperVHostNetworkOperation
    ? {
        readonly kind: "needs-administrator";
        readonly operation: Operation;
        readonly requiredAction: HyperVHostNetworkActionKindFor<Operation>;
    }
    : never;

export type HyperVHostNetworkIndeterminateOutcome<
    Operation extends HyperVHostNetworkOperation = HyperVHostNetworkOperation,
> = Operation extends HyperVHostNetworkOperation
    ? {
        readonly kind: "indeterminate";
        readonly operation: Operation;
        readonly reason: "mutation-result-unconfirmed"
            | (Operation extends "ensure" ? "host-adapter-missing" | "gateway-transitioning" : never);
        readonly actionKind?: HyperVHostNetworkActionKindFor<Operation>;
        readonly cause?: unknown;
    }
    : never;
