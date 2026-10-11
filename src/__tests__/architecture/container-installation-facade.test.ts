import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("../../container-runtime.js", async original => ({
    ...await original<typeof import("../../container-runtime.js")>(), runtimeCli: () => "docker",
}));
const setup = await import("../../container-setup.js");
const { getToolByName } = await import("../../tool-registry.js");
const result = (status: number | null, stdout = "", stderr = "") => ({ status, stdout, stderr });
const timedOut = () => ({ ...result(null), error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) });

beforeEach(() => {
    vi.resetAllMocks();
    native.spawn.mockImplementation(() => { throw new Error("Unexpected additional command"); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("container installation native composition", () => {
    it("bounds Claude probe, installation and confirmation without root authority", () => {
        native.spawn.mockReturnValueOnce(result(0, "INSTALL")).mockReturnValueOnce(result(0)).mockReturnValueOnce(result(0, "VALID"));
        setup.ensureClaudeInContainer("target");
        const calls = native.spawn.mock.calls;
        expect(calls).toHaveLength(3);
        for (const call of calls) {
            expect(call[0]).toBe("docker");
            expect(call[1].slice(0, 4)).toEqual(["exec", "target", "sh", "-c"]);
            expect(call[1]).not.toContain("root");
        }
        expect(calls[0][2]).toEqual({ encoding: "utf-8", timeout: 150_000 });
        expect(calls[1][2]).toEqual({ stdio: "inherit", timeout: setup.CONTAINER_TOOL_MUTATION_TIMEOUT_MS });
        expect(calls[2][2]).toEqual({ encoding: "utf-8", timeout: 150_000 });
    });

    it("reports sanitized successful initial notes before refusing an invalid result", () => {
        native.spawn.mockReturnValueOnce(result(0, "UNKNOWN", "noise\nremoved unsafe\u001b\u202e: discarded\n"));
        expect(() => setup.ensureClaudeInContainer("target")).toThrow("Claude readiness probe returned an invalid result");
        expect(console.log).toHaveBeenCalledTimes(1);
        expect(console.log).toHaveBeenCalledWith("removed unsafe??: discarded");
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });

    it("uses only the last three diagnostic lines and sanitizes controls and bidi", () => {
        native.spawn.mockReturnValueOnce(result(1, "", "discard this\nfirst\nsecond\u001b[2K\nthird\u202e\n"));
        expect(() => setup.ensureClaudeInContainer("target")).toThrow("Claude readiness probe failed: first; second?[2K; third?");
        expect(console.log).not.toHaveBeenCalled();
    });

    it.each([result(1), timedOut()])("does not publish notes from a failed initial probe (%j)", failure => {
        native.spawn.mockReturnValueOnce({ ...failure, stderr: "removed failed-probe-only\n" });
        expect(() => setup.ensureClaudeInContainer("target")).toThrow(/Claude readiness probe (failed|timed out)/);
        expect(console.log).not.toHaveBeenCalled();
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });

    it("deduplicates sanitized notes across confirmation but starts fresh on the next preparation", () => {
        native.spawn.mockReturnValueOnce(result(0, "INSTALL", "cannot remove unsafe\u001b: refused\n"))
            .mockReturnValueOnce(result(0))
            .mockReturnValueOnce(result(0, "RESTORED 2.1", "cannot remove unsafe\u202e: refused\nremoved fresh\n"))
            .mockReturnValueOnce(result(0, "VALID", "cannot remove unsafe\u001b: refused\n"));
        setup.ensureClaudeInContainer("target");
        expect(vi.mocked(console.log).mock.calls.filter(call => call[0] === "cannot remove unsafe?: refused")).toHaveLength(1);
        expect(console.log).toHaveBeenCalledWith("removed fresh");
        expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Reusing"));
        setup.ensureClaudeInContainer("target");
        expect(vi.mocked(console.log).mock.calls.filter(call => call[0] === "cannot remove unsafe?: refused")).toHaveLength(2);
    });

    it.each([result(1, "VALID"), timedOut(), result(0, "INSTALL"), result(0, "UNKNOWN")])(
        "refuses unusable confirmation with its own failure and no confirmation notes (%j)", confirmation => {
            native.spawn.mockReturnValueOnce(result(0, "INSTALL")).mockReturnValueOnce(result(0))
                .mockReturnValueOnce({ ...confirmation, stderr: "removed confirmation-only\n" });
            expect(() => setup.ensureClaudeInContainer("target")).toThrow("Claude installation left no usable launcher");
            expect(console.log).not.toHaveBeenCalledWith("removed confirmation-only");
            expect(native.spawn).toHaveBeenCalledTimes(3);
        },
    );

    it.each([124, 137])("treats npm wrapper exit %s as failure and never reaches cache or mutations", status => {
        native.spawn.mockReturnValueOnce(result(status));
        expect(() => setup.ensureTools("target", getToolByName("gemini")!)).toThrow("Container npm tool probe failed");
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });

    it.each([124, 137])("treats npm cache exit %s as timeout and prevents cleanup", status => {
        native.spawn.mockReturnValueOnce(result(0, "gemini")).mockReturnValueOnce(result(status));
        expect(() => setup.ensureTools("target", getToolByName("gemini")!)).toThrow("Container gemini cached executable probe timed out");
        expect(native.spawn).toHaveBeenCalledTimes(2);
    });

    it.each([124, 137])("treats npm cleanup exit %s as timeout and prevents installation", status => {
        native.spawn.mockReturnValueOnce(result(0, "gemini")).mockReturnValueOnce(result(0, "MISSING"))
            .mockReturnValueOnce(result(status));
        expect(() => setup.ensureTools("target", getToolByName("gemini")!)).toThrow("Container gemini cleanup timed out");
        expect(native.spawn).toHaveBeenCalledTimes(3);
        expect(native.spawn.mock.calls[2][1].slice(0, 6)).toEqual(["exec", "-w", "/home/ccc", "target", "sh", "-c"]);
        expect(native.spawn.mock.calls[2][2]).toEqual({ stdio: "ignore", timeout: setup.CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS });
    });

    it("creates a wrapper for a ready persisted npm executable without reinstalling", () => {
        native.spawn.mockReturnValueOnce(result(0, "gemini")).mockReturnValueOnce(result(0, "READY"))
            .mockReturnValueOnce(result(0)).mockReturnValueOnce(result(0));
        setup.ensureTools("target", getToolByName("gemini")!);
        const calls = native.spawn.mock.calls;
        expect(calls).toHaveLength(4);
        expect(calls[1][1].slice(0, 6)).toEqual(["exec", "-w", "/home/ccc", "target", "sh", "-c"]);
        expect(calls[2][1].slice(0, 6)).toEqual(["exec", "-w", "/home/ccc", "target", "sh", "-c"]);
        expect(calls[2][2]).toEqual({ stdio: "pipe", timeout: setup.CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS });
        expect(console.log).not.toHaveBeenCalledWith("Installing gemini...");
        expect(calls[3][1]).toEqual(["exec", "target", "test", "-x", "/home/ccc/.local/bin/gemini"]);
    });

    it.each([124, 137])("treats uv probe exit %s as failure without installation", status => {
        native.spawn.mockReturnValueOnce(result(status));
        expect(() => setup.ensureUvAvailable("target")).toThrow("Container uv probe failed");
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });

    it("distinguishes a native uv timeout from missing uv", () => {
        native.spawn.mockReturnValueOnce(timedOut());
        expect(() => setup.ensureUvAvailable("target")).toThrow("Container uv probe timed out");
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });

    it("installs missing uv with bounded inherited output and explicit environment", () => {
        native.spawn.mockReturnValueOnce(result(1)).mockReturnValueOnce(result(0));
        setup.ensureUvAvailable("target");
        expect(native.spawn.mock.calls[1][1].slice(0, 6)).toEqual(["exec", "-e", "MISE_VERBOSE=1", "target", "sh", "-c"]);
        expect(native.spawn.mock.calls[1][2]).toEqual({ stdio: "inherit", timeout: setup.CONTAINER_TOOL_MUTATION_TIMEOUT_MS });
    });
});
