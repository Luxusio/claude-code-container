import { createHash } from "crypto";
import {
    HYPER_V_NETWORK_GATEWAY,
    HYPER_V_NETWORK_MARKER,
    HYPER_V_NETWORK_NAT,
    HYPER_V_NETWORK_PREFIX,
    HYPER_V_NETWORK_SWITCH,
    isHyperVCccNetworkIdentity,
} from "../../../host-control/hyper-v/contracts.js";

const NETWORK_TOKEN_PATTERN = /^[a-f0-9]{24}$/;
const NETWORK_SWITCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NETWORK_NAT_NAME_PATTERN = /^CCCDeviceLab-[a-f0-9]{24}$/;
const NETWORK_MARKER_PATTERN = /^ccc-device-lab:hyper-v-network:(?:v1|[a-f0-9]{24})$/;
const NETWORK_OWNER_ID_PATTERN = /^[a-f0-9]{16}$/;
const NETWORK_DEVICE_ID_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._:-]{1,128}$/;
const NETWORK_INCARNATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const NETWORK_ADDRESS_PATTERN = /^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/;
const NETWORK_MAC_ADDRESS_PATTERN = /^02(?::[a-f0-9]{2}){5}$/;
const NETWORK_NAT_INSTANCE_ID_MAX_LENGTH = 256;

const STATE_KEYS = new Set([
    "version",
    "switchName",
    "switchId",
    "marker",
    "natName",
    "natInstanceId",
    "prefix",
    "gateway",
    "outboundPolicy",
    "managedSwitch",
    "managedGateway",
    "managedNat",
    "allocations",
]);

const INTENT_KEYS = new Set([
    "version",
    "token",
    "switchName",
    "natName",
    "marker",
    "prefix",
    "gateway",
    "createdAt",
    "ownershipOrigin",
    "ownershipEvidence",
]);

const OWNERSHIP_EVIDENCE_KEYS = new Set(["switch", "gateway", "nat"]);
const SWITCH_OWNERSHIP_EVIDENCE_KEYS = new Set(["switchName", "switchId", "marker"]);
const GATEWAY_OWNERSHIP_EVIDENCE_KEYS = new Set(["switchName", "switchId", "marker", "prefix", "gateway"]);
const NAT_OWNERSHIP_EVIDENCE_KEYS = new Set(["natName", "natInstanceId", "marker", "prefix"]);

const ALLOCATION_KEYS = new Set([
    "ownerId",
    "deviceId",
    "incarnationId",
    "address",
    "macAddress",
    "allocatedAt",
]);

export type HyperVNetworkAllocation = {
    ownerId: string;
    deviceId: string;
    incarnationId?: string;
    address: string;
    macAddress: string;
    allocatedAt: string;
};

type HyperVNetworkStateBase = {
    version: 1;
    switchName: string;
    switchId: string;
    marker: string;
    natName: string;
    prefix: string;
    gateway: string;
    outboundPolicy: "nat";
    managedSwitch: boolean;
    managedGateway: boolean;
    allocations: HyperVNetworkAllocation[];
};

export type HyperVNetworkState = HyperVNetworkStateBase & (
    | { managedNat: true; natInstanceId: string }
    | { managedNat: false; natInstanceId?: string }
);

export type HyperVNetworkIntent = {
    version: 1;
    token: string;
    switchName: string;
    natName: string;
    marker: string;
    prefix: string;
    gateway: string;
    createdAt: string;
    ownershipOrigin?: "adopted";
    ownershipEvidence?: HyperVNetworkIntentOwnershipEvidence;
};

export type HyperVNetworkIntentOwnershipEvidence = {
    switch?: {
        switchName: string;
        switchId: string;
        marker: string;
    };
    gateway?: {
        switchName: string;
        switchId: string;
        marker: string;
        prefix: string;
        gateway: string;
    };
    nat?: {
        natName: string;
        natInstanceId: string;
        marker: string;
        prefix: string;
    };
};

export type HyperVNetworkResourceProvenance<Identity> =
    | { kind: "unmanaged" }
    | { kind: "managed"; identity: Identity };

