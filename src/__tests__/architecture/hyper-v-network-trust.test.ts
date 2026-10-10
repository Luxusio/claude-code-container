import { describe, expect, it } from "vitest";
import { createHyperVNetworkTrust } from "../../../packages/device-lab/src/device-lab/application/hyper-v-network-trust.js";
import type { HyperVNetworkState } from "../../../packages/device-lab/src/device-lab/domain/hyper-v-network-trust.js";
import type { HyperVNetworkStatePorts } from "../../../packages/device-lab/src/device-lab/ports/hyper-v-network-trust.js";

const OWNER = "0123456789abcdef";
const INCARNATION = "a".repeat(32);
const ADDRESS = "172.29.0.20";
const KEY = "QUJDRA==";
const FINGERPRINT = "SHA256:authenticated-key";

function fixture() {
    let state: HyperVNetworkState = {
        version: 1, switchName: "CCC Device Lab", switchId: "11111111-2222-3333-4444-555555555555",
        marker: "ccc-device-lab:hyper-v-network:v1", natName: "CCCDeviceLab", natInstanceId: "nat-instance",
        prefix: "172.29.0.0/24", gateway: "172.29.0.1", outboundPolicy: "nat",
        managedSwitch: true, managedGateway: true, managedNat: true,
        allocations: [{ ownerId: OWNER, deviceId: "guest", incarnationId: INCARNATION,
            address: ADDRESS, macAddress: "02:11:22:33:44:55", allocatedAt: "2026-10-11T00:00:00.000Z" }],
    };
    const files = new Map<string, string>();
    const ports: HyperVNetworkStatePorts = {
        kind: "state", readState: () => state, readIntent: () => null,
        writeState: (next) => { state = next; return undefined; },
        writeIntent: () => { throw new Error("unexpected-intent-publication"); },
        removeState: () => { throw new Error("unexpected-state-removal"); },
        removeIntent: () => { throw new Error("unexpected-intent-removal"); },
        ensureStateRoot: () => undefined, assertStateRoot: () => undefined,
        revision: (value) => JSON.stringify(value), boundedError: (_error, fallback) => fallback,
        assertTrustPath: () => undefined, readTrustText: (path) => files.get(path) ?? null,
        writeTrustText: (path, text) => { files.set(path, text); return undefined; },
        ed25519Identity: (encodedKey) => encodedKey === KEY
            ? { encodedKey, publicKey: `ssh-ed25519 ${KEY} ccc-hyper-v-guest`, fingerprint: FINGERPRINT } : null,
    };
    return { app: createHyperVNetworkTrust(ports), state: () => state, files };
}

describe("Hyper-V network allocation and guest trust policy", () => {
    it("retains the final managed allocation until destructive cleanup confirms it", () => {
        const f = fixture();
        const before = structuredClone(f.state());
        expect(f.app.release(OWNER, "guest", INCARNATION)).toMatchObject({ ok: true, released: true, remaining: 0 });
        expect(f.state()).toEqual(before);
    });

    it("commits an exact final release while preserving managed fabric on request", () => {
        const f = fixture();
        expect(f.app.release(OWNER, "guest", INCARNATION, { preserveManagedFabric: true })).toMatchObject({
            ok: true, released: true, remaining: 0, preservedManagedFabric: true,
        });
        expect(f.state()).toMatchObject({ managedSwitch: true, managedGateway: true, managedNat: true, allocations: [] });
    });

    it("refuses stale incarnation release without overwriting the allocation", () => {
        const f = fixture();
        const before = structuredClone(f.state());
        expect(f.app.release(OWNER, "guest", "b".repeat(32))).toMatchObject({
            ok: false, released: false, error: "hyper-v-network-allocation-incarnation-conflict",
        });
        expect(f.state()).toEqual(before);
    });

    it("does not release another owner's allocation with the same device name", () => {
        const f = fixture();
        const before = structuredClone(f.state());
        expect(f.app.release("fedcba9876543210", "guest", INCARNATION)).toMatchObject({ ok: true, released: false, remaining: 1 });
        expect(f.state()).toEqual(before);
    });

    it("refuses trust recovery for an address outside the committed allocation", () => {
        const f = fixture();
        f.files.set("known_hosts", `172.29.0.99 ssh-ed25519 ${KEY}\n`);
        f.files.set("host.pub", "unchanged\n");
        expect(f.app.reconcileGuestTrust(OWNER, "guest", "host.pub", "known_hosts", "172.29.0.99",
            () => { throw new Error("unallocated-fingerprint-must-not-publish"); })).toBeNull();
        expect(f.files.get("host.pub")).toBe("unchanged\n");
    });

    it("keeps durable trust after refused publication and recovers its fingerprint on retry", () => {
        const f = fixture();
        const durable = `${ADDRESS} ssh-ed25519 ${KEY} authenticated-guest\n`;
        f.files.set("known_hosts", durable);
        f.files.set("host.pub", "stale\n");
        expect(f.app.reconcileGuestTrust(OWNER, "guest", "host.pub", "known_hosts", ADDRESS, () => false)).toBeNull();
        expect(f.files.get("known_hosts")).toBe(durable);
        expect(f.files.get("host.pub")).toBe(`ssh-ed25519 ${KEY} ccc-hyper-v-guest\n`);
        let published = "";
        expect(f.app.reconcileGuestTrust(OWNER, "guest", "host.pub", "known_hosts", ADDRESS,
            (value) => { published = value; return true; })).toEqual({ fingerprint: FINGERPRINT });
        expect(published).toBe(FINGERPRINT);
        expect(f.app.validateGuestTrust(OWNER, "guest", "host.pub", "known_hosts", ADDRESS, published)).toBe(true);
    });
});
