import { describe, expect, it, vi } from "vitest";
import { createLabStateOwnershipPreparation } from "../../application/container/lab-state-ownership.js";
import type {
    LabOwnershipHelperScope, LabStateCommandObservation, LabStateOwnershipObservation, LabStatePrincipal,
} from "../../domain/container/lab-state-ownership.js";
import type { LabStateOwnershipPorts } from "../../ports/container/lab-state-ownership.js";

const volume = "ccc-example-lab-state";
const principal = { uid: 2001, gid: 3001 };
const ok = (stdout = ""): LabStateCommandObservation => ({ status: 0, stdout });
function fixture() {
    const scope = Object.freeze({}) as LabOwnershipHelperScope;
    const trace: unknown[][] = [];
    const ports: LabStateOwnershipPorts = {
        normalizeImageId: vi.fn(image => { trace.push(["normalize", image]); return `normalized:${image}`; }),
        listVolumeNames: vi.fn(() => { trace.push(["list"]); return ok(volume + "\n"); }),
        observeVolumeUsers: vi.fn(selected => { trace.push(["users", selected]); return ok(); }),
        captureHelperScope: vi.fn(() => { trace.push(["capture"]); return scope; }),
        observePreviousAccount: vi.fn((selected, image) => { trace.push(["account", selected, image]); return ok("1001:1002"); }),
        applyOwnership: vi.fn((selected, name, image, identity, intent) => { trace.push(["apply", selected, name, image, identity, intent]); return { status: 0 }; }),
    };
    return { ports, scope, trace, app: createLabStateOwnershipPreparation(ports) };
}
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}
function observationFault(trace: unknown[][], field: "error" | "status" | "stdout", failure: unknown): LabStateCommandObservation {
    return {
        get error() { trace.push(["error"]); if (field === "error") throw failure; return undefined; },
        get status() { trace.push(["status"]); if (field === "status") throw failure; return 0; },
        get stdout() { trace.push(["stdout"]); if (field === "stdout") throw failure; return ""; },
    };
}

