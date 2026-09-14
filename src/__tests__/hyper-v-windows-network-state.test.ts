import { describe, expect, it } from "vitest";
import {
    createFreshHyperVNetworkIntent,
    decodeHyperVNetworkIntent,
    decodeHyperVNetworkState,
    encodeHyperVNetworkIntent,
    encodeHyperVNetworkState,
    hyperVDeterministicMacAddress,
    hyperVNetworkIntentProvenance,
    hyperVNetworkManagementProvenance,
} from "../device-lab/broker/hyper-v/network-state.js";

const TOKEN = "0123456789abcdef01234567";
const SWITCH_ID = "11111111-2222-3333-4444-555555555555";
const NAT_INSTANCE_ID = "ccc-network-instance-1";
const OWNER_ID = "0123456789abcdef";

function completeState() {
    return {
        version: 1,
        switchName: "CCC Device Lab",
        switchId: SWITCH_ID,
        marker: `ccc-device-lab:hyper-v-network:${TOKEN}`,
        natName: `CCCDeviceLab-${TOKEN}`,
        natInstanceId: NAT_INSTANCE_ID,
        prefix: "172.29.0.0/24",
        gateway: "172.29.0.1",
        outboundPolicy: "nat",
        managedSwitch: true,
        managedGateway: true,
        managedNat: true,
        allocations: [{
            ownerId: OWNER_ID,
            deviceId: "network-test",
            incarnationId: "a".repeat(32),
            address: "172.29.0.10",
            macAddress: "02:11:22:33:44:55",
            allocatedAt: "2026-09-14T00:00:00.000Z",
        }],
    };
}

describe("Hyper-V network v1 state codec", () => {
    it("round-trips the complete v1 shape without changing its JSON bytes", () => {
        const input = completeState();
        const encoded = encodeHyperVNetworkState(decodeHyperVNetworkState(input));

        expect(encoded).toEqual(input);
        expect(JSON.stringify(encoded)).toBe(JSON.stringify(input));
    });

    it("preserves legacy defaults for marker, policy, management, and MAC", () => {
        const state = decodeHyperVNetworkState({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: SWITCH_ID,
            natName: "CCCDeviceLab",
            natInstanceId: NAT_INSTANCE_ID,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            managedNat: true,
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "legacy-device",
                address: "172.29.0.11",
                allocatedAt: "legacy-timestamp",
            }],
        });

        expect(state).toEqual({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: SWITCH_ID,
            marker: "ccc-device-lab:hyper-v-network:v1",
            natName: "CCCDeviceLab",
            natInstanceId: NAT_INSTANCE_ID,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            outboundPolicy: "nat",
            managedSwitch: true,
            managedGateway: true,
            managedNat: true,
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "legacy-device",
                address: "172.29.0.11",
                macAddress: hyperVDeterministicMacAddress(OWNER_ID, "legacy-device"),
                allocatedAt: "legacy-timestamp",
            }],
        });
    });

    it("rejects malformed, extra-field, and impossible managed provenance states", () => {
        expect(() => decodeHyperVNetworkState(null)).toThrow("hyper-v-network-state-invalid");
        expect(() => decodeHyperVNetworkState({ ...completeState(), futureField: true }))
            .toThrow("hyper-v-network-state-invalid");
        expect(() => decodeHyperVNetworkState({ ...completeState(), natInstanceId: undefined }))
            .toThrow("hyper-v-network-state-invalid");
        expect(() => decodeHyperVNetworkState({
            ...completeState(),
            marker: undefined,
        })).toThrow("hyper-v-network-state-invalid");
    });

    it("rejects duplicate allocation identity, address, or effective MAC", () => {
        const allocation = completeState().allocations[0];
        expect(() => decodeHyperVNetworkState({
            ...completeState(),
            allocations: [allocation, { ...allocation, address: "172.29.0.12" }],
        })).toThrow("hyper-v-network-allocation-conflict");
        expect(() => decodeHyperVNetworkState({
            ...completeState(),
            allocations: [allocation, { ...allocation, deviceId: "second" }],
        })).toThrow("hyper-v-network-allocation-conflict");
        const derivedMac = hyperVDeterministicMacAddress(OWNER_ID, "derived-mac");
        expect(() => decodeHyperVNetworkState({
            ...completeState(),
            allocations: [
                { ...allocation, deviceId: "derived-mac", macAddress: undefined },
                { ...allocation, deviceId: "second", address: "172.29.0.12", macAddress: derivedMac },
            ],
        })).toThrow("hyper-v-network-allocation-conflict");
    });

    it("projects management booleans into identity-carrying closed unions", () => {
        const state = decodeHyperVNetworkState(completeState());

        expect(hyperVNetworkManagementProvenance(state)).toEqual({
            switch: {
                kind: "managed",
                identity: { switchName: "CCC Device Lab", switchId: SWITCH_ID },
            },
            gateway: {
                kind: "managed",
                identity: {
                    switchName: "CCC Device Lab",
                    switchId: SWITCH_ID,
                    prefix: "172.29.0.0/24",
                    gateway: "172.29.0.1",
                },
            },
            nat: {
                kind: "managed",
                identity: {
                    natName: `CCCDeviceLab-${TOKEN}`,
                    natInstanceId: NAT_INSTANCE_ID,
                    prefix: "172.29.0.0/24",
                },
            },
        });
    });
});

