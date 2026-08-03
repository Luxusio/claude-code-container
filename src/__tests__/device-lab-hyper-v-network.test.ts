import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ensureHyperVNetworkAllocation,
    hyperVDeterministicMacAddress,
    hyperVDeterministicNetworkAddresses,
    hyperVNetworkAllocationReferenced,
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
            createdGateway: true,
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

function allocationInspection(
    present: boolean,
    deviceId = "existing-device",
    incarnationId = "b".repeat(32),
): HyperVNetworkCommandResult {
    return {
        mode: "exec",
        provider: "hyper-v",
        status: 0,
        stdout: JSON.stringify({
            ok: true,
            allocations: [{
                ownerId: OWNER_ID,
                deviceId,
                incarnationId,
                vmName: `ccc-${OWNER_ID}-${deviceId}-${incarnationId}`,
                present,
                ...(present ? { vmId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } : {}),
            }],
        }),
    };
}

function writeTokenIntent(root: string, token: string): void {
    const networkRoot = join(root, "network");
    mkdirSync(networkRoot, { recursive: true });
    writeFileSync(join(networkRoot, "hyper-v-intent.json"), JSON.stringify({
        version: 1,
        token,
        switchName: "CCC Device Lab",
        natName: `CCCDeviceLab-${token}`,
        marker: `ccc-device-lab:hyper-v-network:${token}`,
        prefix: "172.29.0.0/24",
        gateway: "172.29.0.1",
        createdAt: new Date().toISOString(),
    }));
}

function writeNetworkState(
    root: string,
    overrides: Record<string, unknown> = {},
): void {
    const networkRoot = join(root, "network");
    mkdirSync(networkRoot, { recursive: true });
    writeFileSync(join(networkRoot, "hyper-v.json"), JSON.stringify({
        version: 1,
        switchName: "CCC Device Lab",
        switchId: SWITCH_ID,
        marker: "ccc-device-lab:hyper-v-network:v1",
        natName: "CCCDeviceLab",
        natInstanceId: NAT_INSTANCE_ID,
        prefix: "172.29.0.0/24",
        gateway: "172.29.0.1",
        outboundPolicy: "nat",
        managedSwitch: false,
        managedGateway: false,
        managedNat: false,
        allocations: [],
        ...overrides,
    }));
}

function scriptOf(command: { args: string[]; input?: string }): string {
    const encoded = command.args.at(-1);
    if (!encoded) throw new Error("missing encoded PowerShell script");
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    if (!decoded.includes("$E=[Console]::In.ReadToEnd().Trim()")) return decoded;
    if (!command.input) throw new Error("missing streamed PowerShell program");
    return Buffer.from(command.input, "base64").toString("utf8");
}

