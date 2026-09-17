import {
    parseIPv4Address,
    type HyperVMacAddress,
    type HyperVNetIPAddress,
    type HyperVVMNetworkAdapter,
    type IPv4Address,
    type IPv4PrefixLength,
} from "../low-level/network-contracts.js";
import type {
    HyperVBootstrapAdapterExpectation,
    HyperVBootstrapContainmentOutcome,
    HyperVBootstrapDiscoveryOutcome,
    HyperVBootstrapNetworkObservation,
    HyperVBootstrapTeardownDecision,
} from "./vm-network-contracts.js";

// The guest gets one address per family at most, and a host answering with more than a
// handful is not answering about one adapter. The bound is the one the PowerShell this
// replaces used, and it is part of the behaviour, not an implementation detail: a caller
// probing for readiness must not be handed an unbounded list to work through.
const MAXIMUM_BOOTSTRAP_ADDRESSES = 8;
// Addresses that can never be the answer: unspecified, loopback, and link-local. A guest
// that has not yet taken a DHCP lease reports its link-local address, so admitting
// 169.254.0.0/16 would report a booting guest as ready at an address nothing can reach.
const UNREACHABLE_PREFIXES = ["0.", "127.", "169.254."];

function ipv4Octets(value: string): readonly number[] | null {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
    const octets = value.split(".").map(Number);
    return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

// Two addresses share a prefix when every whole byte of it matches and the partial byte
// matches under its mask.
function sameIPv4Prefix(left: readonly number[], right: readonly number[], prefixLength: number): boolean {
    const wholeBytes = Math.floor(prefixLength / 8);
    for (let index = 0; index < wholeBytes; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    const remainingBits = prefixLength % 8;
    if (remainingBits === 0) return true;
    const mask = 256 - 2 ** (8 - remainingBits);
    return ((left[wholeBytes] ?? 0) & mask) === ((right[wholeBytes] ?? 0) & mask);
}

type HostPrefix = {
    readonly octets: readonly number[];
    readonly address: string;
    readonly prefixLength: IPv4PrefixLength;
    readonly interfaceIndex: number;
};

/**
 * Chooses the addresses at which a bootstrap adapter may be reachable.
 *
 * A candidate qualifies when it is a well-formed reachable IPv4 address that shares a prefix
 * with one of the host's own addresses on the bootstrap network, and is not that host address
 * itself. Candidates are considered in sorted order and deduplicated, so the result is stable
 * across calls rather than dependent on the order the host happened to report things in.
 *
 * This deliberately differs from the PowerShell it replaces in one respect. There, a candidate
 * whose octets exceeded 255 reached `[Net.IPAddress]::Parse` and threw, which failed the whole
 * discovery pass and reported no addresses at all. Here such a candidate is skipped. Skipping
 * cannot lose a valid address, whereas failing the pass loses every address alongside the bad
 * one -- and discovery returning nothing is what stalls a device create.
 */
export function selectHyperVBootstrapAddresses(
    candidates: readonly string[],
    hostPrefixes: readonly HostPrefix[],
): readonly IPv4Address[] {
    const selected: IPv4Address[] = [];
    for (const candidate of [...new Set(candidates)].sort()) {
        if (UNREACHABLE_PREFIXES.some((prefix) => candidate.startsWith(prefix))) continue;
        const octets = ipv4Octets(candidate);
        if (!octets) continue;
        const matchesHostNetwork = hostPrefixes.some((hostPrefix) => candidate !== hostPrefix.address
            && sameIPv4Prefix(octets, hostPrefix.octets, hostPrefix.prefixLength));
        if (!matchesHostNetwork) continue;
        selected.push(parseIPv4Address(candidate));
        if (selected.length >= MAXIMUM_BOOTSTRAP_ADDRESSES) break;
    }
    return Object.freeze(selected);
}

function hostPrefixesFrom(
    managementAdapters: readonly HyperVVMNetworkAdapter[],
    hostIPv4Addresses: readonly HyperVNetIPAddress[],
    managementInterfaceAlias: string,
): readonly HostPrefix[] {
    const managementAddresses = new Set(managementAdapters.flatMap((adapter) => [...adapter.ipAddresses]));
    return hostIPv4Addresses
        // Either route to the host's own addresses on the bootstrap network is accepted. The
        // adapter read names them directly; the interface alias names the same interface when
        // that read returns nothing, which it does when the management adapter is not
        // enumerable. Requiring both would turn a recoverable gap into a failed discovery.
        .filter((entry) => (managementAddresses.has(entry.address) || entry.interfaceAlias === managementInterfaceAlias)
            && entry.prefixLength >= 8 && entry.prefixLength <= 30)
        .flatMap((entry) => {
            const octets = ipv4Octets(entry.address);
            return octets
                ? [{
                    octets,
                    address: entry.address as string,
                    prefixLength: entry.prefixLength,
                    interfaceIndex: entry.interfaceIndex as number,
                }]
                : [];
        });
}

function bootstrapAdaptersOf(
    observation: HyperVBootstrapNetworkObservation,
    expectation: HyperVBootstrapAdapterExpectation,
): readonly HyperVVMNetworkAdapter[] {
    return observation.vmAdapters.filter((adapter) => adapter.name === expectation.adapterName);
}

/**
 * Decides where a VM's bootstrap adapter may be reached, from one observation of the host.
 *
 * Both sources of candidates are used: what the guest reports through integration services,
 * and what the host's own neighbour table has learned for the adapter's address. The guest
 * may answer before the host has an entry, and the host may have an entry before integration
 * services are up, so neither alone is sufficient to find a booting guest.
 */
export function discoverHyperVBootstrapAddresses(
    observation: HyperVBootstrapNetworkObservation,
    expectation: HyperVBootstrapAdapterExpectation,
): HyperVBootstrapDiscoveryOutcome {
    const adapters = bootstrapAdaptersOf(observation, expectation);
    if (adapters.length > 1) {
        return { addresses: [], diagnosticCode: "hyper-v-bootstrap-network-adapter-ambiguous" };
    }
    const adapter = adapters[0];
    // No adapter at all is not a failure: teardown removes it once the guest is finalized,
    // and a later probe against a finalized device must report nothing rather than an error.
    if (!adapter) return { addresses: [], diagnosticCode: null };
    if (adapter.switchName !== expectation.switchName) {
        return { addresses: [], diagnosticCode: "hyper-v-bootstrap-network-adapter-identity-mismatch" };
    }

    const hostPrefixes = hostPrefixesFrom(
        observation.managementAdapters,
        observation.hostIPv4Addresses,
        expectation.managementInterfaceAlias,
    );
    if (hostPrefixes.length === 0) {
        // Without a host address on this network nothing can be judged reachable, and
        // answering with unfiltered guest claims would be worse than answering with nothing.
        return { addresses: [], diagnosticCode: "hyper-v-bootstrap-host-prefix-inspection-failed" };
    }

    const hostInterfaceIndexes = new Set(hostPrefixes.map((hostPrefix) => hostPrefix.interfaceIndex));
    const neighborCandidates = adapter.macAddress === null
        ? []
        : observation.neighbors
            // Only entries for this adapter's own address, learned on an interface that is on
            // the bootstrap network. A neighbour entry on any other interface describes a
            // different network where the same address may belong to something else.
            .filter((neighbor) => neighbor.linkLayerAddress === adapter.macAddress
                && hostInterfaceIndexes.has(neighbor.interfaceIndex as number))
            .map((neighbor) => neighbor.address as string);

    return {
        addresses: selectHyperVBootstrapAddresses(
            [...adapter.ipAddresses, ...neighborCandidates],
            hostPrefixes,
        ),
        diagnosticCode: null,
    };
}

/**
 * Decides whether the bootstrap adapter should be removed, and on exactly what identity.
 *
 * Removal requires the adapter's name, its switch, and a usable address all to agree with
 * what was expected. Any disagreement refuses rather than guesses: this adapter is removed
 * from a VM the caller owns, and an adapter that is not the one expected is someone else's.
 */
export function planHyperVBootstrapTeardown(
    observation: HyperVBootstrapNetworkObservation,
    expectation: HyperVBootstrapAdapterExpectation,
    expectedMacAddress: HyperVMacAddress,
): HyperVBootstrapTeardownDecision {
    const adapters = bootstrapAdaptersOf(observation, expectation)
        .filter((adapter) => adapter.macAddress === expectedMacAddress);
    if (adapters.length > 1) {
        return { kind: "refuse", diagnosticCode: "hyper-v-bootstrap-network-adapter-ambiguous" };
    }
    const adapter = adapters[0];
    // Already gone is success, not an error: teardown has to be safe to repeat after a crash
    // between the removal and the record of it.
    if (!adapter) return { kind: "already-absent" };
    if (adapter.switchName !== expectation.switchName) {
        return { kind: "refuse", diagnosticCode: "hyper-v-bootstrap-network-adapter-identity-mismatch" };
    }
    return { kind: "remove", adapterName: adapter.name, macAddress: expectedMacAddress };
}

/**
 * Confirms that no adapter anywhere on the host still carries the bootstrap address.
 *
 * Checked host-wide rather than against the one VM, because the point is that the address is
 * free for reuse. An adapter on another VM holding it would collide with the next device that
 * derives the same address.
 */
export function confirmHyperVBootstrapContainment(
    hostWideAdapters: readonly HyperVVMNetworkAdapter[],
    expectedMacAddress: HyperVMacAddress,
): HyperVBootstrapContainmentOutcome {
    const remaining = hostWideAdapters.some((adapter) => adapter.macAddress === expectedMacAddress);
    return remaining
        ? { kind: "breached", diagnosticCode: "hyper-v-bootstrap-network-containment-failed" }
        : { kind: "contained" };
}
