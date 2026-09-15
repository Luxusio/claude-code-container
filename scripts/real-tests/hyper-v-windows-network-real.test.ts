import { describe, expect, it, vi } from "vitest";

import * as library from "../../src/hyper-v-windows/index.ts";
import { HyperVElevatedNetworkSessionError } from "../../src/device-lab/broker/hyper-v/elevated-network-session.ts";
import { runHyperVWindowsNetworkHost } from "./hyper-v-windows-network-host.ts";
import { runHyperVWindowsNetworkRealScenario } from "./hyper-v-windows-network-real.ts";

const FOREIGN_SWITCH_ID = "11111111-1111-1111-1111-111111111111";
const FOREIGN_VM_ID = "22222222-2222-2222-2222-222222222222";

function fakeHost(options: { readonly mutateForeignDuringCold?: boolean } = {}) {
    let generation = 0;
    const switches: any[] = [{
        id: library.parseHyperVVirtualSwitchId(FOREIGN_SWITCH_ID),
        name: library.parseHyperVVirtualSwitchName("unrelated-switch"),
        switchType: "External",
        notes: "unrelated",
    }];
    const nats: any[] = [{
        instanceId: library.parseHyperVNatInstanceId("unrelated-nat-instance"),
        name: library.parseHyperVNatName("unrelated-nat"),
        internalAddressPrefix: library.parseIPv4Cidr("10.201.0.0/24"),
    }];
    const addresses: any[] = [{
        interfaceIndex: library.parseHyperVInterfaceIndex(7),
        address: library.parseIPv4Address("10.201.0.1"),
        prefixLength: library.parseIPv4PrefixLength(24),
        prefixOrigin: "Manual",
        suffixOrigin: "Manual",
        addressState: "Preferred",
    }];
    const hostAdapters: any[] = [];
    const removals: Array<{ readonly kind: string; readonly identity: string }> = [];
    let mutatedForeign = false;

    const client = {
        async getVMSwitches() { return [...switches]; },
        async createVMSwitch(request: any) {
            generation += 1;
            const id = library.parseHyperVVirtualSwitchId(`aaaaaaaa-aaaa-aaaa-aaaa-${String(generation).padStart(12, "0")}`);
            const created = { id, name: request.name, switchType: "Internal", notes: request.notes };
            switches.push(created);
            hostAdapters.push({
                interfaceIndex: library.parseHyperVInterfaceIndex(100 + generation),
                name: library.parseHyperVNetworkAdapterName(`vEthernet (${String(request.name)})`),
                status: "Up",
                interfaceDescription: "Hyper-V Virtual Ethernet Adapter",
            });
            return created;
        },
        async setVMSwitchNotes(request: any) {
            const item = switches.find((candidate) => candidate.id === request.identity.id);
            if (item) item.notes = request.notes;
        },
        async removeVMSwitch(request: any) {
            const index = switches.findIndex((candidate) => candidate.id === request.identity.id
                && candidate.name === request.identity.name);
            if (index < 0) throw new Error("wrong-switch-id");
            removals.push({ kind: "switch", identity: String(request.identity.id) });
            switches.splice(index, 1);
            const adapterIndex = hostAdapters.findIndex((candidate) =>
                candidate.name === `vEthernet (${String(request.identity.name)})`);
            if (adapterIndex >= 0) hostAdapters.splice(adapterIndex, 1);
        },
        async getAllVMNetworkAdapters() {
            return [{
                vmId: library.parseHyperVVirtualMachineId(FOREIGN_VM_ID),
                vmName: "unrelated-vm",
                name: "Network Adapter",
                switchId: library.parseHyperVVirtualSwitchId(FOREIGN_SWITCH_ID),
                switchName: "unrelated-switch",
                status: "Ok",
                managementOperatingSystem: false,
            }];
        },
        async getVMsByExactNames() { return []; },
        async getHostNetworkAdapters(request: any) {
            return hostAdapters.filter((candidate) => candidate.name === request.name);
        },
        async getNetIPAddresses() { return [...addresses]; },
        async createNetIPAddress(request: any) {
            const created = {
                ...request,
                prefixOrigin: "Manual",
                suffixOrigin: "Manual",
                addressState: "Preferred",
            };
            addresses.push(created);
            return created;
        },
        async removeNetIPAddress(request: any) {
            const index = addresses.findIndex((candidate) => candidate.interfaceIndex === request.interfaceIndex
                && candidate.address === request.address && candidate.prefixLength === request.prefixLength);
            if (index < 0) throw new Error("wrong-gateway-id");
            removals.push({ kind: "gateway", identity: `${request.interfaceIndex}:${request.address}/${request.prefixLength}` });
            addresses.splice(index, 1);
            if (options.mutateForeignDuringCold && !mutatedForeign) {
                mutatedForeign = true;
                switches[0].notes = "unexpected-change";
            }
        },
        async getNetNats() { return [...nats]; },
        async createNetNat(request: any) {
            const created = {
                instanceId: library.parseHyperVNatInstanceId(`target-nat-${generation}`),
                name: request.name,
                internalAddressPrefix: request.internalAddressPrefix,
            };
            nats.push(created);
            return created;
        },
        async removeNetNat(request: any) {
            const index = nats.findIndex((candidate) => candidate.instanceId === request.identity.instanceId
                && candidate.name === request.identity.name);
            if (index < 0) throw new Error("wrong-nat-id");
            removals.push({ kind: "nat", identity: String(request.identity.instanceId) });
            nats.splice(index, 1);
        },
    };
    return { client, switches, nats, addresses, removals };
}

