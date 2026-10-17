import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceObservation } from "../../../packages/device-lab/providers/application/device-observation.mjs";
import { observationMacosSelection } from "../../../packages/device-lab/providers/domain/device-observation.mjs";
import { materializeMacosObservationPlan, observationMacosPlan, observationMacosStartArgs } from "../../../packages/device-lab/providers/adapters/macos-observation-plan.mjs";
import type { MacosFacts, MacosObservationPorts } from "../../../packages/device-lab/providers/ports/device-observation.mjs";
import type { MacosVmDevice, MacosVmLifecyclePorts, MacosVmStartBudget } from "../../../packages/device-lab/providers/ports/lifecycle/macos-vm-lifecycle.mjs";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";

const native = vi.hoisted(() => ({
    records: [] as MacosVmDevice[],
    executables: new Map<string, string>(),
    launch: undefined as MacosVmLifecyclePorts["launchProvider"] | undefined,
    settle: undefined as ((budget: MacosVmStartBudget) => ReturnType<MacosVmLifecyclePorts["waitProviderStart"]>) | undefined,
    stop: undefined as MacosVmLifecyclePorts["stopInstance"] | undefined,
    remove: undefined as MacosVmLifecyclePorts["deleteInstance"] | undefined,
    spawn: vi.fn((_command: string, _args: string[], _options: object) => ({ unref() {} })),
    timed: vi.fn((_command: string, _args: string[], _timeout: number) => ({ status: 0, stdout: "", stderr: "" })),
    run: vi.fn(() => { throw new Error("Observation must not execute an unbudgeted provider command"); }),
}));
vi.mock("../../../packages/device-lab/providers/commands.mjs", () => ({
    commandPath: (name: string) => native.executables.get(name) ?? null,
    run: native.run,
    runWithTimeout: native.timed,
}));
vi.mock("child_process", async original => ({ ...await original<Record<string, unknown>>(), spawn: native.spawn }));
vi.mock("../../../packages/device-lab/providers/state/macos-state.mjs", async original => ({
    ...await original<Record<string, unknown>>(), readMacosDevices: () => native.records,
}));
vi.mock("../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs", async () => {
    const actual = await vi.importActual<typeof import("../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs")>("../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs");
    const create: typeof actual.createMacosVmLifecycleApplication = ports => {
        native.launch = (plan, device, budget) => {
            const launched = ports.launchProvider(plan, device, budget);
            // Keep the factory's generic child inside its original port scope;
            // settlement must use the exact handle returned by that launch.
            if (launched) native.settle = captured => ports.waitProviderStart(launched.child, captured);
            return launched;
        };
        native.stop = plan => ports.stopInstance(plan);
        native.remove = (plan, instance) => ports.deleteInstance(plan, instance);
        return actual.createMacosVmLifecycleApplication(ports);
    };
    return { ...actual, createMacosVmLifecycleApplication: create };
});
interface NativeMacosBackend {
    listMacosDevices(options?: { identityOnly?: boolean }): MacosVmDevice[];
    handleMacosTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text: string }> } | undefined>;
}
const backendUrl = new URL("../../../packages/device-lab/providers/backends/macos-vm.mjs", import.meta.url);
const backend = await vi.importActual<NativeMacosBackend>(backendUrl.href);

