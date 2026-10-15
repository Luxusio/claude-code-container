import { describe, expect, it, vi } from "vitest";
import { createWorktreeAddition } from "../../application/workspace/worktree-addition.js";
import type { WorktreeAdditionObservation, WorktreeAdditionPorts, WorktreeAdditionRequest } from "../../ports/workspace/worktree-addition.js";

const request: WorktreeAdditionRequest = { repositoryPath: "/repo", destinationPath: "/destination", branch: "feature/raw", failureContext: { kind: "unified" } };
const prepared = Object.freeze({ opaque: Symbol("prepared") });
const receipt = Object.freeze({ opaque: Symbol("receipt") });
function thrown(run: () => unknown): unknown { try { run(); } catch (error) { return error; } throw new Error("Expected exception"); }
function fixture(observation: WorktreeAdditionObservation<typeof receipt> = { succeeded: true, failureDetail: "", registrationReceipt: receipt }) {
    const ports = {
        observeBranch: vi.fn<WorktreeAdditionPorts<typeof prepared, typeof receipt>["observeBranch"]>(() => "none"),
        prepareAddition: vi.fn(() => prepared),
        addPrepared: vi.fn(() => observation),
        compensateFailedAddition: vi.fn(() => {}),
    };
    return ports;
}

describe("worktree addition application policy", () => {
    it.each([ ["local", "worktree-existing"], ["remote", "worktree-remote"], ["none", "worktree-new"] ] as const)("routes %s through prepare and add in order", (existence, action) => {
        const ports = fixture();
        ports.observeBranch.mockReturnValue(existence);
        const add = createWorktreeAddition(ports);
        for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled();
        const result = add(request);
        expect(result).toEqual({ action, prepared, registrationReceipt: receipt });
        expect(result.prepared).toBe(prepared);
        expect(result.registrationReceipt).toBe(receipt);
        expect(ports.observeBranch).toHaveBeenCalledExactlyOnceWith(request);
        expect(ports.prepareAddition).toHaveBeenCalledExactlyOnceWith(request, action);
        expect(ports.addPrepared).toHaveBeenCalledExactlyOnceWith(request, prepared);
        expect(ports.observeBranch.mock.invocationCallOrder[0]).toBeLessThan(ports.prepareAddition.mock.invocationCallOrder[0]);
        expect(ports.prepareAddition.mock.invocationCallOrder[0]).toBeLessThan(ports.addPrepared.mock.invocationCallOrder[0]);
        expect(ports.compensateFailedAddition).not.toHaveBeenCalled();
    });

    it.each([undefined, null, {}])("rejects missing ports without executing effects: %j", value => {
        expect(thrown(() => createWorktreeAddition(value as unknown as WorktreeAdditionPorts<unknown, unknown>))).toBeInstanceOf(TypeError);
    });
    it.each(["observeBranch", "prepareAddition", "addPrepared", "compensateFailedAddition"] as const)("requires callable %s", name => {
        for (const value of [undefined, null, 0, {}, "callback"]) {
            const ports = fixture();
            expect(thrown(() => createWorktreeAddition({ ...ports, [name]: value } as unknown as WorktreeAdditionPorts<unknown, unknown>))).toBeInstanceOf(TypeError);
            for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled();
        }
    });

    it.each(["observeBranch", "prepareAddition", "addPrepared"] as const)("propagates %s throws without inventing compensation", name => {
        for (const failure of [new Error("native failure"), Object.freeze({ code: "opaque" }), null, undefined]) {
            const ports = fixture();
            ports[name].mockImplementation(() => { throw failure; });
            expect(thrown(() => createWorktreeAddition(ports)(request))).toBe(failure);
            expect(ports.compensateFailedAddition).not.toHaveBeenCalled();
            if (name === "observeBranch") expect(ports.prepareAddition).not.toHaveBeenCalled();
            if (name !== "addPrepared") expect(ports.addPrepared).not.toHaveBeenCalled();
        }
    });

    it("compensates classified failure with unchanged opaque arguments", () => {
        const ports = fixture({ succeeded: false, failureDetail: "native error", registrationReceipt: receipt });
        expect(() => createWorktreeAddition(ports)(request)).toThrow("Failed to create worktree: native error");
        expect(ports.compensateFailedAddition).toHaveBeenCalledExactlyOnceWith(request, "worktree-new", prepared, receipt);
        expect(ports.addPrepared.mock.invocationCallOrder[0]).toBeLessThan(ports.compensateFailedAddition.mock.invocationCallOrder[0]);
    });

    it.each(["stderr", " process raw ", "process", ""])("preserves the classified diagnostic and both message contexts: %j", detail => {
        for (const context of [{ kind: "unified" }, { kind: "multi-repo", repositoryName: "repo raw" }] as const) {
            const ports = fixture({ succeeded: false, failureDetail: detail, registrationReceipt: null });
            const input = { ...request, failureContext: context };
            const error = thrown(() => createWorktreeAddition(ports)(input)) as Error;
            const prefix = context.kind === "unified" ? "Failed to create worktree" : "Failed to create worktree for repo raw";
            expect(error.message).toBe(`${prefix}: ${detail}`);
            expect(error.cause).toBeUndefined();
            expect(ports.compensateFailedAddition).toHaveBeenCalledExactlyOnceWith(input, "worktree-new", prepared, null);
            const rollback = new Error("rollback raw");
            ports.compensateFailedAddition.mockImplementation(() => { throw rollback; });
            const combined = thrown(() => createWorktreeAddition(ports)(input)) as Error;
            expect(combined.message).toBe(`${prefix}: ${detail}; rollback failed: rollback raw`);
            expect(combined.cause).toBe(rollback);
        }
    });

    it.each([receipt, null])("accepts semantic completion with a nullable opaque receipt: %j", registrationReceipt => {
        const observation = Object.freeze({ succeeded: true, failureDetail: "opaque success diagnostic", registrationReceipt });
        const ports = fixture(observation);
        const result = createWorktreeAddition(ports)(request);
        expect(result.prepared).toBe(prepared);
        expect(result.registrationReceipt).toBe(registrationReceipt);
        expect(ports.compensateFailedAddition).not.toHaveBeenCalled();
        expect(observation).toEqual({ succeeded: true, failureDetail: "opaque success diagnostic", registrationReceipt });
    });
});
