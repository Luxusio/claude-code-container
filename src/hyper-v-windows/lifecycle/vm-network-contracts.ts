import type {
    HyperVMacAddress,
    HyperVNetIPAddress,
    HyperVNetNeighbor,
    HyperVVMNetworkAdapter,
    IPv4Address,
} from "../low-level/network-contracts.js";

// Everything one bootstrap discovery pass needs to reach a decision, gathered by the caller
// so that the decision itself stays a function of its inputs and runs anywhere.
export type HyperVBootstrapNetworkObservation = {
    // The adapters of the one VM being discovered, not the host-wide set.
    readonly vmAdapters: readonly HyperVVMNetworkAdapter[];
    // The host management adapters on the bootstrap switch. Their addresses, together with
    // the interfaces they sit on, define which subnets an answer may come from.
    readonly managementAdapters: readonly HyperVVMNetworkAdapter[];
    readonly hostIPv4Addresses: readonly HyperVNetIPAddress[];
    readonly neighbors: readonly HyperVNetNeighbor[];
};

export type HyperVBootstrapAdapterExpectation = {
    readonly adapterName: string;
    readonly switchName: string;
    // The host's name for its own interface on the bootstrap switch. It is the fallback way
    // to find the host's addresses on that network when the management adapter read comes
    // back empty -- which happens, and without the fallback discovery would fail outright
    // rather than degrade. The caller supplies it because the spelling is host policy.
    readonly managementInterfaceAlias: string;
};

// Every reason discovery can decline to produce addresses. These spellings are the ones the
// broker already maps into public status, so they are a compatibility surface, not free text.
export type HyperVBootstrapDiscoveryDiagnostic =
    | "hyper-v-bootstrap-network-adapter-ambiguous"
    | "hyper-v-bootstrap-network-adapter-identity-mismatch"
    | "hyper-v-bootstrap-host-prefix-inspection-failed";

export type HyperVBootstrapDiscoveryOutcome = {
    // Ordered, bounded, and possibly empty. Empty with no diagnostic means the adapter is
    // there and simply has no address yet -- the ordinary case while a guest boots, which is
    // why it is not an error.
    readonly addresses: readonly IPv4Address[];
    readonly diagnosticCode: HyperVBootstrapDiscoveryDiagnostic | null;
};

// What teardown decided to do about the bootstrap adapter. `remove` is the only branch that
// mutates, and it carries the exact identity the removal must name.
export type HyperVBootstrapTeardownDecision =
    | { readonly kind: "already-absent" }
    | {
        readonly kind: "remove";
        readonly adapterName: string;
        readonly macAddress: HyperVMacAddress;
    }
    | {
        readonly kind: "refuse";
        readonly diagnosticCode:
            | "hyper-v-bootstrap-network-adapter-ambiguous"
            | "hyper-v-bootstrap-network-adapter-identity-mismatch";
    };

export type HyperVBootstrapContainmentOutcome =
    | { readonly kind: "contained" }
    | { readonly kind: "breached"; readonly diagnosticCode: "hyper-v-bootstrap-network-containment-failed" };