const paths = { workspaceDir: "/owned/workspace", toolsDir: "/owned/workspace/tools", hostHelperScript: "/owned/workspace/tools/helper.sh" };
const device: MacosVmDevice = { id: "owned", memoryMb: 4096, cpus: 4 };
const facts = (providers: MacosFacts["providers"], missing: string[] = [], hostSupported = true): MacosFacts => ({ hostSupported, providers, missing, available: hostSupported && providers.length > 0 });
const selection = (owned: MacosVmDevice, discovery: MacosFacts) => observationMacosSelection(owned, {
    hostSupported: discovery.hostSupported, missing: discovery.missing,
    providers: discovery.providers.map(provider => ({ name: provider.name, available: Boolean(provider.command) })),
}, "owner");
const plan = (owned: MacosVmDevice, discovery: MacosFacts) => materializeMacosObservationPlan(owned, selection(owned, discovery), discovery, paths);
function fixture(records: MacosVmDevice[] = []) {
    const executable = vi.fn((name: string) => ["tart", "vz", "utmctl"].includes(name) ? `/fixture/${name}` : null);
    const helperPaths = vi.fn(() => paths);
    const ports: MacosObservationPorts = {
        kind: "macos-vm", ownerId: () => "owner", now: () => 1000, readPhysicalLeases: () => [], capabilities: [],
        platform: () => "darwin", providerNames: ["tart", "vz", "utmctl"], executable, records: () => records,
        helperPaths, materializePlan: materializeMacosObservationPlan,
    };
    return { ports, app: createDeviceObservation(ports), executable, helperPaths };
}
function launch(plan: Parameters<MacosVmLifecyclePorts["launchProvider"]>[0], device: MacosVmDevice, budget: MacosVmStartBudget = { remainingMs: () => 300000 }) {
    const result = native.launch!(plan, device, budget);
    expect(result).not.toBeNull();
    if (!result) throw new Error("Expected an admitted native launch");
    return result;
}