export type HyperVNetworkManagementProvenance = {
    switch: HyperVNetworkResourceProvenance<{
        switchName: string;
        switchId: string;
    }>;
    gateway: HyperVNetworkResourceProvenance<{
        switchName: string;
        switchId: string;
        prefix: string;
        gateway: string;
    }>;
    nat: HyperVNetworkResourceProvenance<{
        natName: string;
        natInstanceId: string;
        prefix: string;
    }>;
};

export type HyperVNetworkIntentProvenance =
    | {
        kind: "legacy-stable";
        token: string;
        switchName: string;
        natName: typeof HYPER_V_NETWORK_NAT;
        marker: typeof HYPER_V_NETWORK_MARKER;
    }
    | {
        kind: "token-scoped";
        token: string;
        switchName: string;
        natName: string;
        marker: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
    return Object.keys(value).every((key) => allowed.has(key));
}

function validNatInstanceId(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value.length <= NETWORK_NAT_INSTANCE_ID_MAX_LENGTH
        && !/[\u0000-\u001f]/.test(value);
}

function validNetworkMarker(value: unknown): value is string {
    return typeof value === "string" && NETWORK_MARKER_PATTERN.test(value);
}

function decodeIntentOwnershipEvidence(value: unknown): HyperVNetworkIntentOwnershipEvidence {
    if (!isRecord(value) || !hasOnlyKeys(value, OWNERSHIP_EVIDENCE_KEYS)) {
        throw new Error("hyper-v-network-intent-invalid");
    }

    const evidence: HyperVNetworkIntentOwnershipEvidence = {};
    if (value.switch !== undefined) {
        if (!isRecord(value.switch)
            || !hasOnlyKeys(value.switch, SWITCH_OWNERSHIP_EVIDENCE_KEYS)
            || value.switch.switchName !== HYPER_V_NETWORK_SWITCH
            || typeof value.switch.switchId !== "string"
            || !NETWORK_SWITCH_ID_PATTERN.test(value.switch.switchId)
            || !validNetworkMarker(value.switch.marker)) {
            throw new Error("hyper-v-network-intent-invalid");
        }
        evidence.switch = {
            switchName: value.switch.switchName,
            switchId: value.switch.switchId.toLowerCase(),
            marker: value.switch.marker,
        };
    }
    if (value.gateway !== undefined) {
        if (!isRecord(value.gateway)
            || !hasOnlyKeys(value.gateway, GATEWAY_OWNERSHIP_EVIDENCE_KEYS)
            || value.gateway.switchName !== HYPER_V_NETWORK_SWITCH
            || typeof value.gateway.switchId !== "string"
            || !NETWORK_SWITCH_ID_PATTERN.test(value.gateway.switchId)
            || !validNetworkMarker(value.gateway.marker)
            || value.gateway.prefix !== HYPER_V_NETWORK_PREFIX
            || value.gateway.gateway !== HYPER_V_NETWORK_GATEWAY) {
            throw new Error("hyper-v-network-intent-invalid");
        }
        evidence.gateway = {
            switchName: value.gateway.switchName,
            switchId: value.gateway.switchId.toLowerCase(),
            marker: value.gateway.marker,
            prefix: value.gateway.prefix,
            gateway: value.gateway.gateway,
        };
    }
    if (value.nat !== undefined) {
        if (!isRecord(value.nat)
            || !hasOnlyKeys(value.nat, NAT_OWNERSHIP_EVIDENCE_KEYS)
            || typeof value.nat.natName !== "string"
            || !validNatInstanceId(value.nat.natInstanceId)
            || !validNetworkMarker(value.nat.marker)
            || !isHyperVCccNetworkIdentity(value.nat.marker, value.nat.natName)
            || value.nat.prefix !== HYPER_V_NETWORK_PREFIX) {
            throw new Error("hyper-v-network-intent-invalid");
        }
        evidence.nat = {
            natName: value.nat.natName,
            natInstanceId: value.nat.natInstanceId,
            marker: value.nat.marker,
            prefix: value.nat.prefix,
        };
    }
    if (!evidence.switch && !evidence.gateway && !evidence.nat) {
        throw new Error("hyper-v-network-intent-invalid");
    }
    return evidence;
}