describe("Lab ownership inward policy", () => {
    it("keeps exact normalization, observations, one shared scope and original principal", () => {
        const f = fixture();
        expect(f.app.run(volume, "current", principal, "previous")).toBeUndefined();
        expect(f.trace).toEqual([
            ["normalize", "current"], ["normalize", "previous"], ["list"], ["users", volume], ["capture"],
            ["account", f.scope, "normalized:previous"],
            ["apply", f.scope, volume, "normalized:current", principal, { kind: "migrate", oldUid: 1001, oldGid: 1002 }],
        ]);
        expect(vi.mocked(f.ports.applyOwnership).mock.calls[0][3]).toBe(principal);
    });
    it.each([undefined, ""])("requires only root verification with previous %s", previous => {
        const f = fixture();
        expect(f.app.run(volume, "current", principal, previous)).toBeUndefined();
        expect(f.ports.normalizeImageId).toHaveBeenCalledOnce();
        expect(f.ports.observePreviousAccount).not.toHaveBeenCalled();
        expect(f.ports.applyOwnership).toHaveBeenCalledWith(f.scope, volume, "normalized:current", principal, { kind: "verify" });
    });
    it.each(["", "-leading", "x,target=/host", "/outside", "has space"])("rejects name %s before even normalization", name => {
        const f = fixture();
        expect(() => f.app.run(name, "current", principal, "previous")).toThrow("Invalid lab state volume name.");
        expect(f.trace).toEqual([]);
    });
    it("keeps regex coercion followed by exact list identity for trusted unusual callers", () => {
        const f = fixture();
        const name = { toString: vi.fn(() => volume) } as unknown as string;
        expect(f.app.run(name, "current", principal)).toBeUndefined();
        expect((name as unknown as { toString: ReturnType<typeof vi.fn> }).toString).toHaveBeenCalledOnce();
        expect(f.trace).toEqual([["normalize", "current"], ["list"]]);
    });
    it.each(["current", "previous"])("propagates %s normalization failure without later observations", target => {
        const f = fixture(), failure = Object.freeze({ failure: target });
        f.ports.normalizeImageId = vi.fn(image => { f.trace.push(["normalize", image]); if (image === target) throw failure; return image; });
        expect(thrown(() => f.app.run(volume, "current", principal, "previous"))).toBe(failure);
        expect(f.trace).toEqual(target === "current" ? [["normalize", "current"]] : [["normalize", "current"], ["normalize", "previous"]]);
    });
    it.each(["", volume + "\r\n", " " + volume + "\n", volume + "-other\n", volume.toUpperCase() + "\n"])("does not create an absent exact listed name %j", names => {
        const f = fixture();
        f.ports.listVolumeNames = vi.fn(() => ok(names));
        expect(f.app.run(volume, "current", principal)).toBeUndefined();
        expect(f.ports.observeVolumeUsers).not.toHaveBeenCalled();
        expect(f.ports.captureHelperScope).not.toHaveBeenCalled();
        expect(f.ports.applyOwnership).not.toHaveBeenCalled();
    });
    it.each(["before\n" + volume + "\nafter", volume, "\n" + volume + "\n"])("accepts exact listed name in %j", names => {
        const f = fixture(); f.ports.listVolumeNames = vi.fn(() => ok(names));
        f.app.run(volume, "current", principal);
        expect(f.ports.applyOwnership).toHaveBeenCalledOnce();
    });
    it.each(["list", "users", "account"] as const)("short-circuits %s error before status/output", stage => {
        const f = fixture(), reads: string[] = [];
        const result = { get error() { reads.push("error"); return { code: "unknown" }; }, get status() { throw new Error("status must not be observed"); }, get stdout() { throw new Error("stdout must not be observed"); } };
        if (stage === "list") f.ports.listVolumeNames = () => result;
        if (stage === "users") f.ports.observeVolumeUsers = () => result;
        if (stage === "account") f.ports.observePreviousAccount = () => result;
        expect(() => f.app.run(volume, "current", principal, "previous")).toThrow(stage === "list" ? "Unable to inspect lab state volumes." : stage === "users" ? "may be in use" : "Cannot establish previous lab state owner");
        expect(reads).toEqual(["error"]);
        expect(f.ports.applyOwnership).not.toHaveBeenCalled();
    });
    it.each([null, 1, 124, 137])( "rejects list status %s before reading output", status => {
        const f = fixture();
        f.ports.listVolumeNames = () => ({ status, get stdout() { throw new Error("must not observe stdout"); } });
        expect(() => f.app.run(volume, "current", principal)).toThrow("Unable to inspect lab state volumes.");
        expect(f.ports.observeVolumeUsers).not.toHaveBeenCalled();
    });
    it.each([null, 1, 124, 137])("rejects user status %s before output/capture", status => {
        const f = fixture();
        f.ports.observeVolumeUsers = () => ({ status, get stdout() { throw new Error("must not observe stdout"); } });
        expect(() => f.app.run(volume, "current", principal)).toThrow("may be in use");
        expect(f.ports.captureHelperScope).not.toHaveBeenCalled();
    });
    it.each(["running", "\ncontainer \n"])("refuses actual volume users %j before capturing scope", users => {
        const f = fixture(); f.ports.observeVolumeUsers = () => ok(users);
        expect(() => f.app.run(volume, "current", principal)).toThrow("may be in use");
        expect(f.ports.captureHelperScope).not.toHaveBeenCalled();
    });
    it("accepts whitespace-only users without normalizing the volume listing", () => {
        const f = fixture(); f.ports.observeVolumeUsers = () => ok(" \r\n\t");
        f.app.run(volume, "current", principal);
        expect(f.ports.applyOwnership).toHaveBeenCalledOnce();
    });
    it.each(["list", "users", "account"] as const)("preserves thrown %s observation getters", stage => {
        for (const field of ["error", "status", "stdout"] as const) {
            const f = fixture(), failure = Symbol(stage + field), reads: unknown[][] = [];
            const result = observationFault(reads, field, failure);
            if (stage === "list") f.ports.listVolumeNames = () => result;
            if (stage === "users") f.ports.observeVolumeUsers = () => result;
            if (stage === "account") f.ports.observePreviousAccount = () => result;
            expect(thrown(() => f.app.run(volume, "current", principal, "previous"))).toBe(failure);
            expect(reads).toEqual(["error", "status", "stdout"].slice(0, ["error", "status", "stdout"].indexOf(field) + 1).map(name => [name]));
            expect(f.ports.applyOwnership).not.toHaveBeenCalled();
        }
    });
    it("captures once before principal reads and does not reread captured principal defaults", () => {
        const f = fixture();
        const identity = { get uid() { f.trace.push(["uid"]); return 2001; }, get gid() { f.trace.push(["gid"]); return 3001; } };
        f.app.run(volume, "current", identity, "previous");
        expect(f.trace.slice(3, 8)).toEqual([["users", volume], ["capture"], ["uid"], ["gid"], ["account", f.scope, "normalized:previous"]]);
        expect(f.ports.captureHelperScope).toHaveBeenCalledOnce();
        expect(vi.mocked(f.ports.applyOwnership).mock.calls[0][3]).toBe(identity);
    });
    it.each(["capture", "uid", "gid", "account", "apply"])("preserves thrown %s primitive and prevents successor effects", stage => {
        const f = fixture(), failure = Object.freeze({ stage });
        const identity: LabStatePrincipal = { get uid() { if (stage === "uid") throw failure; return 2001; }, get gid() { if (stage === "gid") throw failure; return 3001; } };
        if (stage === "capture") f.ports.captureHelperScope = () => { throw failure; };
        if (stage === "account") f.ports.observePreviousAccount = () => { throw failure; };
        if (stage === "apply") f.ports.applyOwnership = vi.fn(() => { throw failure; });
        expect(thrown(() => f.app.run(volume, "current", identity, "previous"))).toBe(failure);
        if (stage !== "apply") expect(f.ports.applyOwnership).not.toHaveBeenCalled();
        if (["capture", "uid", "gid"].includes(stage)) expect(f.ports.observePreviousAccount).not.toHaveBeenCalled();
    });
    it.each(["0:1001", "1001:0", "4294967295:1001", "1001:4294967295", "4294967296:1", "1:4294967296", "bad", "1:2\nextra", "-1:2", "1.5:2"])("refuses old account %j without ownership writes", output => {
        const f = fixture(); f.ports.observePreviousAccount = () => ok(output);
        expect(() => f.app.run(volume, "current", principal, "previous")).toThrow("Cannot establish previous lab state owner");
        expect(f.ports.applyOwnership).not.toHaveBeenCalled();
    });
    it.each([" 00001:00002\n", "4294967294:4294967294", "2001:3001"])("retains valid prior principal %j and still migrates matched owners", output => {
        const f = fixture(); f.ports.observePreviousAccount = () => ok(output);
        f.app.run(volume, "current", principal, "previous");
        const [uid, gid] = output.trim().split(":").map(Number);
        expect(f.ports.applyOwnership).toHaveBeenCalledWith(f.scope, volume, "normalized:current", principal, { kind: "migrate", oldUid: uid, oldGid: gid });
    });
    it.each([null, 1, 124, 137])("rejects failed old-account status %s without output or writes", status => {
        const f = fixture(); f.ports.observePreviousAccount = () => ({ status, get stdout() { throw new Error("must not read output"); } });
        expect(() => f.app.run(volume, "current", principal, "previous")).toThrow("Cannot establish previous lab state owner");
        expect(f.ports.applyOwnership).not.toHaveBeenCalled();
    });
    it("consumes final raw error before status, retaining native observation getters", () => {
        const f = fixture(), reads: string[] = [];
        f.ports.applyOwnership = () => ({ get error() { reads.push("error"); return { code: "timeout" }; }, get status() { throw new Error("must not read status"); } });
        expect(() => f.app.run(volume, "current", principal)).toThrow("Existing data was retained; repair its ownership before retrying.");
        expect(reads).toEqual(["error"]);
    });
    it.each([null, 1, 124, 137])("rejects final failed helper status %s", status => {
        const f = fixture(); f.ports.applyOwnership = () => ({ status });
        expect(() => f.app.run(volume, "current", principal)).toThrow("Lab state ownership preparation failed");
    });
    it.each(["error", "status"] as const)("preserves thrown final %s getter identity", field => {
        const f = fixture(), failure = Symbol(field), reads: string[] = [];
        f.ports.applyOwnership = () => ({ get error() { reads.push("error"); if (field === "error") throw failure; return undefined; }, get status() { reads.push("status"); throw failure; } });
        expect(thrown(() => f.app.run(volume, "current", principal))).toBe(failure);
        expect(reads).toEqual(field === "error" ? ["error"] : ["error", "status"]);
    });
    it("keeps primitive method receiver and does not snapshot returned observations", () => {
        const f = fixture();
        for (const name of Object.keys(f.ports) as Array<keyof LabStateOwnershipPorts>) {
            const original = f.ports[name];
            Object.assign(f.ports, { [name]: function (this: unknown, ...args: unknown[]) { expect(this).toBe(f.ports); return Reflect.apply(original, this, args); } });
        }
        f.app.run(volume, "current", principal, "previous");
        expect(f.trace.at(-1)?.[0]).toBe("apply");
    });
    it.each(["normalizeImageId", "listVolumeNames", "observeVolumeUsers", "captureHelperScope", "observePreviousAccount", "applyOwnership"] as const)("refuses noncallable %s without executing primitives", name => {
        const f = fixture();
        expect(() => createLabStateOwnershipPreparation({ ...f.ports, [name]: undefined } as unknown as LabStateOwnershipPorts)).toThrow(`requires a callable ${name} port`);
        expect(f.trace).toEqual([]);
    });
    it("rejects absent port construction without host fallbacks", () => {
        expect(() => createLabStateOwnershipPreparation(undefined as unknown as LabStateOwnershipPorts)).toThrow("requires a callable normalizeImageId port");
    });
    it("relays stdout method failure without catch or later effects", () => {
        for (const stage of ["list", "users", "account"] as const) {
            const f = fixture(), failure = Symbol(stage), output = stage === "list" ? { split() { throw failure; } } : { trim() { throw failure; } };
            const result = { status: 0, stdout: output } as unknown as LabStateCommandObservation;
            if (stage === "list") f.ports.listVolumeNames = () => result;
            if (stage === "users") f.ports.observeVolumeUsers = () => result;
            if (stage === "account") f.ports.observePreviousAccount = () => result;
            expect(thrown(() => f.app.run(volume, "current", principal, "previous"))).toBe(failure);
            expect(f.ports.applyOwnership).not.toHaveBeenCalled();
        }
    });
    it("uses minimal final observation without consulting stdout", () => {
        const f = fixture();
        f.ports.applyOwnership = () => ({ status: 0, get stdout() { throw new Error("unobserved final output"); } } as LabStateOwnershipObservation);
        expect(f.app.run(volume, "current", principal)).toBeUndefined();
    });
});