describe("Hyper-V network module", () => {
    it("checks exact owner-state incarnation across both Hyper-V backends", () => {
        const allocation = {
            ownerId: OWNER_ID,
            deviceId: DEVICE_ID,
            incarnationId: INCARNATION_ID,
            address: "172.29.0.10",
            macAddress: "02:11:22:33:44:55",
            allocatedAt: new Date().toISOString(),
        };

        expect(hyperVNetworkAllocationReferenced(allocation, (_ownerId, backend) => backend === "linux-vm"
            ? [{ id: DEVICE_ID, incarnationId: INCARNATION_ID }]
            : [])).toBe(true);
        expect(hyperVNetworkAllocationReferenced(allocation, () => [{ id: DEVICE_ID, incarnationId: "b".repeat(32) }]))
            .toBe(false);
        expect(() => hyperVNetworkAllocationReferenced(allocation, () => [{ id: DEVICE_ID }]))
            .toThrow("hyper-v-network-owner-state-incarnation-unverifiable");
        expect(() => hyperVNetworkAllocationReferenced(allocation, (_ownerId, backend) => [{
            id: DEVICE_ID,
            incarnationId: backend === "windows-vm" ? INCARNATION_ID : "b".repeat(32),
        }])).toThrow("hyper-v-network-owner-state-incarnation-conflict");
    });

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
        expect(state).toMatchObject({
            marker: "ccc-device-lab:hyper-v-network:v1",
            natName: "CCCDeviceLab",
            managedNat: true,
        });
        expect(existsSync(join(root, "network", "hyper-v-intent.json"))).toBe(false);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it("reuses a setup-managed stable CCC network without claiming cleanup ownership", async () => {
        const root = privateRoot();
        const run = vi.fn(async () => {
            const observation = setupObservation(root);
            const parsed = JSON.parse(observation.stdout || "{}");
            return {
                ...observation,
                stdout: JSON.stringify({ ...parsed, createdSwitch: false, createdGateway: false, createdNat: false }),
            };
        });
        const network = runtime(root, run);

        expect((await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID)).ok).toBe(true);
        const state = JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8"));
        expect(state).toMatchObject({
            marker: "ccc-device-lab:hyper-v-network:v1",
            natName: "CCCDeviceLab",
            switchId: SWITCH_ID.toLowerCase(),
            natInstanceId: NAT_INSTANCE_ID,
            managedNat: false,
        });

        const released = await releaseHyperVNetworkAllocationAndCleanup(
            network,
            OWNER_ID,
            DEVICE_ID,
            INCARNATION_ID,
        );
        expect(released).toMatchObject({
            ok: true,
            remaining: 0,
            managedSwitch: false,
            managedGateway: false,
            managedNat: false,
            networkCleanup: { skipped: true, reason: "hyper-v-network-ownership-unproven" },
        });
        expect(run).toHaveBeenCalledTimes(1);
        expect(existsSync(join(root, "network", "hyper-v.json"))).toBe(true);
    });

    it("rejects a stable-name NAT when neither state nor an owned switch proves its identity", async () => {
        const root = privateRoot();
        const run = vi.fn(async (command) => {
            const script = scriptOf(command);
            expect(script).toContain("$AllowExistingNat = $false");
            expect(script).toContain("$ExistingSwitchOwned = $false");
            expect(script).toContain("-not ($AllowExistingNat -or $ExistingSwitchOwned)");
            return {
                mode: "exec" as const,
                provider: "hyper-v",
                status: 1,
                stderr: "hyper-v-network-nat-ownership-conflict",
            };
        });

        const result = await ensureHyperVNetworkAllocation(runtime(root, run), OWNER_ID, DEVICE_ID, INCARNATION_ID);

        expect(result).toMatchObject({
            ok: false,
            status: 502,
            error: "hyper-v-network-setup-failed",
            detail: "hyper-v-network-nat-ownership-conflict",
        });
        expect(existsSync(join(root, "network", "hyper-v.json"))).toBe(false);
    });

    it("adopts only a marker-derived orphaned CCC token network when broker state is missing", async () => {
        const root = privateRoot();
        const token = "b".repeat(24);
        const run = vi.fn(async () => ({
            mode: "exec",
            provider: "hyper-v",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                switchName: "CCC Device Lab",
                switchId: SWITCH_ID,
                marker: `ccc-device-lab:hyper-v-network:${token}`,
                natName: `CCCDeviceLab-${token}`,
                natInstanceId: NAT_INSTANCE_ID,
                prefix: "172.29.0.0/24",
                gateway: "172.29.0.1",
                interfaceIndex: 42,
                createdSwitch: false,
                createdGateway: false,
                createdNat: false,
            }),
        }));

        const result = await ensureHyperVNetworkAllocation(runtime(root, run), OWNER_ID, DEVICE_ID, INCARNATION_ID);
        const state = JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8"));

        expect(result.ok).toBe(true);
        expect(state).toMatchObject({
            marker: `ccc-device-lab:hyper-v-network:${token}`,
            natName: `CCCDeviceLab-${token}`,
            managedNat: true,
        });
    });

    it("reconciles empty stale token state to the observed stable CCC network", async () => {
        const root = privateRoot();
        const token = "b".repeat(24);
        const observedSwitchId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        writeNetworkState(root, {
            switchId: "99999999-8888-7777-6666-555555555555",
            marker: `ccc-device-lab:hyper-v-network:${token}`,
            natName: `CCCDeviceLab-${token}`,
            natInstanceId: "stale-nat-instance",
            managedSwitch: true,
            managedGateway: true,
            managedNat: true,
        });
        const run = vi.fn(async (command) => {
            const script = scriptOf(command);
            expect(script).toContain("$AllowCccOwnedNetworkAdoption = $true");
            expect(script).toContain("$ExpectedSwitchId = ''");
            expect(script).toContain("$ExpectedNatInstanceId = ''");
            return {
                mode: "exec" as const,
                provider: "hyper-v",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    switchName: "CCC Device Lab",
                    switchId: observedSwitchId,
                    marker: "ccc-device-lab:hyper-v-network:v1",
                    natName: "CCCDeviceLab",
                    natInstanceId: "stable-nat-instance",
                    prefix: "172.29.0.0/24",
                    gateway: "172.29.0.1",
                    interfaceIndex: 42,
                    createdSwitch: false,
                    createdGateway: true,
                    createdNat: false,
                }),
            };
        });

        expect((await ensureHyperVNetworkAllocation(runtime(root, run), OWNER_ID, DEVICE_ID, INCARNATION_ID)).ok).toBe(true);
        expect(JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8"))).toMatchObject({
            switchId: observedSwitchId,
            marker: "ccc-device-lab:hyper-v-network:v1",
            natName: "CCCDeviceLab",
            natInstanceId: "stable-nat-instance",
            managedSwitch: false,
            managedGateway: true,
            managedNat: false,
        });
    });

    it("keeps committed network identity fenced while an allocation is active", async () => {
        const root = privateRoot();
        writeNetworkState(root, {
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "existing-device",
                incarnationId: "b".repeat(32),
                address: "172.29.0.10",
                macAddress: "02:11:22:33:44:55",
                allocatedAt: new Date().toISOString(),
            }],
        });
        const run = vi.fn(async (command) => {
            const script = scriptOf(command);
            expect(script).toContain("$AllowCccOwnedNetworkAdoption = $false");
            expect(script).toContain(`$ExpectedSwitchId = '${SWITCH_ID.toLowerCase()}'`);
            expect(script).toContain(`$ExpectedNatInstanceId = '${NAT_INSTANCE_ID}'`);
            return {
                mode: "exec" as const,
                provider: "hyper-v",
                status: 1,
                stderr: "hyper-v-network-switch-ownership-conflict",
            };
        });

        expect(await ensureHyperVNetworkAllocation(runtime(root, run), OWNER_ID, DEVICE_ID, INCARNATION_ID)).toMatchObject({
            ok: false,
            status: 502,
            error: "hyper-v-network-setup-failed",
            detail: "hyper-v-network-switch-ownership-conflict",
        });
    });

    it("prunes an unreferenced allocation only after the exact VM is absent, then adopts the stable network", async () => {
        const root = privateRoot();
        const token = "c".repeat(24);
        writeNetworkState(root, {
            marker: `ccc-device-lab:hyper-v-network:${token}`,
            natName: `CCCDeviceLab-${token}`,
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "existing-device",
                incarnationId: "b".repeat(32),
                address: "172.29.0.10",
                macAddress: "02:11:22:33:44:55",
                allocatedAt: new Date().toISOString(),
            }],
        });
        const run = vi.fn()
            .mockResolvedValueOnce(allocationInspection(false))
            .mockResolvedValueOnce({
                ...setupObservation(root),
                stdout: JSON.stringify({
                    ok: true,
                    switchName: "CCC Device Lab",
                    switchId: SWITCH_ID,
                    marker: "ccc-device-lab:hyper-v-network:v1",
                    natName: "CCCDeviceLab",
                    natInstanceId: NAT_INSTANCE_ID,
                    prefix: "172.29.0.0/24",
                    gateway: "172.29.0.1",
                    interfaceIndex: 42,
                    createdSwitch: false,
                    createdGateway: false,
                    createdNat: false,
                }),
            });
        const network = {
            ...runtime(root, run),
            allocationReferenced: vi.fn(() => false),
        };

        expect(await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID)).toMatchObject({ ok: true });
        expect(run).toHaveBeenCalledTimes(2);
        expect(scriptOf(run.mock.calls[0][0])).toContain("hyper-v-network-allocation-vm-ownership-conflict");
        expect(scriptOf(run.mock.calls[0][0])).toContain("$AllVms = @(Get-VM -ErrorAction Stop)");
        expect(scriptOf(run.mock.calls[0][0])).not.toContain("Get-VM -Name");
        expect(scriptOf(run.mock.calls[1][0])).toContain("$AllowCccOwnedNetworkAdoption = $true");
        const state = JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8"));
        expect(state).toMatchObject({ marker: "ccc-device-lab:hyper-v-network:v1", natName: "CCCDeviceLab" });
        expect(state.allocations).toEqual([expect.objectContaining({ deviceId: DEVICE_ID, incarnationId: INCARNATION_ID })]);
    });

    it("keeps an unreferenced allocation when its exact owner-fenced VM is present", async () => {
        const root = privateRoot();
        writeNetworkState(root, {
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "existing-device",
                incarnationId: "b".repeat(32),
                address: "172.29.0.10",
                macAddress: "02:11:22:33:44:55",
                allocatedAt: new Date().toISOString(),
            }],
        });
        const run = vi.fn()
            .mockResolvedValueOnce(allocationInspection(true))
            .mockResolvedValueOnce({ mode: "exec", provider: "hyper-v", status: 1, stderr: "hyper-v-network-switch-ownership-conflict" });
        const network = { ...runtime(root, run), allocationReferenced: () => false };

        expect(await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID)).toMatchObject({
            ok: false,
            error: "hyper-v-network-setup-failed",
        });
        expect(JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8")).allocations).toHaveLength(1);
    });

    it("keeps an allocation referenced by owner state without inspecting or pruning it", async () => {
        const root = privateRoot();
        writeNetworkState(root, {
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "existing-device",
                incarnationId: "b".repeat(32),
                address: "172.29.0.10",
                macAddress: "02:11:22:33:44:55",
                allocatedAt: new Date().toISOString(),
            }],
        });
        const run = vi.fn(async () => ({ mode: "exec" as const, provider: "hyper-v" as const, status: 1, stderr: "hyper-v-network-switch-ownership-conflict" }));
        const network = { ...runtime(root, run), allocationReferenced: vi.fn(() => true) };

        expect(await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID)).toMatchObject({
            ok: false,
            error: "hyper-v-network-setup-failed",
        });
        expect(run).toHaveBeenCalledTimes(1);
        expect(scriptOf(run.mock.calls[0][0])).toContain("$AllowCccOwnedNetworkAdoption = $false");
    });

    it("fails closed when VM ownership cannot be verified during orphan reconciliation", async () => {
        const root = privateRoot();
        writeNetworkState(root, {
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "existing-device",
                incarnationId: "b".repeat(32),
                address: "172.29.0.10",
                macAddress: "02:11:22:33:44:55",
                allocatedAt: new Date().toISOString(),
            }],
        });
        const run = vi.fn(async () => ({
            mode: "exec" as const,
            provider: "hyper-v" as const,
            status: 1,
            stderr: "hyper-v-network-allocation-vm-ownership-conflict",
        }));
        const network = { ...runtime(root, run), allocationReferenced: () => false };

        expect(await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID)).toMatchObject({
            ok: false,
            status: 409,
            error: "hyper-v-network-allocation-reconciliation-failed",
            detail: "hyper-v-network-allocation-vm-ownership-conflict",
            preserveEvidence: true,
        });
        expect(JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8")).allocations).toHaveLength(1);
    });

    it("fails closed when Hyper-V inventory cannot be queried during orphan reconciliation", async () => {
        const root = privateRoot();
        writeNetworkState(root, {
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "existing-device",
                incarnationId: "b".repeat(32),
                address: "172.29.0.10",
                macAddress: "02:11:22:33:44:55",
                allocatedAt: new Date().toISOString(),
            }],
        });
        const before = readFileSync(join(root, "network", "hyper-v.json"), "utf8");
        const run = vi.fn(async (command) => {
            expect(scriptOf(command)).toContain("$AllVms = @(Get-VM -ErrorAction Stop)");
            return {
                mode: "exec" as const,
                provider: "hyper-v" as const,
                status: 1,
                stderr: "Get-VM : Access is denied",
            };
        });

        expect(await ensureHyperVNetworkAllocation(
            { ...runtime(root, run), allocationReferenced: () => false },
            OWNER_ID,
            DEVICE_ID,
            INCARNATION_ID,
        )).toMatchObject({
            ok: false,
            status: 409,
            error: "hyper-v-network-allocation-reconciliation-failed",
            detail: "hyper-v-network-allocation-inspection-failed",
            preserveEvidence: true,
        });
        expect(readFileSync(join(root, "network", "hyper-v.json"), "utf8")).toBe(before);
    });

    it("fails closed on malformed VM inspection output without changing allocation state", async () => {
        const root = privateRoot();
        writeNetworkState(root, {
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "existing-device",
                incarnationId: "b".repeat(32),
                address: "172.29.0.10",
                macAddress: "02:11:22:33:44:55",
                allocatedAt: new Date().toISOString(),
            }],
        });
        const run = vi.fn(async () => ({ mode: "exec" as const, provider: "hyper-v" as const, status: 0, stdout: "{}" }));

        expect(await ensureHyperVNetworkAllocation(
            { ...runtime(root, run), allocationReferenced: () => false },
            OWNER_ID,
            DEVICE_ID,
            INCARNATION_ID,
        )).toMatchObject({
            ok: false,
            error: "hyper-v-network-allocation-reconciliation-failed",
            detail: "hyper-v-network-allocation-inspection-invalid-result",
            preserveEvidence: true,
        });
        expect(JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8")).allocations).toHaveLength(1);
    });

    it("fails closed when owner-state references cannot be read", async () => {
        const root = privateRoot();
        writeNetworkState(root, {
            allocations: [{
                ownerId: OWNER_ID,
                deviceId: "existing-device",
                incarnationId: "b".repeat(32),
                address: "172.29.0.10",
                macAddress: "02:11:22:33:44:55",
                allocatedAt: new Date().toISOString(),
            }],
        });
        const run = vi.fn(async () => setupObservation(root));

        expect(await ensureHyperVNetworkAllocation(
            {
                ...runtime(root, run),
                allocationReferenced: () => { throw new Error("owner-devices-state-read-failed"); },
            },
            OWNER_ID,
            DEVICE_ID,
            INCARNATION_ID,
        )).toMatchObject({
            ok: false,
            error: "hyper-v-network-allocation-reconciliation-failed",
            preserveEvidence: true,
        });
        expect(run).not.toHaveBeenCalled();
        expect(JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8")).allocations).toHaveLength(1);
    });

    it("rejects an observed marker and NAT pair that is not one CCC identity", async () => {
        const root = privateRoot();
        writeNetworkState(root);
        const token = "c".repeat(24);
        const run = vi.fn(async () => ({
            mode: "exec",
            provider: "hyper-v",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                switchName: "CCC Device Lab",
                switchId: SWITCH_ID,
                marker: `ccc-device-lab:hyper-v-network:${token}`,
                natName: "CCCDeviceLab",
                natInstanceId: NAT_INSTANCE_ID,
                prefix: "172.29.0.0/24",
                gateway: "172.29.0.1",
                interfaceIndex: 42,
                createdSwitch: false,
                createdGateway: false,
                createdNat: false,
            }),
        }));

        expect(await ensureHyperVNetworkAllocation(runtime(root, run), OWNER_ID, DEVICE_ID, INCARNATION_ID)).toMatchObject({
            ok: false,
            status: 502,
            error: "hyper-v-network-setup-invalid-result",
        });
    });

    it("rejects a committed marker and NAT pair from different ownership identities", async () => {
        const root = privateRoot();
        const networkRoot = join(root, "network");
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(join(networkRoot, "hyper-v.json"), JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: SWITCH_ID,
            marker: `ccc-device-lab:hyper-v-network:${"d".repeat(24)}`,
            natName: `CCCDeviceLab-${"e".repeat(24)}`,
            natInstanceId: NAT_INSTANCE_ID,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            outboundPolicy: "nat",
            managedNat: true,
            allocations: [],
        }));
        const run = vi.fn(async () => setupObservation(root));

        const result = await ensureHyperVNetworkAllocation(runtime(root, run), OWNER_ID, DEVICE_ID, INCARNATION_ID);

        expect(result).toMatchObject({
            ok: false,
            status: 409,
            error: "hyper-v-network-allocation-failed",
            detail: "hyper-v-network-state-state-invalid",
        });
        expect(run).not.toHaveBeenCalled();
    });

    it("cleans a newly created NAT without deleting a setup-owned switch", async () => {
        const root = privateRoot();
        const run = vi.fn()
            .mockImplementationOnce(async () => {
                const observation = setupObservation(root);
                const parsed = JSON.parse(observation.stdout || "{}");
                return {
                    ...observation,
                    stdout: JSON.stringify({ ...parsed, createdSwitch: false, createdGateway: false, createdNat: true }),
                };
            })
            .mockResolvedValueOnce({
                mode: "exec",
                provider: "hyper-v",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    removedSwitch: false,
                    removedNat: true,
                    removedGateway: false,
                    alreadyMissing: false,
                }),
            });
        const network = runtime(root, run);
        await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);
        const state = JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8"));
        expect(state).toMatchObject({ managedSwitch: false, managedGateway: false, managedNat: true });

        const released = await releaseHyperVNetworkAllocationAndCleanup(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);
        expect(released).toMatchObject({
            ok: true,
            networkCleanup: { removedSwitch: false, removedNat: true },
        });
        const cleanupScript = scriptOf(run.mock.calls[1][0]);
        expect(cleanupScript).toContain("$RemoveNat = $true");
        expect(cleanupScript).toContain("$RemoveSwitch = $false");
        expect(cleanupScript).toContain("$RemoveGateway = $false");
        expect(cleanupScript).toContain("if ($Switches.Count -eq 1 -and $RemoveSwitch)");
    });

    it("cleans a newly created switch and gateway without deleting a pre-existing NAT", async () => {
        const root = privateRoot();
        const run = vi.fn()
            .mockImplementationOnce(async () => {
                const observation = setupObservation(root);
                const parsed = JSON.parse(observation.stdout || "{}");
                return {
                    ...observation,
                    stdout: JSON.stringify({ ...parsed, createdSwitch: true, createdGateway: true, createdNat: false }),
                };
            })
            .mockResolvedValueOnce({
                mode: "exec",
                provider: "hyper-v",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    removedSwitch: true,
                    removedNat: false,
                    removedGateway: true,
                    alreadyMissing: false,
                }),
            });
        const network = runtime(root, run);
        await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);
        const state = JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8"));
        expect(state).toMatchObject({ managedSwitch: true, managedGateway: true, managedNat: false });

        const released = await releaseHyperVNetworkAllocationAndCleanup(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);
        expect(released).toMatchObject({
            ok: true,
            networkCleanup: { removedSwitch: true, removedNat: false, removedGateway: true },
        });
        const cleanupScript = scriptOf(run.mock.calls[1][0]);
        expect(cleanupScript).toContain("$RemoveNat = $false");
        expect(cleanupScript).toContain("$RemoveSwitch = $true");
        expect(cleanupScript).toContain("$RemoveGateway = $true");
    });

    it("rolls back only the NAT when state commit fails after mixed ownership setup", async () => {
        const root = privateRoot();
        let safePathChecks = 0;
        const run = vi.fn()
            .mockImplementationOnce(async () => {
                const observation = setupObservation(root);
                const parsed = JSON.parse(observation.stdout || "{}");
                return {
                    ...observation,
                    stdout: JSON.stringify({ ...parsed, createdSwitch: false, createdGateway: false, createdNat: true }),
                };
            })
            .mockResolvedValueOnce({
                mode: "exec",
                provider: "hyper-v",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    removedSwitch: false,
                    removedNat: true,
                    removedGateway: false,
                    alreadyMissing: false,
                }),
            });
        const network = {
            ...runtime(root, run),
            assertSafePath: () => {
                safePathChecks += 1;
                if (safePathChecks === 2) throw new Error("simulated-state-commit-failure");
            },
        };

        const result = await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);

        expect(result).toMatchObject({ ok: false, status: 409, error: "hyper-v-network-allocation-failed" });
        expect(run).toHaveBeenCalledTimes(2);
        const rollbackScript = scriptOf(run.mock.calls[1][0]);
        expect(rollbackScript).toContain("$RemoveNat = $true");
        expect(rollbackScript).toContain("$RemoveSwitch = $false");
        expect(rollbackScript).toContain("$RemoveGateway = $false");
    });

    it("cleans a newly created gateway without deleting the existing switch or NAT", async () => {
        const root = privateRoot();
        const run = vi.fn()
            .mockImplementationOnce(async () => {
                const observation = setupObservation(root);
                const parsed = JSON.parse(observation.stdout || "{}");
                return {
                    ...observation,
                    stdout: JSON.stringify({ ...parsed, createdSwitch: false, createdGateway: true, createdNat: false }),
                };
            })
            .mockResolvedValueOnce({
                mode: "exec",
                provider: "hyper-v",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    removedSwitch: false,
                    removedNat: false,
                    removedGateway: true,
                    alreadyMissing: false,
                }),
            });
        const network = runtime(root, run);
        await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);
        expect(JSON.parse(readFileSync(join(root, "network", "hyper-v.json"), "utf8"))).toMatchObject({
            managedSwitch: false,
            managedGateway: true,
            managedNat: false,
        });

        await releaseHyperVNetworkAllocationAndCleanup(network, OWNER_ID, DEVICE_ID, INCARNATION_ID);
        const cleanupScript = scriptOf(run.mock.calls[1][0]);
        expect(cleanupScript).toContain("$RemoveNat = $false");
        expect(cleanupScript).toContain("$RemoveSwitch = $false");
        expect(cleanupScript).toContain("$RemoveGateway = $true");
    });

    it("rolls back a newly created gateway and NAT when state commit fails", async () => {
        const root = privateRoot();
        let safePathChecks = 0;
        const run = vi.fn()
            .mockImplementationOnce(async () => {
                const observation = setupObservation(root);
                const parsed = JSON.parse(observation.stdout || "{}");
                return {
                    ...observation,
                    stdout: JSON.stringify({ ...parsed, createdSwitch: false, createdGateway: true, createdNat: true }),
                };
            })
            .mockResolvedValueOnce({
                mode: "exec",
                provider: "hyper-v",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    removedSwitch: false,
                    removedNat: true,
                    removedGateway: true,
                    alreadyMissing: false,
                }),
            });
        const network = {
            ...runtime(root, run),
            assertSafePath: () => {
                safePathChecks += 1;
                if (safePathChecks === 2) throw new Error("simulated-state-commit-failure");
            },
        };

        expect(await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID))
            .toMatchObject({ ok: false, status: 409, error: "hyper-v-network-allocation-failed" });
        expect(run).toHaveBeenCalledTimes(2);
        const rollbackScript = scriptOf(run.mock.calls[1][0]);
        expect(rollbackScript).toContain("$RemoveNat = $true");
        expect(rollbackScript).toContain("$RemoveSwitch = $false");
        expect(rollbackScript).toContain("$RemoveGateway = $true");
    });

    it.each([
        {
            name: "gateway only",
            createdSwitch: false,
            createdGateway: true,
            createdNat: false,
        },
        {
            name: "switch and gateway with existing NAT",
            createdSwitch: true,
            createdGateway: true,
            createdNat: false,
        },
        {
            name: "switch, gateway, and NAT",
            createdSwitch: true,
            createdGateway: true,
            createdNat: true,
        },
    ])("rolls back $name after state commit failure", async ({ createdSwitch, createdGateway, createdNat }) => {
        const root = privateRoot();
        let safePathChecks = 0;
        const run = vi.fn()
            .mockImplementationOnce(async () => {
                const observation = setupObservation(root);
                const parsed = JSON.parse(observation.stdout || "{}");
                return {
                    ...observation,
                    stdout: JSON.stringify({ ...parsed, createdSwitch, createdGateway, createdNat }),
                };
            })
            .mockResolvedValueOnce({
                mode: "exec",
                provider: "hyper-v",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    removedSwitch: createdSwitch,
                    removedNat: createdNat,
                    removedGateway: createdGateway,
                    alreadyMissing: false,
                }),
            });
        const network = {
            ...runtime(root, run),
            assertSafePath: () => {
                safePathChecks += 1;
                if (safePathChecks === 2) throw new Error("simulated-state-commit-failure");
            },
        };

        expect(await ensureHyperVNetworkAllocation(network, OWNER_ID, DEVICE_ID, INCARNATION_ID))
            .toMatchObject({ ok: false, status: 409, error: "hyper-v-network-allocation-failed" });
        expect(run).toHaveBeenCalledTimes(2);
        const rollbackScript = scriptOf(run.mock.calls[1][0]);
        expect(rollbackScript).toContain(`$RemoveNat = $${createdNat}`);
        expect(rollbackScript).toContain(`$RemoveSwitch = $${createdSwitch}`);
        expect(rollbackScript).toContain(`$RemoveGateway = $${createdGateway}`);
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
        writeTokenIntent(root, "c".repeat(24));
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