export function hyperVDeterministicMacAddress(ownerId: string, deviceId: string, salt = 0): string {
    const digest = createHash("sha256").update(`${ownerId}\0${deviceId}\0${salt}`).digest();
    const bytes = [0x02, ...Array.from({ length: 5 }, (_, index) => digest.readUInt8(index))];
    return bytes.map((value) => value.toString(16).padStart(2, "0")).join(":");
}

function decodeAllocation(value: unknown): HyperVNetworkAllocation {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ALLOCATION_KEYS)
        || typeof value.ownerId !== "string" || !NETWORK_OWNER_ID_PATTERN.test(value.ownerId)
        || typeof value.deviceId !== "string" || !NETWORK_DEVICE_ID_PATTERN.test(value.deviceId)
        || (value.incarnationId !== undefined
            && (typeof value.incarnationId !== "string"
                || !NETWORK_INCARNATION_ID_PATTERN.test(value.incarnationId)))
        || typeof value.address !== "string" || !NETWORK_ADDRESS_PATTERN.test(value.address)
        || (value.macAddress !== undefined
            && (typeof value.macAddress !== "string" || !NETWORK_MAC_ADDRESS_PATTERN.test(value.macAddress)))
        || typeof value.allocatedAt !== "string") {
        throw new Error("hyper-v-network-allocation-invalid");
    }

    const macAddress = typeof value.macAddress === "string"
        ? value.macAddress
        : hyperVDeterministicMacAddress(value.ownerId, value.deviceId);
    return {
        ownerId: value.ownerId,
        deviceId: value.deviceId,
        ...(typeof value.incarnationId === "string" ? { incarnationId: value.incarnationId } : {}),
        address: value.address,
        macAddress,
        allocatedAt: value.allocatedAt,
    };
}

function decodeAllocations(value: unknown): HyperVNetworkAllocation[] {
    if (!Array.isArray(value)) throw new Error("hyper-v-network-state-invalid");

    const identities = new Set<string>();
    const addresses = new Set<string>();
    const macAddresses = new Set<string>();
    return value.map((candidate) => {
        const allocation = decodeAllocation(candidate);
        const identity = `${allocation.ownerId}:${allocation.deviceId}`;
        if (identities.has(identity)
            || addresses.has(allocation.address)
            || macAddresses.has(allocation.macAddress)) {
            throw new Error("hyper-v-network-allocation-conflict");
        }
        identities.add(identity);
        addresses.add(allocation.address);
        macAddresses.add(allocation.macAddress);
        return allocation;
    });
}

