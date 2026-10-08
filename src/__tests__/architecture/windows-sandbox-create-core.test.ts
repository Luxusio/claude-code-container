import { describe, expect, it } from "vitest";
import { createWindowsSandboxCreate } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-create.mjs";
import type { WindowsSandboxCreatePorts } from "../../../packages/device-lab/providers/ports/lifecycle/windows-sandbox-create.mjs";
import { createBrokerWindowsSandboxCreate } from "../../../packages/device-lab/src/device-lab/application/lifecycle/windows-sandbox-create.js";
import { retainAfterWindowsConfigFailure } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-create.js";
import type { BrokerWindowsSandboxCreatePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/windows-sandbox-create.js";

function fixture() {
    const trace: string[] = []; const files: string[] = []; let tick = 0;
    const ports: WindowsSandboxCreatePorts<{ scratch: string }> = {
        deriveDeviceId: () => { trace.push("derive"); return "sandbox"; },
        readDefinitions: () => { trace.push("read"); return []; },
        readOwnerId: () => { trace.push("owner"); return "owner"; },
        ensureHelperWorkspace: ({ id }) => { trace.push("helper"); files.push(String(id)); return { scratch: "private" }; },
        wallTimestamp: () => { trace.push("clock"); return `tick-${++tick}`; },
        claimDefinition: () => { trace.push("claim"); return { ok: true }; },
    };
    return { trace, files, ports, app: createWindowsSandboxCreate(ports) };
}
const input = { backend: "windows-sandbox", name: "Sandbox" };
describe("direct synchronous Sandbox create policy", () => {
    it("constructs without effects and assembles the record before claim", () => {
        const f = fixture(); expect(f.trace).toEqual([]);
        const result = f.app.create(input); expect(result).not.toBeInstanceOf(Promise);
        expect(result).toMatchObject({ kind: "created", device: { id: "sandbox", ownerId: "owner", status: "stopped", memoryMb: 4096, minimized: true, createdAt: "tick-1", updatedAt: "tick-2" } });
        expect(f.trace).toEqual(["derive", "read", "owner", "helper", "clock", "clock", "claim"]);
    });
    it("skips other backends and refuses duplicate before helper effects", () => {
        const f = fixture(); expect(f.app.create({ backend: "container" })).toEqual({ kind: "skipped" }); expect(f.trace).toEqual([]);
        f.ports.readDefinitions = () => { f.trace.push("read"); return [{ id: "sandbox" }]; };
        expect(f.app.create(input)).toEqual({ kind: "duplicate", id: "sandbox" }); expect(f.trace).toEqual(["derive", "read"]); expect(f.files).toEqual([]);
    });
    it.each([null, "raw", Infinity, 0])("retains direct raw memory %j and Boolean/minimized rules", memoryMb => {
        const f = fixture(); const result = f.app.create({ ...input, deviceId: "explicit", memoryMb, networking: "truthy", clipboard: 0, vgpu: {}, minimized: null });
        expect(result).toMatchObject({ kind: "created", device: { id: "explicit", memoryMb, networking: true, clipboard: false, vgpu: true, minimized: true } }); expect(f.trace).not.toContain("derive");
    });
    it("retains helper artifacts on claim conflict", () => {
        const f = fixture(); f.ports.claimDefinition = () => { f.trace.push("claim"); return { ok: false, field: "id", value: "sandbox" }; };
        expect(f.app.create(input)).toEqual({ kind: "claim-conflict", field: "id", value: "sandbox" }); expect(f.files).toEqual(["sandbox"]);
    });
    it.each(["deriveDeviceId", "readDefinitions", "readOwnerId", "ensureHelperWorkspace", "wallTimestamp", "claimDefinition"] as const)("preserves raw %s throws and stops effects", port => {
        const f = fixture(); const fault = { port }; f.ports[port] = (() => { f.trace.push(`throw:${port}`); throw fault; });
        let caught: unknown; try { f.app.create(input); } catch (error) { caught = error; }
        expect(caught).toBe(fault); expect(f.trace.at(-1)).toBe(`throw:${port}`);
        if (port === "claimDefinition" || port === "wallTimestamp") expect(f.files).toEqual(["sandbox"]);
    });
    it.each(["deriveDeviceId", "readDefinitions", "readOwnerId", "ensureHelperWorkspace", "wallTimestamp", "claimDefinition"] as const)("requires semantic port %s", port => {
        const f = fixture(); const missing = { ...f.ports, [port]: undefined }; expect(() => createWindowsSandboxCreate(missing as unknown as typeof f.ports)).toThrow(`requires ${port}`);
    });
});

function brokerFixture(mode = "success") {
    const trace: string[] = []; const fault = { mode }; const device = { id: "sandbox", createdAt: "generation" }; const files: string[] = [];
    let records = [device, { id: "sandbox", createdAt: "successor" }];
    const ports: BrokerWindowsSandboxCreatePorts<{ name: string }, typeof device, { ok: boolean; evidence: string }> = {
        createRecord: () => { trace.push("record"); if (mode === "record-throw") throw fault; return device; },
        claimDefinition: () => { trace.push("claim"); if (["claim-throw", "rollback-throw", "rollback-false"].includes(mode)) throw fault; return mode === "conflict" ? { ok: false, error: "conflict", field: "id", value: "sandbox", existing: records[1] } : { ok: true }; },
        rollbackAfterClaimFailure: async (_device, existing) => { trace.push(existing ? "rollback:existing" : "rollback:null"); if (mode === "rollback-throw") throw fault; return { ok: mode !== "rollback-false", evidence: "opaque" }; },
        publishConfig: () => { trace.push("config"); files.push("partial-helper"); if (["config-throw", "mutation-throw"].includes(mode)) throw fault; return "/private/config"; },
        removeMatchingClaim: (id, createdAt) => { trace.push("mutate"); if (mode === "mutation-throw") throw fault; records = records.filter(candidate => retainAfterWindowsConfigFailure(candidate, id, createdAt)); return records; },
        stateErrorCode: () => { trace.push("state-code"); return null; },
    };
    return { app: createBrokerWindowsSandboxCreate(ports), trace, fault, files, records: () => records };
}
describe("asynchronous broker Sandbox create transaction", () => {
    it("claims before native config and does nothing during construction", async () => { const f = brokerFixture(); expect(f.trace).toEqual([]); const result = f.app.create({ name: "Sandbox" }); expect(result).toBeInstanceOf(Promise); expect(await result).toMatchObject({ kind: "created" }); expect(f.trace).toEqual(["record", "claim", "config"]); });
    it.each(["claim-throw", "conflict", "rollback-false"])("keeps rollback evidence and skips config on %s", async mode => { const f = brokerFixture(mode); const result = await f.app.create({ name: "Sandbox" }); expect(result.kind).toBe(mode === "conflict" ? "claim-conflict" : "claim-exception"); if (result.kind === "claim-exception") expect(result.error).toBe(f.fault); expect(f.trace).not.toContain("config"); expect(f.trace).toContain(mode === "conflict" ? "rollback:existing" : "rollback:null"); if (mode === "rollback-false") expect(result).toMatchObject({ stateCode: "owner-state-write-failed" }); });
    it("removes only original generation and retains partial files after config fault", async () => { const f = brokerFixture("config-throw"); expect(await f.app.create({ name: "Sandbox" })).toEqual({ kind: "config-failure", error: f.fault }); expect(f.trace).toEqual(["record", "claim", "config", "mutate"]); expect(f.records()).toEqual([{ id: "sandbox", createdAt: "successor" }]); expect(f.files).toEqual(["partial-helper"]); });
    it.each(["record-throw", "rollback-throw", "mutation-throw"])("preserves raw %s at its existing boundary", async mode => { const f = brokerFixture(mode); await expect(f.app.create({ name: "Sandbox" })).rejects.toBe(f.fault); if (mode === "mutation-throw") { expect(f.records()).toHaveLength(2); expect(f.files).toEqual(["partial-helper"]); } });
    it("retains malformed records and other identities during compensation", () => { for (const value of [null, undefined, false, 0, "raw", {}, { id: "other", createdAt: "generation" }, { id: "sandbox", createdAt: "successor" }]) expect(retainAfterWindowsConfigFailure(value, "sandbox", "generation")).toBe(true); expect(retainAfterWindowsConfigFailure({ id: "sandbox", createdAt: "generation" }, "sandbox", "generation")).toBe(false); });
});