describe("macOS semantic provider selection and outward plans", () => {
    it("keeps discovery order for auto and honors an explicit provider without changing facts", () => {
        const discovery = facts([{ name: "vz", command: "/vz" }, { name: "tart", command: "/tart" }]);
        expect(selection(device, discovery)).toMatchObject({ requestedProvider: "auto", selectedProvider: "vz", providerInstance: "ccc-owner-owned", available: true, implemented: true });
        expect(selection({ ...device, provider: "tart", providerInstance: "explicit-instance" }, discovery))
            .toMatchObject({ requestedProvider: "tart", selectedProvider: "tart", providerInstance: "explicit-instance", available: true });
        expect(discovery.providers).toEqual([{ name: "vz", command: "/vz" }, { name: "tart", command: "/tart" }]);
    });

    it.each([
        { requested: "auto", missing: ["first", "first"], expected: ["first", "first", "macos-vm-provider"] },
        { requested: "tart", missing: ["macos-vm-provider", "first"], expected: ["macos-vm-provider", "first", "macos-vm-provider:tart"] },
        { requested: "tart", missing: ["macos-vm-provider:tart", "first", "macos-vm-provider:tart"], expected: ["macos-vm-provider:tart", "first", "macos-vm-provider:tart"] },
    ])("retains missing order and existing duplicates for $requested", ({ requested, missing, expected }) => {
        const originalMissing = [...missing];
        const discovery = facts([], missing);
        const observed = observationMacosPlan({ ...device, provider: requested }, discovery, "owner", paths);
        expect(observed).toMatchObject({ available: false, selectedProvider: null, providerCommand: null, missing: expected, startCommand: null, stopCommand: null, deleteCommand: null });
        expect(discovery.missing).toBe(missing);
        expect(discovery.missing).toEqual(originalMissing);
    });

    it("preserves unsupported selection and empty-command unavailability without inventing recipes", () => {
        const unsupported = plan({ ...device, provider: "other" }, facts([{ name: "other", command: "/other" }]));
        expect(unsupported).toMatchObject({ available: false, selectedProvider: "other", stopAvailable: false });
        expect(unsupported.evidence).toMatchObject({ providerCommand: "/other", startCommand: null, stopCommand: null, deleteCommand: null, implemented: [], missing: [] });
        expect(observationMacosStartArgs("other", "instance", { softnet: true, headless: true })).toEqual(["start", "instance"]);
        const empty = plan({ ...device, provider: "tart" }, facts([{ name: "tart", command: "" }]));
        expect(empty).toMatchObject({ available: false, selectedProvider: "tart", stopAvailable: false });
        expect(empty.evidence).toMatchObject({ providerCommand: null, startCommand: null, stopCommand: null, deleteCommand: null });
    });

    it("keeps the command associated with the selected occurrence when provider names repeat", () => {
        const discovery = facts([{ name: "vz", command: "/vz" }, { name: "tart", command: "" }, { name: "tart", command: "/later-tart" }]);
        const owned = { ...device, provider: "tart" };
        expect(selection(owned, discovery)).toMatchObject({ selectedProvider: "tart", available: false });
        expect(plan(owned, discovery).evidence).toMatchObject({ providerCommand: null, startCommand: null, stopCommand: null, deleteCommand: null });
    });

    it("uses the supplied missing/provider facts without adding an independent host veto", () => {
        expect(plan(device, facts([{ name: "tart", command: "/tart" }], [], false)).available).toBe(true);
        expect(plan(device, facts([], ["macos-host"], false)).missing).toEqual(["macos-host"]);
    });

    it.each([
        { provider: "tart", options: {}, start: ["run", "instance"] },
        { provider: "tart", options: { softnet: true, headless: true }, start: ["run", "--with-softnet", "--no-graphics", "instance"] },
        { provider: "tart", options: { softnet: false, headless: true }, start: ["run", "--no-graphics", "instance"] },
        { provider: "vz", options: { softnet: true, headless: true }, start: ["start", "instance"] },
        { provider: "utmctl", options: { softnet: true, headless: true }, start: ["start", "instance"] },
    ])("materializes $provider stored metadata into the legacy start/stop/delete recipes", ({ provider, options, start }) => {
        const owned = { ...device, provider, providerInstance: "instance", ...options };
        const discovery = facts([{ name: provider, command: `/fixture/${provider}` }]);
        const nativePlan = plan(owned, discovery);
        expect(nativePlan).toMatchObject({ available: true, selectedProvider: provider, providerInstance: "instance", stopAvailable: true });
        expect(nativePlan.evidence).toMatchObject({
            requestedProvider: provider, providerCommand: `/fixture/${provider}`, workspaceDir: paths.workspaceDir,
            image: null, memoryMb: 4096, cpus: 4,
            startCommand: { command: `/fixture/${provider}`, args: start },
            stopCommand: { command: `/fixture/${provider}`, args: ["stop", "instance"] },
            deleteCommand: { command: `/fixture/${provider}`, args: ["delete", "instance"] },
        });
        expect(observationMacosStartArgs(provider, "instance", options)).toEqual(start);
        expect(observationMacosPlan(owned, discovery, "owner", paths)).toEqual(nativePlan.evidence);
    });

    it("redacts SSH secrets in projected devices and public helper plans without changing owned metadata", () => {
        const owned = { ...device, ssh: { host: "guest", user: "ccc", password: "private-password", keyPath: "/private/key" } };
        const { app } = fixture([owned]);
        const projected = app.owned()[0];
        expect(projected.ssh).toEqual({ host: "guest", user: "ccc", keyPath: "/private/key", passwordConfigured: true });
        const publicPlan = app.plan(owned);
        expect(publicPlan.helper).toMatchObject({ bridge: "ssh", status: "ssh-configured", ssh: { host: "guest", user: "ccc", passwordConfigured: true } });
        expect(publicPlan.deferred).toEqual([]);
        expect(JSON.stringify([projected, publicPlan])).not.toContain("private-password");
        expect(owned.ssh.password).toBe("private-password");
    });

    it("returns materialized evidence by identity, without interpreting conflicting native fields", () => {
        const f = fixture();
        const supplied = plan(device, facts([{ name: "tart", command: "/tart" }]));
        const evidence = Object.freeze({ ...supplied.evidence, available: false, startCommand: null, nativeStatus: 19 });
        f.ports.materializePlan = () => ({ ...supplied, evidence });
        expect(createDeviceObservation(f.ports).plan(device)).toBe(evidence);
        expect(evidence).toMatchObject({ available: false, startCommand: null, nativeStatus: 19 });
    });

    it("keeps empty and identity-only owned listings free of discovery and materialization", () => {
        const records = [device];
        const identified = fixture(records);
        expect(identified.app.owned({ identityOnly: true })).toBe(records);
        expect(identified.executable).not.toHaveBeenCalled();
        expect(identified.helperPaths).not.toHaveBeenCalled();
        const empty = fixture();
        expect(empty.app.inventory({ backend: "ios-simulator" })).toBeUndefined();
        expect(empty.app.owned()).toEqual([]);
        expect(empty.executable).not.toHaveBeenCalled();
        expect(empty.helperPaths).not.toHaveBeenCalled();
    });

    it("discovers in configured order, retains empty executable entries and skips other hosts", () => {
        const f = fixture();
        const ports: MacosObservationPorts = { ...f.ports, providerNames: ["vz", "tart", "utmctl"], executable: name => name === "tart" ? "" : name === "vz" ? "/vz" : null };
        expect(createDeviceObservation(ports).discovery()).toEqual({ hostSupported: true, providers: [{ name: "vz", command: "/vz" }, { name: "tart", command: "" }], available: true, missing: [] });
        expect(createDeviceObservation({ ...ports, executable: () => null }).discovery()).toEqual({ hostSupported: true, providers: [], available: false, missing: ["macos-vm-provider"] });
        ports.platform = () => "linux";
        ports.executable = () => { throw new Error("A non-macOS host must not discover providers"); };
        expect(createDeviceObservation(ports).discovery()).toEqual({ hostSupported: false, providers: [], available: false, missing: ["macos-host"] });
    });
});

