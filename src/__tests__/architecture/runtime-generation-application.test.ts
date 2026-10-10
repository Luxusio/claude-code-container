import { describe, expect, it } from "vitest";
import { createRuntimeGenerationTransitions } from "../../../packages/device-lab/providers/application/runtime-generation.mjs";
import type { GenerationRecord, RuntimeGenerationPorts } from "../../../packages/device-lab/providers/ports/runtime-generation.mjs";

function fixture(initial: GenerationRecord | null = { id: "target", recording: { runtimeId: "old" }, appium: { runtimeId: "old" }, unrelated: 42 }) {
    let device = initial;
    const trace: string[] = [];
    const ports: RuntimeGenerationPorts = {
        updateDevice: (id, updater) => {
            trace.push(`update:${String(id)}`);
            if (device === null) return null;
            trace.push("callback");
            device = updater(device);
            return device;
        },
        newRuntimeId: () => { trace.push("uuid"); return "new-runtime"; },
    };
    return { ports, trace, transitions: createRuntimeGenerationTransitions(ports), device: () => device };
}

function throwsSame(operation: () => unknown, expected: Error) {
    try { operation(); throw new Error("expected operation failure"); }
    catch (error) { expect(error).toBe(expected); }
}

describe("auxiliary transitions with explicit mutation and entropy ports", () => {
    it.each(["updateDevice", "newRuntimeId"] as const)("requires the %s function port before effects", name => {
        const f = fixture();
        const { [name]: omitted, ...missing } = f.ports;
        void omitted;
        expect(() => createRuntimeGenerationTransitions(missing as RuntimeGenerationPorts)).toThrow(TypeError);
        expect(() => createRuntimeGenerationTransitions({ ...f.ports, [name]: null } as unknown as RuntimeGenerationPorts)).toThrow(TypeError);
        expect(f.trace).toEqual([]);
    });

    for (const [method, field] of [
        ["transitionRecordingGeneration", "recording"],
        ["transitionAppiumGeneration", "appium"],
    ] as const) {
        it(`${field}: leaves missing targets to the updater without inventing commitment`, () => {
            const f = fixture(null);
            expect(f.transitions[method]("missing", null, {}, "stamp")).toEqual({ committed: false, device: null });
            expect(f.trace).toEqual(["update:missing"]);
        });

        it(`${field}: preserves the exact successor on mismatch`, () => {
            const successor = { id: "target", [field]: { runtimeId: "successor" } };
            const f = fixture(successor);
            const result = f.transitions[method]("target", { runtimeId: "old" }, null, "stamp");
            expect(result).toEqual({ committed: false, device: successor });
            expect(result.device).toBe(successor);
            expect(f.device()).toBe(successor);
            expect(f.trace).toEqual(["update:target", "callback"]);
        });

        it(`${field}: commits replacement while retaining unrelated fields and explicit time`, () => {
            const f = fixture();
            const replacement = { runtimeId: "new" };
            const result = f.transitions[method]("target", { runtimeId: "old" }, replacement, null);
            expect(result.committed).toBe(true);
            expect(result.device?.[field]).toBe(replacement);
            expect(result.device?.unrelated).toBe(42);
            expect(result.device?.updatedAt).toBeNull();
            expect(result.device).toBe(f.device());
            expect(f.trace).toEqual(["update:target", "callback"]);
        });

        it(`${field}: returns the actual updater result instead of its proposed record`, () => {
            const f = fixture();
            const receipt = { id: "observed-publication" };
            f.ports.updateDevice = (_id, updater) => { updater({ id: "target", [field]: null }); return receipt; };
            expect(f.transitions[method]("target", null, {}, "stamp")).toEqual({ committed: true, device: receipt });
            expect(f.transitions[method]("target", null, {}, "stamp").device).toBe(receipt);
        });

        it(`${field}: propagates updater and current-record failures unchanged`, () => {
            const f = fixture();
            const fault = new Error("updater failed");
            f.ports.updateDevice = () => { f.trace.push("failed-update"); throw fault; };
            throwsSame(() => f.transitions[method]("target", null, {}, "stamp"), fault);
            expect(f.trace).toEqual(["failed-update"]);
            f.ports.updateDevice = (_id, updater) => updater({ get [field]() { throw fault; } });
            throwsSame(() => f.transitions[method]("target", null, {}, "stamp"), fault);
            f.ports.updateDevice = (_id, updater) => updater({ [field]: null, get unrelated() { throw fault; } });
            throwsSame(() => f.transitions[method]("target", null, {}, "stamp"), fault);
        });
    }

    it.each([null, undefined, false, 0, "value", [], () => undefined])("finalization refuses malformed expected %s without effects", expected => {
        const f = fixture();
        expect(f.transitions.claimRecordingFinalization("target", expected, {}, "stamp")).toEqual({ committed: false, device: null });
        expect(f.trace).toEqual([]);
    });

    it("finalization forces fields after overrides and uses original recorder identity", () => {
        const previous = { runtimeId: "old", recorderRuntimeId: "original-recorder", active: true, localPath: "before" };
        const f = fixture({ id: "target", recording: previous });
        const result = f.transitions.claimRecordingFinalization("target", previous, {
            runtimeId: "override", recorderRuntimeId: "override", active: true, finalizingAt: "override", localPath: "after",
        }, "stamp");
        expect(result).toEqual({ committed: true, device: {
            id: "target", updatedAt: "stamp", recording: {
                runtimeId: "new-runtime", recorderRuntimeId: "original-recorder", active: false, finalizingAt: "stamp", localPath: "after",
            },
        } });
        expect(f.trace).toEqual(["uuid", "update:target", "callback"]);
    });

    it.each([
        [{ runtimeId: "old", recorderRuntimeId: "" }, "old"],
        [{ runtimeId: "", recorderRuntimeId: 0, pid: 1 }, null],
        [{ runtimeId: "old", recorderRuntimeId: 42 }, 42],
    ] as const)("retains recorder identity truthiness for %s", (previous, identity) => {
        const f = fixture({ id: "target", recording: previous });
        const result = f.transitions.claimRecordingFinalization("target", previous, null, "stamp");
        expect(result.committed).toBe(true);
        expect((result.device?.recording as GenerationRecord).recorderRuntimeId).toBe(identity);
    });

    it.each(["missing", "successor"])("allocates UUID before a %s target prevents finalization", mode => {
        const initial = mode === "missing" ? null : { id: "target", recording: { runtimeId: "successor" } };
        const f = fixture(initial);
        expect(f.transitions.claimRecordingFinalization("target", { runtimeId: "old" }, {}, "stamp"))
            .toEqual({ committed: false, device: initial });
        expect(f.device()).toBe(initial);
        expect(f.trace).toEqual(mode === "missing" ? ["uuid", "update:target"] : ["uuid", "update:target", "callback"]);
    });

    it("propagates UUID failure before invoking the updater", () => {
        const f = fixture();
        const fault = new Error("entropy failed");
        f.ports.newRuntimeId = () => { f.trace.push("uuid-failed"); throw fault; };
        throwsSame(() => f.transitions.claimRecordingFinalization("target", {}, {}, "stamp"), fault);
        expect(f.trace).toEqual(["uuid-failed"]);
    });

});
