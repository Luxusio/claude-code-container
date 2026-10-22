import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repairDeviceLabTestState, runRepairDeviceLabTestStateCli, NETWORK_OBSERVATION_SCRIPT } from "../repair-device-lab-test-state.ts";
import { withSharedMutationLock } from "@ccc/device-lab/device-lab-shared-state.js";
import { HYPER_V_NETWORK_GATEWAY, HYPER_V_NETWORK_PREFIX } from "@ccc/device-lab/host-control/hyper-v/contracts.js";
import { isolateDeviceLabTestEnvironment } from "../../src/__tests__/helpers/device-lab-test-environment.ts";

const token = "0123456789abcdef01234567";
const actualSwitchId = "a1234567-1234-4234-9234-123456789abc";
const fixtureOwner = "d1b76dee591d4a9d";
const hostName = "fixture-host";

function networkState() {
    return {
        version: 1, switchName: "CCC Device Lab", switchId: "00000000-0000-0000-0000-000000000001",
        natName: `CCCDeviceLab-${token}`, natInstanceId: "ccc-test-nat-1", marker: `ccc-device-lab:hyper-v-network:${token}`,
        prefix: HYPER_V_NETWORK_PREFIX, gateway: HYPER_V_NETWORK_GATEWAY, outboundPolicy: "nat",
        managedSwitch: true, managedGateway: true, managedNat: true,
        allocations: [{
            ownerId: "ec46602c63a96da2", deviceId: "real-windows-vm-to-preserve", incarnationId: "a".repeat(32),
            address: HYPER_V_NETWORK_GATEWAY.replace(/1$/, "10"), macAddress: "02:00:00:00:00:01", allocatedAt: "2026-10-01T00:00:00.000Z",
        }, {
            ownerId: "ec46602c63a96da2", deviceId: "legacy-allocation-to-preserve",
            address: HYPER_V_NETWORK_GATEWAY.replace(/1$/, "11"), allocatedAt: "2026-10-01T00:00:01.000Z",
        }],
    };
}
function sandboxLock() {
    return { provider: "windows-sandbox", host: hostName, bootId: `${hostName}:1790330134`, ownerId: fixtureOwner,
        deviceId: "windows-refresh", sandboxId: "12345678-1234-4234-9234-1234567890ab", claimId: "471c97a4c11f95d32d1729cd50f39d73",
        pid: 51760, acquiredAt: "2026-10-02T00:32:42.746Z", updatedAt: "2026-10-02T00:32:42.746Z" };
}
function networkObservation() {
    const state = networkState();
    return {
        switches: [{ id: actualSwitchId, name: state.switchName, type: "Internal", marker: state.marker }],
        nats: [{ name: state.natName, instanceId: "actual-native-nat-id", prefix: state.prefix }],
        managementAdapters: [{ switchId: actualSwitchId, switchName: state.switchName, macAddress: "00155DABCDEF" }],
        adapters: [{ index: 42, macAddress: "00-15-5D-AB-CD-EF", status: "Up" }],
        addresses: [{ index: 42, address: state.gateway, prefixLength: 24, state: "Preferred" }],
    };
}