export function decodeHyperVNetworkState(value: unknown): HyperVNetworkState {
    if (!isRecord(value)
        || !hasOnlyKeys(value, STATE_KEYS)
        || value.version !== 1
        || value.switchName !== HYPER_V_NETWORK_SWITCH
        || typeof value.switchId !== "string" || !NETWORK_SWITCH_ID_PATTERN.test(value.switchId)
        || typeof value.natName !== "string"
        || (value.natName !== HYPER_V_NETWORK_NAT && !NETWORK_NAT_NAME_PATTERN.test(value.natName))
        || (value.marker !== undefined
            && (typeof value.marker !== "string" || !NETWORK_MARKER_PATTERN.test(value.marker)))
        || value.prefix !== HYPER_V_NETWORK_PREFIX
        || value.gateway !== HYPER_V_NETWORK_GATEWAY
        || (value.outboundPolicy !== undefined && value.outboundPolicy !== "nat")
        || (value.managedSwitch !== undefined && typeof value.managedSwitch !== "boolean")
        || (value.managedGateway !== undefined && typeof value.managedGateway !== "boolean")
        || (value.managedNat !== undefined && typeof value.managedNat !== "boolean")
        || (value.natInstanceId !== undefined && !validNatInstanceId(value.natInstanceId))) {
        throw new Error("hyper-v-network-state-invalid");
    }

    const marker = typeof value.marker === "string" ? value.marker : HYPER_V_NETWORK_MARKER;
    if (!isHyperVCccNetworkIdentity(marker, value.natName)) {
        throw new Error("hyper-v-network-state-invalid");
    }

    const allocations = decodeAllocations(value.allocations);
    const managedNat = value.managedNat === true;
    if (managedNat && !validNatInstanceId(value.natInstanceId)) {
        throw new Error("hyper-v-network-state-invalid");
    }

    const managedSwitch = value.managedSwitch === undefined ? managedNat : value.managedSwitch;
    const managedGateway = value.managedGateway === undefined ? managedNat : value.managedGateway;
    if (managedNat) {
        const natInstanceId = value.natInstanceId;
        if (!validNatInstanceId(natInstanceId)) throw new Error("hyper-v-network-state-invalid");
        return {
            version: 1,
            switchName: value.switchName,
            switchId: value.switchId,
            marker,
            natName: value.natName,
            natInstanceId,
            prefix: HYPER_V_NETWORK_PREFIX,
            gateway: HYPER_V_NETWORK_GATEWAY,
            outboundPolicy: "nat",
            managedSwitch,
            managedGateway,
            managedNat: true,
            allocations,
        };
    }
    return {
        version: 1,
        switchName: value.switchName,
        switchId: value.switchId,
        marker,
        natName: value.natName,
        ...(typeof value.natInstanceId === "string" ? { natInstanceId: value.natInstanceId } : {}),
        prefix: HYPER_V_NETWORK_PREFIX,
        gateway: HYPER_V_NETWORK_GATEWAY,
        outboundPolicy: "nat",
        managedSwitch,
        managedGateway,
        managedNat: false,
        allocations,
    };
}

export function encodeHyperVNetworkState(state: HyperVNetworkState): HyperVNetworkState {
    return decodeHyperVNetworkState({
        version: state.version,
        switchName: state.switchName,
        switchId: state.switchId,
        marker: state.marker,
        natName: state.natName,
        ...(state.natInstanceId === undefined ? {} : { natInstanceId: state.natInstanceId }),
        prefix: state.prefix,
        gateway: state.gateway,
        outboundPolicy: state.outboundPolicy,
        managedSwitch: state.managedSwitch,
        managedGateway: state.managedGateway,
        managedNat: state.managedNat,
        allocations: state.allocations.map((allocation) => ({
            ownerId: allocation.ownerId,
            deviceId: allocation.deviceId,
            ...(allocation.incarnationId === undefined ? {} : { incarnationId: allocation.incarnationId }),
            address: allocation.address,
            macAddress: allocation.macAddress,
            allocatedAt: allocation.allocatedAt,
        })),
    });
}

export function hyperVNetworkManagementProvenance(
    state: HyperVNetworkState,
): HyperVNetworkManagementProvenance {
    return {
        switch: state.managedSwitch
            ? { kind: "managed", identity: { switchName: state.switchName, switchId: state.switchId } }
            : { kind: "unmanaged" },
        gateway: state.managedGateway
            ? {
                kind: "managed",
                identity: {
                    switchName: state.switchName,
                    switchId: state.switchId,
                    prefix: state.prefix,
                    gateway: state.gateway,
                },
            }
            : { kind: "unmanaged" },
        nat: state.managedNat
            ? {
                kind: "managed",
                identity: {
                    natName: state.natName,
                    natInstanceId: state.natInstanceId,
                    prefix: state.prefix,
                },
            }
            : { kind: "unmanaged" },
    };
}

