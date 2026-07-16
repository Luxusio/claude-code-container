import { describe, expect, it, vi } from "vitest";
import {
    deviceRuntimeProcessIdentityMatches,
    inspectDeviceRuntimeProcessIdentity,
    readDeviceRuntimeProcessIdentity,
    signalDeviceRuntimeProcess,
} from "../device-lab-process-identity.js";

describe("broker device runtime process identity", () => {
    it("reads a stable hashed identity without exposing the command line", () => {
        const first = readDeviceRuntimeProcessIdentity(process.pid);
        const second = readDeviceRuntimeProcessIdentity(process.pid);
        expect(first).toEqual(expect.objectContaining({ pid: process.pid }));
        expect(first?.commandHash).toMatch(/^[a-f0-9]{64}$/);
        expect(first).not.toHaveProperty("commandLine");
        expect(deviceRuntimeProcessIdentityMatches(first, second)).toBe(true);
    });

    it("refuses to signal a reused pid", () => {
        const kill = vi.fn();
        const result = signalDeviceRuntimeProcess({
            runtimeId: "runtime-1",
            pid: 42,
            processIdentity: { pid: 42, startToken: "old", commandHash: "same" },
        }, "SIGINT", {
            readIdentity: () => ({ pid: 42, startToken: "new", commandHash: "same" }),
            kill,
        });
        expect(result).toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-mismatch" }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("treats an exited owned runtime as safely stale", () => {
        const kill = vi.fn();
        const result = signalDeviceRuntimeProcess({
            runtimeId: "runtime-1",
            pid: 42,
            processIdentity: { pid: 42, startToken: "old", commandHash: "same" },
        }, "SIGINT", { readIdentity: () => null, probeLiveness: () => "exited", kill });
        expect(result).toEqual(expect.objectContaining({ attempted: false, ok: true, stale: true, reason: "runtime-process-exited" }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("preserves a live runtime when process identity lookup is unavailable", () => {
        const identity = { pid: 42, startToken: "same", commandHash: "same" };
        const observation = inspectDeviceRuntimeProcessIdentity(identity, 42, {
            readIdentity: () => null,
            probeLiveness: () => "alive",
        });
        expect(observation).toEqual({ status: "unavailable", current: null, liveness: "alive" });

        const kill = vi.fn();
        const result = signalDeviceRuntimeProcess({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "SIGINT", {
            readIdentity: () => null,
            probeLiveness: () => "alive",
            kill,
        });
        expect(result).toEqual(expect.objectContaining({
            attempted: false,
            ok: false,
            reason: "runtime-process-identity-unavailable",
        }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("signals an exact runtime identity", () => {
        const processIdentity = { pid: 42, startToken: "same", commandHash: "same" };
        const kill = vi.fn();
        const result = signalDeviceRuntimeProcess({ runtimeId: "runtime-1", pid: 42, processIdentity }, "SIGTERM", {
            readIdentity: () => ({ ...processIdentity }),
            kill,
        });
        expect(result).toEqual(expect.objectContaining({ attempted: true, ok: true, pid: 42, signal: "SIGTERM" }));
        expect(kill).toHaveBeenCalledWith(42, "SIGTERM");
    });
});