describe("actual macOS backend native recipe binding", () => {
    let home: string;
    let restore: () => void;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ccc-macos-observation-"));
        restore = isolateDeviceLabTestEnvironment(home);
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        native.records = [];
        native.executables.clear();
        native.executables.set("tart", "/fixture/tart");
        native.executables.set("vz", "/fixture/vz");
        native.executables.set("utmctl", "/fixture/utmctl");
        native.spawn.mockClear(); native.run.mockClear();
        native.timed.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); restore(); rmSync(home, { recursive: true, force: true }); });

    it("lists inventory and identities without starting, listing or probing provider features", async () => {
        expect(backend.listMacosDevices()).toEqual([]);
        native.records = [device];
        expect(backend.listMacosDevices({ identityOnly: true })).toBe(native.records);
        native.records = [];
        const reply = await backend.handleMacosTool("device_inventory", { backend: "macos-vm" });
        expect(reply?.isError).not.toBe(true);
        const value = JSON.parse((reply!.content as Array<{ text: string }>)[0].text);
        expect(value).toMatchObject({ devices: [], hostVms: { lazy: true, available: true } });
        expect(value.discovery.providers.map((provider: { name: string }) => provider.name)).toEqual(["tart", "vz", "utmctl"]);
        expect(native.run).not.toHaveBeenCalled(); expect(native.timed).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });

    it.each([false, true])("uses default-on supported softnet independently of headless=%s", headless => {
        const owned = { ...device, provider: "tart", headless };
        const command = `/fixture/tart-default-${headless}`;
        const nativePlan = plan(owned, facts([{ name: "tart", command }]));
        expect(nativePlan.evidence.startCommand?.args).toEqual(["run", ...(headless ? ["--no-graphics"] : []), "ccc-owner-owned"]);
        native.timed.mockReturnValue({ status: 0, stdout: "--with-softnet", stderr: "" });
        const launched = launch(nativePlan, owned);
        expect(launched.startCommand).toEqual({ command, args: ["run", "--with-softnet", ...(headless ? ["--no-graphics"] : []), "ccc-owner-owned"] });
        expect(native.timed).toHaveBeenCalledExactlyOnceWith(command, ["run", "--help"], 5000);
        expect(native.spawn).toHaveBeenCalledWith(command, (launched.startCommand as { args: string[] }).args, expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }));
    });

    it("short-circuits feature detection for explicit softnet:false while preserving headless", () => {
        const owned = { ...device, provider: "tart", softnet: false, headless: true };
        const nativePlan = plan(owned, facts([{ name: "tart", command: "/fixture/tart-no-softnet" }]));
        expect(launch(nativePlan, owned).startCommand).toEqual({ command: "/fixture/tart-no-softnet", args: ["run", "--no-graphics", "ccc-owner-owned"] });
        expect(native.timed).not.toHaveBeenCalled();
    });

    it.each([
        { label: "stderr", status: 0, stdout: "", stderr: "supports --with-softnet", supported: true },
        { label: "failed-help", status: 1, stdout: "--with-softnet", stderr: "", supported: false },
        { label: "split-across-streams", status: 0, stdout: "--with-", stderr: "softnet", supported: false },
    ])("retains the status and newline-delimited feature result for $label", ({ label, status, stdout, stderr, supported }) => {
        const command = `/fixture/tart-${label}`;
        native.timed.mockReturnValue({ status, stdout, stderr });
        const launched = launch(plan(device, facts([{ name: "tart", command }])), device);
        expect((launched.startCommand as { args: string[] }).args).toEqual(["run", ...(supported ? ["--with-softnet"] : []), "ccc-owner-owned"]);
    });

    it("reuses a cached false result and probes a different command independently", () => {
        const first = plan(device, facts([{ name: "tart", command: "/fixture/tart-cache-false" }]));
        expect((launch(first, device).startCommand as { args: string[] }).args).toEqual(["run", "ccc-owner-owned"]);
        native.timed.mockReturnValue({ status: 0, stdout: "--with-softnet", stderr: "" });
        expect((launch(first, device).startCommand as { args: string[] }).args).toEqual(["run", "ccc-owner-owned"]);
        expect(native.timed).toHaveBeenCalledTimes(1);
        const second = plan(device, facts([{ name: "tart", command: "/fixture/tart-cache-other" }]));
        expect((launch(second, device).startCommand as { args: string[] }).args).toEqual(["run", "--with-softnet", "ccc-owner-owned"]);
        expect(native.timed).toHaveBeenCalledTimes(2);
    });

    it.each(["vz", "utmctl"])("uses %s native start, stop and delete without a Tart probe", provider => {
        const owned = { ...device, provider, providerInstance: "native-instance", headless: true, softnet: true };
        const command = `/fixture/${provider}`;
        const nativePlan = plan(owned, facts([{ name: provider, command }]));
        expect(launch(nativePlan, owned).startCommand).toEqual({ command, args: ["start", "native-instance"] });
        expect(native.stop!(nativePlan).ok).toBe(true);
        expect(native.remove!(nativePlan, "delete-instance").ok).toBe(true);
        expect(native.timed.mock.calls).toEqual([[command, ["stop", "native-instance"], 60000], [command, ["delete", "delete-instance"], 60000]]);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith(command, ["start", "native-instance"], expect.objectContaining({ windowsHide: true }));
    });

    it.each([0, -1, 0.9, Number.NaN, Number.POSITIVE_INFINITY])("refuses native preparation and spawn for invalid allowance %s", remaining => {
        const nativePlan = plan(device, facts([{ name: "tart", command: `/fixture/tart-invalid-${remaining}` }]));
        expect(native.launch!(nativePlan, device, { remainingMs: () => remaining })).toBeNull();
        expect(native.timed).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });

    it("floors the feature-help timeout and refuses spawn when preparation consumes the remainder", () => {
        let remaining = 37.9;
        const command = "/fixture/tart-late-help", nativePlan = plan(device, facts([{ name: "tart", command }]));
        native.timed.mockImplementation(() => { remaining = 0; return { status: 0, stdout: "--with-softnet", stderr: "" }; });
        expect(native.launch!(nativePlan, device, { remainingMs: () => remaining })).toBeNull();
        expect(native.timed).toHaveBeenCalledExactlyOnceWith(command, ["run", "--help"], 37);
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("checks the budget even when the feature result is already cached", () => {
        const nativePlan = plan(device, facts([{ name: "tart", command: "/fixture/tart-budget-cache" }]));
        launch(nativePlan, device);
        native.spawn.mockClear(); native.timed.mockClear();
        expect(native.launch!(nativePlan, device, { remainingMs: () => 0 })).toBeNull();
        expect(native.timed).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });

    it.each([100, 1000])("caps provider settling by the relative remainder and its retained 200ms limit: %s", async remaining => {
        vi.useFakeTimers();
        const child = Object.assign(new EventEmitter(), { pid: 71, unref() {} });
        const budget = { remainingMs: () => remaining };
        native.spawn.mockReturnValueOnce(child);
        const nativePlan = plan(device, facts([{ name: "tart", command: `/fixture/tart-settle-${remaining}` }]));
        expect(launch(nativePlan, device, budget).child).toBe(child);
        let settled = false;
        const pending = native.settle!(budget).then(() => { settled = true; });
        const cap = Math.min(200, remaining);
        await vi.advanceTimersByTimeAsync(cap - 1); expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
        await pending;
    });
});