export function decodeHyperVNetworkIntent(value: unknown): HyperVNetworkIntent {
    if (!isRecord(value)
        || !hasOnlyKeys(value, INTENT_KEYS)
        || value.version !== 1
        || typeof value.token !== "string" || !NETWORK_TOKEN_PATTERN.test(value.token)
        || value.switchName !== HYPER_V_NETWORK_SWITCH
        || typeof value.natName !== "string"
        || typeof value.marker !== "string"
        || !isHyperVCccNetworkIdentity(value.marker, value.natName)
        || value.prefix !== HYPER_V_NETWORK_PREFIX
        || value.gateway !== HYPER_V_NETWORK_GATEWAY
        || typeof value.createdAt !== "string"
        || (value.ownershipOrigin !== undefined && value.ownershipOrigin !== "adopted")
        || (value.ownershipEvidence !== undefined && !isRecord(value.ownershipEvidence))) {
        throw new Error("hyper-v-network-intent-invalid");
    }

    if (value.marker !== HYPER_V_NETWORK_MARKER
        && (value.natName !== `${HYPER_V_NETWORK_NAT}-${value.token}`
            || value.marker !== `ccc-device-lab:hyper-v-network:${value.token}`)) {
        throw new Error("hyper-v-network-intent-invalid");
    }

    const ownershipEvidence = value.ownershipEvidence === undefined
        ? undefined
        : decodeIntentOwnershipEvidence(value.ownershipEvidence);
    const receiptSwitch = ownershipEvidence?.switch;
    const receiptGateway = ownershipEvidence?.gateway;
    const receiptNat = ownershipEvidence?.nat;
    if ((receiptSwitch && receiptSwitch.marker !== value.marker)
        || (receiptGateway
            && (receiptGateway.marker !== value.marker
                || receiptGateway.prefix !== value.prefix
                || receiptGateway.gateway !== value.gateway))
        || (receiptNat
            && (receiptNat.marker !== value.marker
                || receiptNat.natName !== value.natName
                || receiptNat.prefix !== value.prefix))
        || (receiptSwitch && receiptGateway
            && (receiptSwitch.switchName !== receiptGateway.switchName
                || receiptSwitch.switchId !== receiptGateway.switchId))) {
        throw new Error("hyper-v-network-intent-invalid");
    }
    return {
        version: 1,
        token: value.token,
        switchName: value.switchName,
        natName: value.natName,
        marker: value.marker,
        prefix: value.prefix,
        gateway: value.gateway,
        createdAt: value.createdAt,
        ...(value.ownershipOrigin === "adopted" ? { ownershipOrigin: value.ownershipOrigin } : {}),
        ...(ownershipEvidence ? { ownershipEvidence } : {}),
    };
}

export function encodeHyperVNetworkIntent(intent: HyperVNetworkIntent): HyperVNetworkIntent {
    return decodeHyperVNetworkIntent({
        version: intent.version,
        token: intent.token,
        switchName: intent.switchName,
        natName: intent.natName,
        marker: intent.marker,
        prefix: intent.prefix,
        gateway: intent.gateway,
        createdAt: intent.createdAt,
        ...(intent.ownershipOrigin === undefined ? {} : { ownershipOrigin: intent.ownershipOrigin }),
        ...(intent.ownershipEvidence === undefined ? {} : { ownershipEvidence: intent.ownershipEvidence }),
    });
}

export function createFreshHyperVNetworkIntent(token: string, createdAt: string): HyperVNetworkIntent {
    if (!NETWORK_TOKEN_PATTERN.test(token) || typeof createdAt !== "string") {
        throw new Error("hyper-v-network-intent-invalid");
    }
    return {
        version: 1,
        token,
        switchName: HYPER_V_NETWORK_SWITCH,
        natName: `${HYPER_V_NETWORK_NAT}-${token}`,
        marker: `ccc-device-lab:hyper-v-network:${token}`,
        prefix: HYPER_V_NETWORK_PREFIX,
        gateway: HYPER_V_NETWORK_GATEWAY,
        createdAt,
    };
}

export function hyperVNetworkIntentProvenance(intent: HyperVNetworkIntent): HyperVNetworkIntentProvenance {
    if (intent.marker === HYPER_V_NETWORK_MARKER) {
        return {
            kind: "legacy-stable",
            token: intent.token,
            switchName: intent.switchName,
            natName: HYPER_V_NETWORK_NAT,
            marker: HYPER_V_NETWORK_MARKER,
        };
    }
    return {
        kind: "token-scoped",
        token: intent.token,
        switchName: intent.switchName,
        natName: intent.natName,
        marker: intent.marker,
    };
}