describe("Hyper-V Windows network real-host scenario orchestration", () => {
    it("uses one administrator scope per cold/warm attempt, reuses the session, and cleans exact IDs", async () => {
        const host = fakeHost();
        const scopes: string[] = [];
        const clock = [100, 145, 200, 225];
        const result = await runHyperVWindowsNetworkRealScenario({
            library,
            ordinaryClient: host.client,
            randomToken: () => "0123456789abcdef",
            now: () => clock.shift() ?? 225,
            legacyNativeInvocationCount: 17,
            withAdministratorClient: async (attempt, operation) => {
                scopes.push(attempt);
                return operation(host.client, "elevated-session-1");
            },
        });

        expect(scopes).toEqual(["cold", "warm"]);
        expect(result).toMatchObject({
            administratorScopeCount: 2,
            sessionReused: true,
            legacyNativeInvocationCount: 17,
            legacyComparison: "measured",
            attempts: [
                { kind: "cold", wallTimeMilliseconds: 45, switchId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001", natInstanceId: "target-nat-1" },
                { kind: "warm", wallTimeMilliseconds: 25, switchId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000002", natInstanceId: "target-nat-2" },
            ],
            typedNativeInvocationCounts: {
                cold: { ordinary: 10, elevated: 56, mutations: 6 },
                warm: { ordinary: 10, elevated: 56, mutations: 6 },
            },
        });
        expect(host.removals).toEqual([
            { kind: "nat", identity: "target-nat-1" },
            { kind: "gateway", identity: "101:172.31.65.1/24" },
            { kind: "switch", identity: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001" },
            { kind: "nat", identity: "target-nat-2" },
            { kind: "gateway", identity: "102:172.31.65.1/24" },
            { kind: "switch", identity: "aaaaaaaa-aaaa-aaaa-aaaa-000000000002" },
        ]);
        expect(host.switches).toEqual([expect.objectContaining({ id: FOREIGN_SWITCH_ID, notes: "unrelated" })]);
        expect(host.nats).toEqual([expect.objectContaining({ instanceId: "unrelated-nat-instance" })]);
        expect(host.addresses).toEqual([expect.objectContaining({ interfaceIndex: 7, address: "10.201.0.1" })]);
    });

    it("fails when warm execution does not reuse the elevated session", async () => {
        const host = fakeHost();
        await expect(runHyperVWindowsNetworkRealScenario({
            library,
            ordinaryClient: host.client,
            randomToken: () => "0123456789abcdef",
            withAdministratorClient: async (attempt, operation) => operation(host.client, `session-${attempt}`),
        })).rejects.toThrow("hyper-v-network-real-session-not-reused");
    });

    it("detects unrelated host resource mutation after exact target cleanup", async () => {
        const host = fakeHost({ mutateForeignDuringCold: true });
        const scope = vi.fn(async (_attempt: "cold" | "warm", operation: any) => operation(host.client, "session-1"));
        await expect(runHyperVWindowsNetworkRealScenario({
            library,
            ordinaryClient: host.client,
            randomToken: () => "0123456789abcdef",
            withAdministratorClient: scope,
        })).rejects.toThrow("hyper-v-network-real-unrelated-resource-mutated");
        expect(scope).toHaveBeenCalledTimes(1);
    });

    it("records that legacy execution was intentionally not run by the standalone destructive proof", async () => {
        const host = fakeHost();
        const result = await runHyperVWindowsNetworkRealScenario({
            library,
            ordinaryClient: host.client,
            randomToken: () => "0123456789abcdef",
            withAdministratorClient: async (_attempt, operation) => operation(host.client, "session-1"),
        });
        expect(result.legacyNativeInvocationCount).toBeNull();
        expect(result.legacyComparison).toBe("not-run-standalone-safety");
    });

    it("refuses a pre-existing token-name collision before requesting administrator scope", async () => {
        const host = fakeHost();
        host.switches.push({
            id: library.parseHyperVVirtualSwitchId("33333333-3333-3333-3333-333333333333"),
            name: library.parseHyperVVirtualSwitchName("ccc-net-real-0123456789abcdef"),
            switchType: "Internal",
            notes: "foreign-owner",
        });
        const scope = vi.fn();
        await expect(runHyperVWindowsNetworkRealScenario({
            library,
            ordinaryClient: host.client,
            randomToken: () => "0123456789abcdef",
            withAdministratorClient: scope,
        })).rejects.toThrow("hyper-v-network-real-token-resource-preexists");
        expect(scope).not.toHaveBeenCalled();
        expect(host.removals).toEqual([]);
    });
});

function output() {
    let stdout = "";
    let stderr = "";
    return {
        stdout: { write(value: unknown) { stdout += String(value); return true; } },
        stderr: { write(value: unknown) { stderr += String(value); return true; } },
        read: () => ({ stdout, stderr }),
    };
}

describe("Hyper-V Windows network real-host entrypoint", () => {
    it("keeps unavailable real Windows proof distinct from Linux orchestration proof", async () => {
        const sink = output();
        await expect(runHyperVWindowsNetworkHost({
            platform: "linux",
            stdout: sink.stdout as any,
            stderr: sink.stderr as any,
        })).resolves.toBe(0);
        expect(sink.read().stdout).toContain("SKIP Hyper-V Windows typed network real-host proof");
        expect(sink.read().stdout).toContain("Type/fake orchestration proof is separate");
        expect(sink.read().stdout).toContain("pass=0 skip=1 fail=0");
    });

    it("opens one UAC-backed session and reports cold/warm counts from the separate scenario", async () => {
        const sink = output();
        const elevated = vi.fn(async (options: any, operation: any) => {
            options.onBeforeElevation();
            return operation({ execute: vi.fn() });
        });
        const scenario = vi.fn(async (dependencies: any) => {
            await dependencies.withAdministratorClient("cold", async (_client: any, sessionId: string) => {
                expect(sessionId).toBe("elevated-session-1");
            });
            await dependencies.withAdministratorClient("warm", async (_client: any, sessionId: string) => {
                expect(sessionId).toBe("elevated-session-1");
            });
            return {
                token: "0123456789abcdef",
                switchName: "ccc-net-real-0123456789abcdef",
                natName: "ccc-net-real-0123456789abcdef",
                administratorScopeCount: 2,
                sessionReused: true,
                attempts: [
                    { kind: "cold", wallTimeMilliseconds: 40, switchId: "a", natInstanceId: "n1" },
                    { kind: "warm", wallTimeMilliseconds: 20, switchId: "b", natInstanceId: "n2" },
                ],
                typedNativeInvocationCounts: {
                    cold: { ordinary: 10, elevated: 56, mutations: 6 },
                    warm: { ordinary: 10, elevated: 56, mutations: 6 },
                },
                legacyNativeInvocationCount: null,
                legacyComparison: "not-run-standalone-safety",
            };
        });
        const runtime = {
            createHyperVWindowsPowerShellExecutor: vi.fn(() => ({ execute: vi.fn() })),
            createHyperVWindowsNetworkClient: vi.fn(() => ({ marker: "client" })),
        };

        const status = await runHyperVWindowsNetworkHost({
            platform: "win32",
            windowsSystemRoot: "C:\\Windows",
            stdout: sink.stdout as any,
            stderr: sink.stderr as any,
            importLibraryImpl: async () => runtime as any,
            withElevatedExecutorImpl: elevated as any,
            runScenarioImpl: scenario as any,
            withExclusiveRunImpl: async (operation) => operation(),
        });
        expect(status, JSON.stringify(sink.read())).toBe(0);

        expect(elevated).toHaveBeenCalledTimes(1);
        expect(scenario).toHaveBeenCalledTimes(1);
        expect(sink.read().stdout).toContain("REQUEST Windows is asking for Administrator permission via UAC");
        expect(sink.read().stdout).toContain('"uacPromptCount":1');
        expect(sink.read().stdout).toContain('"administratorScopeCount":2');
        expect(sink.read().stdout).toContain('"sessionReused":true');
        expect(sink.read().stdout).toContain('"coldWallTimeMilliseconds":40');
        expect(sink.read().stdout).toContain('"warmWallTimeMilliseconds":20');
        expect(sink.read().stdout).toContain("pass=1 skip=0 fail=0");
    });

    it("reports a bounded termination stage without changing the stable failure text", async () => {
        const sink = output();
        const runtime = {
            createHyperVWindowsPowerShellExecutor: vi.fn(() => ({ execute: vi.fn() })),
            createHyperVWindowsNetworkClient: vi.fn(() => ({ marker: "client" })),
        };

        const status = await runHyperVWindowsNetworkHost({
            platform: "win32",
            windowsSystemRoot: "C:\\Windows",
            stdout: sink.stdout as any,
            stderr: sink.stderr as any,
            importLibraryImpl: async () => runtime as any,
            withElevatedExecutorImpl: (async (options: any) => {
                options.onBeforeElevation();
                throw new HyperVElevatedNetworkSessionError(
                    "hyper-v-network-elevation-termination-unconfirmed",
                    "relay-process-exit-timeout",
                    {
                        relay: {
                            shutdownMode: "abrupt",
                            progressStage: "request-forwarded",
                            closeWriteStatus: "not-started",
                            processExited: false,
                            stdoutDrained: false,
                            stderrObserved: true,
                            forceExpired: true,
                        },
                        execution: {
                            lastOperation: "Get-NetNat",
                            lastSessionError: "hyper-v-windows-session-queue-timeout",
                            activeExecutions: 1,
                        },
                    },
                );
            }) as any,
            runScenarioImpl: vi.fn() as any,
            withExclusiveRunImpl: async (operation) => operation(),
        });

        expect(status).toBe(1);
        expect(sink.read().stderr).toContain(
            "DIAGNOSTIC Hyper-V elevated network termination stage=relay-process-exit-timeout",
        );
        expect(sink.read().stderr).toContain(
            "DIAGNOSTIC Hyper-V elevated network relay shutdown=abrupt progress=request-forwarded"
            + " closeWrite=not-started processExited=false stdoutDrained=false stderrObserved=true"
            + " forceExpired=true activeExecutions=1 lastOperation=Get-NetNat"
            + " lastSessionError=hyper-v-windows-session-queue-timeout",
        );
        expect(sink.read().stderr).toContain(
            "FAIL Hyper-V Windows typed network real-host proof: hyper-v-network-elevation-termination-unconfirmed",
        );
        expect(sink.read().stderr).not.toContain("native secret");
    });
});
