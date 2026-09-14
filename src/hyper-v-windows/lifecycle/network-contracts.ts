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

export type HyperVHostNetworkConflictReason =
    | "switch-ambiguous"
    | "switch-identity-conflict"
    | "switch-successor-conflict"
    | "switch-type-unsupported"
    | "switch-notes-conflict"
    | "switch-notes-repair-unproven"
    | "host-adapter-ambiguous"
    | "host-adapter-status-unsupported"
    | "foreign-nat-subnet-overlap"
    | "foreign-interface-subnet-overlap"
    | "gateway-conflict"
    | "gateway-address-state-unsupported"
    | "nat-ambiguous"
    | "nat-identity-conflict"
    | "nat-successor-conflict"
    | "nat-prefix-conflict";

export type HyperVHostNetworkActionKind =
    | "create-switch"
    | "repair-switch-notes"
    | "create-gateway"
    | "create-nat"
    | "remove-nat"
    | "remove-gateway"
    | "remove-switch";

export type HyperVHostNetworkSettledOutcome =
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

export type HyperVHostNetworkConflictOutcome = {
    readonly kind: "conflict";
    readonly operation: "ensure" | "cleanup";
    readonly reason: HyperVHostNetworkConflictReason;
};

export type HyperVHostNetworkNeedsAdministratorOutcome = {
    readonly kind: "needs-administrator";
    readonly operation: "ensure" | "cleanup";
    readonly requiredAction: HyperVHostNetworkActionKind;
};

export type HyperVHostNetworkIndeterminateOutcome = {
    readonly kind: "indeterminate";
    readonly operation: "ensure" | "cleanup";
    readonly reason: "host-adapter-missing" | "gateway-transitioning" | "mutation-result-unconfirmed";
    readonly actionKind?: HyperVHostNetworkActionKind;
    readonly cause?: unknown;
};
