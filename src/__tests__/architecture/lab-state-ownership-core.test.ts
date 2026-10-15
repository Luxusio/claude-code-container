import { describe, expect, it, vi } from "vitest";
import { createLabStateOwnershipPreparation } from "../../application/container/lab-state-ownership.js";
import type { LabOwnershipHelperScope } from "../../domain/container/lab-state-ownership.js";
import type { LabStateOwnershipPorts } from "../../ports/container/lab-state-ownership.js";

const volume = "ccc-example-lab-state";
const principal = { uid: 2001, gid: 3001 };
function fixture() {
    const scope = Object.freeze({}) as LabOwnershipHelperScope;
    const trace: unknown[][] = [];
    const ports: LabStateOwnershipPorts = {
        normalizeImageId: vi.fn(image => { trace.push(["normalize", image]); return `normalized:${image}`; }),
        observeVolume: vi.fn(selected => { trace.push(["volume", selected]); return "present" as const; }),
        observeVolumeUsers: vi.fn(selected => { trace.push(["users", selected]); return "idle" as const; }),
        captureHelperScope: vi.fn(() => { trace.push(["capture"]); return scope; }),
        observePreviousAccount: vi.fn((selected, image) => {
            trace.push(["account", selected, image]);
            return { kind: "known" as const, principal: { uid: 1001, gid: 1002 } };
        }),
        applyOwnership: vi.fn((selected, name, image, identity, intent) => {
            trace.push(["apply", selected, name, image, identity, intent]);
            return "applied" as const;
        }),
    };
    return { ports, scope, trace, app: createLabStateOwnershipPreparation(ports) };
}
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}