describe("explicit historical Device Lab fixture-state repair", () => {
    let homeDir: string;
    let networkFile: string;
    let sandboxFile: string;
    let restore: () => void;
    const network = vi.fn();
    const sandbox = vi.fn();
    const put = (path: string, value: unknown) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(value, null, 4) + "\n");
    };
    const repair = () => repairDeviceLabTestState({ homeDir, hostName, observers: { network, sandbox }, lockWaitMs: 0 });

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-state-repair-"));
        restore = isolateDeviceLabTestEnvironment(homeDir);
        networkFile = join(homeDir, ".ccc/device-broker-private/network/hyper-v.json");
        sandboxFile = join(homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
        network.mockReset().mockImplementation(networkObservation);
        sandbox.mockReset().mockReturnValue({ runtime: { WindowsSandboxEnvironments: [] }, pidStatus: "exited" });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        restore();
        rmSync(homeDir, { recursive: true, force: true });
    });

    it("rebinds only native IDs, drops teardown authority, preserves all allocations and original backups, and reruns as a no-op", () => {
        const state = networkState();
        put(networkFile, state);
        put(sandboxFile, sandboxLock());
        const originalNetwork = readFileSync(networkFile);
        const originalSandbox = readFileSync(sandboxFile);
        const result = repair();
        expect(result).toEqual({ network: "repaired", sandbox: "quarantined",
            backups: [networkFile + ".test-fixture-backup.json", sandboxFile + ".test-fixture-backup.json"] });
        expect(JSON.parse(readFileSync(networkFile, "utf8"))).toEqual({ ...state,
            switchId: actualSwitchId, natInstanceId: "actual-native-nat-id", managedSwitch: false, managedGateway: false, managedNat: false });
        expect(readFileSync(result.backups[0]!)).toEqual(originalNetwork);
        expect(readFileSync(result.backups[1]!)).toEqual(originalSandbox);
        expect(existsSync(sandboxFile)).toBe(false);
        expect(network).toHaveBeenCalledTimes(2);
        expect(sandbox).toHaveBeenCalledTimes(2);
        expect(sandbox).toHaveBeenCalledWith(51760);
        network.mockClear(); sandbox.mockClear();
        expect(repair()).toEqual({ network: "unchanged", sandbox: "unchanged", backups: [] });
        expect(network).not.toHaveBeenCalled();
        expect(sandbox).not.toHaveBeenCalled();
        expect(readFileSync(result.backups[0]!)).toEqual(originalNetwork);
    });

    it("does nothing when no provider state exists", () => {
        expect(repair()).toEqual({ network: "unchanged", sandbox: "unchanged", backups: [] });
        expect(network).not.toHaveBeenCalled(); expect(sandbox).not.toHaveBeenCalled();
        expect(existsSync(networkFile)).toBe(false); expect(existsSync(sandboxFile)).toBe(false);
    });

    it.each([
        ["unknown state metadata", (state: any) => { state.unrecognizedAuthority = true; }],
        ["unknown allocation metadata", (state: any) => { state.allocations[0].unrecognized = true; }],
        ["mixed fixture identities", (state: any) => { state.switchId = actualSwitchId; }],
        ["legacy marker", (state: any) => { state.marker = "ccc-device-lab:hyper-v-network:v1"; state.natName = "CCCDeviceLab"; }],
    ] as const)("refuses %s without changing state", (_name, mutate) => {
        const state = networkState(); mutate(state);
        put(networkFile, state); const before = readFileSync(networkFile);
        expect(repair).toThrow(/test-state-repair-/);
        expect(readFileSync(networkFile)).toEqual(before);
        expect(existsSync(networkFile + ".test-fixture-backup.json")).toBe(false);
    });

    it.each([
        ["wrong switch marker", (value: any) => { value.switches[0].marker += "wrong"; }],
        ["duplicate switches", (value: any) => { value.switches.push({ ...value.switches[0] }); }],
        ["wrong NAT prefix", (value: any) => { value.nats[0].prefix = "10.0.0.0/24"; }],
        ["duplicate NAT", (value: any) => { value.nats.push({ ...value.nats[0] }); }],
        ["wrong management switch", (value: any) => { value.managementAdapters[0].switchId = "b1234567-1234-4234-9234-123456789abc"; }],
        ["unmatched adapter MAC", (value: any) => { value.adapters[0].macAddress = "00-15-5D-AA-AA-AA"; }],
        ["gateway on another adapter", (value: any) => { value.addresses[0].index = 43; }],
        ["ambiguous gateway", (value: any) => { value.addresses.push({ ...value.addresses[0] }); }],
        ["unknown observation metadata", (value: any) => { value.unrecognized = true; }],
        ["malformed adapter index", (value: any) => { value.adapters[0].index = "42"; }],
    ] as const)("refuses %s from the native observer", (_name, mutate) => {
        put(networkFile, networkState()); const before = readFileSync(networkFile);
        network.mockImplementation(() => { const value = networkObservation(); mutate(value); return value; });
        expect(repair).toThrow(/test-state-repair-/);
        expect(readFileSync(networkFile)).toEqual(before);
        expect(existsSync(networkFile + ".test-fixture-backup.json")).toBe(false);
    });

    it.each(["alive", "unknown"])("preflights both repairs and preserves network state when the old Sandbox PID is %s", pidStatus => {
        put(networkFile, networkState()); put(sandboxFile, sandboxLock());
        const before = readFileSync(networkFile);
        sandbox.mockReturnValue({ runtime: { WindowsSandboxEnvironments: [] }, pidStatus });
        expect(repair).toThrow("test-state-repair-sandbox-process-not-exited");
        expect(readFileSync(networkFile)).toEqual(before);
        expect(existsSync(sandboxFile)).toBe(true);
        expect(existsSync(networkFile + ".test-fixture-backup.json")).toBe(false);
    });

    it.each([
        ["foreign owner", (lock: any) => { lock.ownerId = "a".repeat(16); }],
        ["foreign host", (lock: any) => { lock.host = "another-host"; }],
        ["successor claim metadata", (lock: any) => { lock.updatedAt = "2026-10-02T01:00:00.000Z"; }],
        ["unknown lock metadata", (lock: any) => { lock.processIdentity = {}; }],
    ] as const)("refuses Sandbox %s", (_name, mutate) => {
        const lock = sandboxLock(); mutate(lock); put(sandboxFile, lock);
        const before = readFileSync(sandboxFile);
        expect(repair).toThrow(/test-state-repair-/);
        expect(readFileSync(sandboxFile)).toEqual(before); expect(sandbox).not.toHaveBeenCalled();
    });

    it("requires recognized empty native Sandbox output and absent fixture owner state", () => {
        put(sandboxFile, sandboxLock());
        sandbox.mockReturnValue({ runtime: {}, pidStatus: "exited" });
        expect(repair).toThrow("test-state-repair-observation-invalid");
        sandbox.mockReturnValue({ runtime: { WindowsSandboxEnvironments: [{ Id: actualSwitchId }] }, pidStatus: "exited" });
        expect(repair).toThrow("test-state-repair-sandbox-runtime-not-empty");
        mkdirSync(join(homeDir, ".ccc/devices/owners", fixtureOwner, "windows"), { recursive: true });
        expect(repair).toThrow("test-state-repair-owner-state-present");
        expect(existsSync(sandboxFile)).toBe(true);
    });

    it("rejects a pending network intent", () => {
        put(networkFile, networkState()); put(join(dirname(networkFile), "hyper-v-intent.json"), {});
        expect(repair).toThrow("test-state-repair-network-intent-pending");
        expect(network).not.toHaveBeenCalled();
    });

    it("rejects a native successor observed before commit", () => {
        put(networkFile, networkState());
        const before = readFileSync(networkFile);
        network.mockImplementationOnce(networkObservation).mockImplementation(() => {
            const value = networkObservation(); value.nats[0]!.instanceId = "native-successor-id"; return value;
        });
        expect(repair).toThrow("test-state-repair-network-observation-changed");
        expect(readFileSync(networkFile)).toEqual(before);
    });

    it("never overwrites state changed after the first safe read", () => {
        put(networkFile, networkState());
        const replacement = { ...networkState(), managedNat: false };
        network.mockImplementation(() => { put(networkFile, replacement); return networkObservation(); });
        expect(repair).toThrow("test-state-repair-state-changed");
        expect(JSON.parse(readFileSync(networkFile, "utf8"))).toEqual(replacement);
        expect(existsSync(networkFile + ".test-fixture-backup.json")).toBe(false);
    });

    it("refuses a conflicting backup and an unsafe hard-linked state file", () => {
        put(networkFile, networkState()); const before = readFileSync(networkFile);
        put(networkFile + ".test-fixture-backup.json", { earlier: "evidence" });
        expect(repair).toThrow("test-state-repair-backup-conflict");
        expect(readFileSync(networkFile)).toEqual(before);
        linkSync(networkFile, join(homeDir, "hard-link.json"));
        expect(repair).toThrow(/test-state-repair-state-invalid/);
        expect(readFileSync(networkFile)).toEqual(before);
    });

    it.each(["hyper-v", "windows-sandbox"])("does not mutate state when the %s mutation lock is held", provider => {
        put(networkFile, networkState()); const before = readFileSync(networkFile);
        const lock = join(homeDir, ".ccc/devices/host-locks", `${provider}.mutation.lock`);
        withSharedMutationLock(lock, () => expect(repair).toThrow(expect.objectContaining({ code: "shared-mutation-lock-self-contention" })));
        expect(readFileSync(networkFile)).toEqual(before);
        expect(network).not.toHaveBeenCalled();
    });

    it("keeps the native observer read-only and refuses CLI execution off Windows before creating state", () => {
        expect(NETWORK_OBSERVATION_SCRIPT).not.toMatch(/\b(?:New|Set|Remove|Stop|Start|Restart)-(?:VM|Net|Process)/);
        expect(NETWORK_OBSERVATION_SCRIPT).toContain("Get-VMNetworkAdapter -ManagementOS");
        if (process.platform === "win32") return;
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        expect(runRepairDeviceLabTestStateCli([])).toBe(1);
        expect(stderr).toHaveBeenCalledWith("test-state-repair-windows-host-required\n");
        expect(existsSync(join(homeDir, ".ccc"))).toBe(false);
    });

    it.each([
        { argument: "--help", status: 0, output: "Usage: node --import tsx scripts/repair-device-lab-test-state.ts" },
        { argument: "--force", status: 1, output: "test-state-repair-unknown-argument" },
    ])("CLI $argument exits before touching state", ({ argument, status, output }) => {
        const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../repair-device-lab-test-state.ts", import.meta.url)), argument], {
            env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true,
        });
        expect(result.status).toBe(status);
        expect(result.stdout + result.stderr).toContain(output);
        expect(existsSync(join(homeDir, ".ccc"))).toBe(false);
    });
});
