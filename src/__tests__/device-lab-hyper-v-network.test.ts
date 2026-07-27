import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ensureHyperVNetworkAllocation,
    hyperVDeterministicMacAddress,
    hyperVDeterministicNetworkAddresses,
    releaseHyperVNetworkAllocationAndCleanup,
    validateHyperVLinuxSshHostIdentity,
    type HyperVNetworkCommandResult,
    type HyperVNetworkRuntime,
} from "../device-lab/broker/hyper-v/network.js";

const OWNER_ID = "0123456789abcdef";
const DEVICE_ID = "network-test";
const INCARNATION_ID = "a".repeat(32);
const SWITCH_ID = "11111111-2222-3333-4444-555555555555";
const NAT_INSTANCE_ID = "ccc-network-instance-1";

const roots: string[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ccc-hyper-v-network-"));
    roots.push(root);
    return root;
}

function networkIdentity(root: string) {
    const statePath = join(root, "network", "hyper-v.json");
    const intentPath = join(root, "network", "hyper-v-intent.json");
    const source = existsSync(statePath) ? statePath : intentPath;
    return JSON.parse(readFileSync(source, "utf8")) as { switchName: string; natName: string; marker: string };
}

function setupObservation(root: string): HyperVNetworkCommandResult {
    const identity = networkIdentity(root);
    return {
        mode: "exec",
        provider: "hyper-v",
        status: 0,
        stdout: JSON.stringify({
            ok: true,
            ...identity,
            switchId: SWITCH_ID,
            natInstanceId: NAT_INSTANCE_ID,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            interfaceIndex: 42,
            createdSwitch: true,
            createdNat: true,
        }),
    };
}

function runtime(root: string, run?: HyperVNetworkRuntime["run"]): HyperVNetworkRuntime {
    return {
        privateRoot: root,
        assertSafePath: () => undefined,
        resolveExecutable: (name) => name === "powershell.exe" ? "powershell.exe" : null,
        resolveElevationExecutable: () => "elevated-powershell.exe",
        run: run || (async () => setupObservation(root)),
        commandOutputBytes: 64 * 1024,
    };
}

describe("Hyper-V network module", () => {
    it("derives stable locally administered MAC and complete address candidates", () => {
        const addresses = hyperVDeterministicNetworkAddresses(OWNER_ID, DEVICE_ID);

        expect(hyperVDeterministicMacAddress(OWNER_ID, DEVICE_ID)).toMatch(/^02(?::[a-f0-9]{2}){5}$/);
        expect(hyperVDeterministicMacAddress(OWNER_ID, DEVICE_ID))
            .toBe(hyperVDeterministicMacAddress(OWNER_ID, DEVICE_ID));
        expect(addresses).toHaveLength(241);
        expect(new Set(addresses)).toHaveLength(241);
        expect(addresses.every((address) => /^172\.29\.0\.(?:1\d|[2-9]\d|1\d\d|2[0-4]\d|250)$/.test(address))).toBe(true);
    });

    it("commits an allocation and returns the same allocation on retry", async () => {
        const root = privateRoot();
        const run = vi.fn(async () => setupObservation(root));
        const network = runtime(root, run);

        const first = await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);
        const second = await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);
        const state = JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8"));

        expect(first).toEqual(second);
        expect(first.ok).toBe(true);
        expect(state.allocations).toHaveLength(1);
        expect(state.allocations[0]).toMatchObject({
            ownerId: OWNER_ID,
            deviceId: DEVICE_ID,
            incarnationId: INCARNATION_ID,
        });
        expect(existsSync(join(root, "network", "hyper-v-intent.json"))).toBe(false);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it("retries setup with the injected elevated executable after access denial", async () => {
        const root = privateRoot();
        const resolveElevationExecutable = vi.fn(() => "elevated-powershell.exe");
        const run = vi.fn()
            .mockResolvedValueOnce({
                mode: "exec",
                provider: "hyper-v",
                status: 1,
                stderr: "PermissionDenied: Windows System Error 5",
            })
            .mockImplementationOnce(async () => setupObservation(root));
        const network = { ...runtime(root, run), resolveElevationExecutable };

        const result = await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);

        expect(result.ok).toBe(true);
        expect(run).toHaveBeenCalledTimes(2);
        expect(resolveElevationExecutable).toHaveBeenCalledWith("powershell.exe");
        expect(run.mock.calls[1][0].executable).toBe("elevated-powershell.exe");
    });

    it("fences stale incarnations and removes owned NAT state after the final release", async () => {
        const root = privateRoot();
        const run = vi.fn(async () => setupObservation(root));
        const network = runtime(root, run);
        await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);

        const stale = await releaseHyperVNetworkAllocationAndCleanup(
            network,
            OWNER_ID,
            DEVICE_ID,
            "b".repeat(32),
        );
        expect(stale).toMatchObject({
            ok: false,
            error: "hyper-v-network-allocation-incarnation-conflict",
        });
        expect(existsSync(join(root, "network", "hyper-v.json"))).toBe(true);

        run.mockResolvedValueOnce({
            mode: "exec",
            provider: "hyper-v",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                removedSwitch: true,
                removedNat: true,
                removedGateway: true,
                alreadyMissing: false,
            }),
        });
        const released = await releaseHyperVNetworkAllocationAndCleanup(
            network,
            OWNER_ID,
            DEVICE_ID,
            INCARNATION_ID,
        );

        expect(released).toMatchObject({
            ok: true,
            released: true,
            remaining: 0,
            networkCleanup: { removedSwitch: true, removedNat: true },
        });
        expect(existsSync(join(root, "network", "hyper-v.json"))).toBe(false);
    });

    it("binds Linux SSH host identity to the committed allocation", async () => {
        const root = privateRoot();
        const network = runtime(root);
        const allocation = await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);
        expect(allocation.ok).toBe(true);
        if (!allocation.ok) return;

        const keyBytes = Buffer.from("ccc-hyper-v-host-key");
        const publicKey = `ssh-ed25519 ${keyBytes.toString("base64")} ccc`;
        const fingerprint = `SHA256:${createHash("sha256").update(keyBytes).digest("base64").replace(/=+$/, "")}`;
        const publicKeyPath = join(root, "host.pub");
        const knownHostsPath = join(root, "known_hosts");
        writeFileSync(publicKeyPath, `${publicKey}\n`);
        writeFileSync(knownHostsPath, `${allocation.address} ${publicKey}\n`);

        expect(validateHyperVLinuxSshHostIdentity(
            network,
            OWNER_ID,
            DEVICE_ID,
            publicKeyPath,
            knownHostsPath,
            allocation.address,
            fingerprint,
        )).toBe(true);
        expect(validateHyperVLinuxSshHostIdentity(
            network,
            OWNER_ID,
            DEVICE_ID,
            publicKeyPath,
            knownHostsPath,
            "172.29.0.250",
            fingerprint,
        )).toBe(false);
    });

    it("does not import the broker facade", () => {
        const source = readFileSync(
            new URL("../device-lab/broker/hyper-v/network.ts", import.meta.url),
            "utf8",
        );

        expect(source).not.toContain("device-lab-broker");
    });
});