describe("Lab ownership inward policy", () => {
    it("normalizes both images before observations and migrates using one captured scope", () => {
        const f = fixture();
        expect(f.app.run(volume, "current", principal, "previous")).toBeUndefined();
        expect(f.trace).toEqual([
            ["normalize", "current"], ["normalize", "previous"], ["volume", volume], ["users", volume], ["capture"],
            ["account", f.scope, "normalized:previous"],
            ["apply", f.scope, volume, "normalized:current", principal, { kind: "migrate", oldUid: 1001, oldGid: 1002 }],
        ]);
        expect(f.ports.captureHelperScope).toHaveBeenCalledOnce();
        expect(vi.mocked(f.ports.applyOwnership).mock.calls[0][3]).toBe(principal);
    });
    it.each([undefined, ""])("requires only root verification with previous %s", previous => {
        const f = fixture();
        expect(f.app.run(volume, "current", principal, previous)).toBeUndefined();
        expect(f.ports.normalizeImageId).toHaveBeenCalledOnce();
        expect(f.ports.observePreviousAccount).not.toHaveBeenCalled();
        expect(f.ports.applyOwnership).toHaveBeenCalledWith(f.scope, volume, "normalized:current", principal, { kind: "verify" });
    });
    it.each(["", "-leading", "x,target=/host", "/outside", "has space"])("rejects volume name %s before normalization or native effects", name => {
        const f = fixture();
        expect(() => f.app.run(name, "current", principal, "previous")).toThrow("Invalid lab state volume name.");
        expect(f.trace).toEqual([]);
    });
    it.each(["current", "previous"])("propagates %s normalization failure before observations", target => {
        const f = fixture(), failure = Object.freeze({ failure: target });
        f.ports.normalizeImageId = vi.fn(image => { f.trace.push(["normalize", image]); if (image === target) throw failure; return image; });
        expect(thrown(() => f.app.run(volume, "current", principal, "previous"))).toBe(failure);
        expect(f.trace).toEqual(target === "current" ? [["normalize", "current"]] : [["normalize", "current"], ["normalize", "previous"]]);
    });
    it("does not create or probe an absent volume", () => {
        const f = fixture();
        f.ports.observeVolume = vi.fn(() => "absent" as const);
        expect(f.app.run(volume, "current", principal, "previous")).toBeUndefined();
        expect(f.ports.observeVolume).toHaveBeenCalledWith(volume);
        expect(f.ports.observeVolumeUsers).not.toHaveBeenCalled();
        expect(f.ports.captureHelperScope).not.toHaveBeenCalled();
        expect(f.ports.observePreviousAccount).not.toHaveBeenCalled();
        expect(f.ports.applyOwnership).not.toHaveBeenCalled();
    });
    it("refuses unavailable volume inspection instead of treating it as absence", () => {
        const f = fixture();
        f.ports.observeVolume = vi.fn(() => "unavailable" as const);
        expect(() => f.app.run(volume, "current", principal)).toThrow("Unable to inspect lab state volumes.");
        expect(f.ports.observeVolume).toHaveBeenCalledOnce();
        expect(f.ports.observeVolumeUsers).not.toHaveBeenCalled();
        expect(f.ports.captureHelperScope).not.toHaveBeenCalled();
    });
    it.each(["in-use", "unavailable"] as const)("refuses %s volume users before capturing authority", users => {
        const f = fixture();
        f.ports.observeVolumeUsers = vi.fn(() => users);
        expect(() => f.app.run(volume, "current", principal, "previous")).toThrow("may be in use");
        expect(f.ports.observeVolumeUsers).toHaveBeenCalledWith(volume);
        expect(f.ports.captureHelperScope).not.toHaveBeenCalled();
        expect(f.ports.applyOwnership).not.toHaveBeenCalled();
    });
    it("refuses unavailable prior ownership without mutation or fallback to the current owner", () => {
        const f = fixture();
        f.ports.observePreviousAccount = vi.fn(() => ({ kind: "unavailable" as const }));
        expect(() => f.app.run(volume, "current", principal, "previous")).toThrow("Cannot establish previous lab state owner");
        expect(f.ports.observePreviousAccount).toHaveBeenCalledOnce();
        expect(f.ports.applyOwnership).not.toHaveBeenCalled();
    });
    it("still migrates when the proven previous principal equals the current principal", () => {
        const f = fixture();
        f.ports.observePreviousAccount = () => ({ kind: "known", principal });
        f.app.run(volume, "current", principal, "previous");
        expect(f.ports.applyOwnership).toHaveBeenCalledWith(f.scope, volume, "normalized:current", principal, { kind: "migrate", oldUid: principal.uid, oldGid: principal.gid });
    });
    it.each([undefined, "previous"])("refuses unconfirmed ownership with previous %s without replay", previous => {
        const f = fixture();
        f.ports.applyOwnership = vi.fn(() => "unconfirmed" as const);
        expect(() => f.app.run(volume, "current", principal, previous)).toThrow(`Lab state ownership preparation failed for ${volume}. Existing data was retained; repair its ownership before retrying.`);
        expect(f.ports.captureHelperScope).toHaveBeenCalledOnce();
        expect(f.ports.applyOwnership).toHaveBeenCalledOnce();
    });
    it.each(["volume", "users", "capture", "account", "apply"] as const)("propagates a thrown %s primitive and prevents successor effects", stage => {
        const f = fixture(), failure = Object.freeze({ stage });
        if (stage === "volume") f.ports.observeVolume = () => { throw failure; };
        if (stage === "users") f.ports.observeVolumeUsers = () => { throw failure; };
        if (stage === "capture") f.ports.captureHelperScope = () => { throw failure; };
        if (stage === "account") f.ports.observePreviousAccount = () => { throw failure; };
        if (stage === "apply") f.ports.applyOwnership = vi.fn(() => { throw failure; });
        expect(thrown(() => f.app.run(volume, "current", principal, "previous"))).toBe(failure);
        if (stage !== "apply") expect(f.ports.applyOwnership).not.toHaveBeenCalled();
        if (["volume", "users", "capture"].includes(stage)) expect(f.ports.observePreviousAccount).not.toHaveBeenCalled();
    });
    it.each(["normalizeImageId", "observeVolume", "observeVolumeUsers", "captureHelperScope", "observePreviousAccount", "applyOwnership"] as const)("refuses noncallable %s without executing primitives", name => {
        const f = fixture();
        expect(() => createLabStateOwnershipPreparation({ ...f.ports, [name]: undefined } as unknown as LabStateOwnershipPorts)).toThrow(`requires a callable ${name} port`);
        expect(f.trace).toEqual([]);
    });
    it("rejects absent port construction without host fallbacks", () => {
        expect(() => createLabStateOwnershipPreparation(undefined as unknown as LabStateOwnershipPorts)).toThrow("requires a callable normalizeImageId port");
    });
});