describe("Hyper-V network v1 intent codec", () => {
    it("creates and round-trips a token-scoped fresh intent", () => {
        const intent = createFreshHyperVNetworkIntent(TOKEN, "2026-09-14T00:00:00.000Z");

        expect(intent).toEqual({
            version: 1,
            token: TOKEN,
            switchName: "CCC Device Lab",
            natName: `CCCDeviceLab-${TOKEN}`,
            marker: `ccc-device-lab:hyper-v-network:${TOKEN}`,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            createdAt: "2026-09-14T00:00:00.000Z",
        });
        expect(encodeHyperVNetworkIntent(decodeHyperVNetworkIntent(intent))).toEqual(intent);
        expect(hyperVNetworkIntentProvenance(intent)).toMatchObject({ kind: "token-scoped", token: TOKEN });
    });

    it("round-trips durable adopted ownership provenance and rejects unknown modes", () => {
        const adopted = {
            ...createFreshHyperVNetworkIntent(TOKEN, "2026-09-14T00:00:00.000Z"),
            ownershipOrigin: "adopted" as const,
        };

        expect(encodeHyperVNetworkIntent(decodeHyperVNetworkIntent(adopted))).toEqual(adopted);
        expect(() => decodeHyperVNetworkIntent({ ...adopted, ownershipOrigin: "fresh" }))
            .toThrow("hyper-v-network-intent-invalid");
    });

    it("conservatively accepts the stable legacy v1 intent", () => {
        const intent = decodeHyperVNetworkIntent({
            version: 1,
            token: TOKEN,
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            createdAt: "legacy-timestamp",
        });

        expect(hyperVNetworkIntentProvenance(intent)).toEqual({
            kind: "legacy-stable",
            token: TOKEN,
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
        });
    });

    it("rejects invalid tokens, token mismatches, and extra intent fields", () => {
        expect(() => createFreshHyperVNetworkIntent("not-a-token", "now"))
            .toThrow("hyper-v-network-intent-invalid");
        expect(() => decodeHyperVNetworkIntent({
            ...createFreshHyperVNetworkIntent(TOKEN, "now"),
            natName: "CCCDeviceLab-aaaaaaaaaaaaaaaaaaaaaaaa",
        })).toThrow("hyper-v-network-intent-invalid");
        expect(() => decodeHyperVNetworkIntent({
            ...createFreshHyperVNetworkIntent(TOKEN, "now"),
            futureField: true,
        })).toThrow("hyper-v-network-intent-invalid");
    });

    it("rejects ownership receipts that contradict their intent or each other", () => {
        const intent = createFreshHyperVNetworkIntent(TOKEN, "now");
        const marker = `ccc-device-lab:hyper-v-network:${TOKEN}`;
        const ownershipEvidence = {
            switch: { switchName: "CCC Device Lab", switchId: SWITCH_ID, marker },
            gateway: {
                switchName: "CCC Device Lab",
                switchId: "99999999-8888-7777-6666-555555555555",
                marker,
                prefix: "172.29.0.0/24",
                gateway: "172.29.0.1",
            },
        };

        expect(() => decodeHyperVNetworkIntent({ ...intent, ownershipEvidence }))
            .toThrow("hyper-v-network-intent-invalid");
        expect(() => decodeHyperVNetworkIntent({
            ...intent,
            ownershipEvidence: {
                switch: { switchName: "CCC Device Lab", switchId: SWITCH_ID, marker: "ccc-device-lab:hyper-v-network:v1" },
            },
        })).toThrow("hyper-v-network-intent-invalid");
        expect(() => decodeHyperVNetworkIntent({
            ...intent,
            ownershipEvidence: {
                nat: {
                    natName: "CCCDeviceLab",
                    natInstanceId: NAT_INSTANCE_ID,
                    marker: "ccc-device-lab:hyper-v-network:v1",
                    prefix: "172.29.0.0/24",
                },
            },
        })).toThrow("hyper-v-network-intent-invalid");
    });
});
