import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";

// Mock child_process before importing the module under test
const spawnSyncMock = vi.fn<
    (...args: unknown[]) => SpawnSyncReturns<string>
>();

vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: spawnSyncMock };
});

// Must import AFTER vi.mock so the mock is in effect
const { ensureGlobalNpmTools } = await import("../container-setup.js");

function makeResult(status: number): SpawnSyncReturns<string> {
    return {
        pid: 1,
        output: [],
        stdout: "",
        stderr: "",
        status,
        signal: null,
    };
}

describe("ensureGlobalNpmTools", () => {
    const container = "test-container";

    beforeEach(() => {
        spawnSyncMock.mockReset();
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("does nothing when all tools already exist", () => {
        // Both wrapper checks succeed (status 0)
        spawnSyncMock.mockReturnValue(makeResult(0));

        ensureGlobalNpmTools(container);

        // Only 2 calls: check gemini + check codex
        expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        expect(console.log).not.toHaveBeenCalled();
    });

    it("installs missing tools and creates wrappers", () => {
        // Check gemini → missing, check codex → missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // gemini missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // codex missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // npm install success
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper gemini
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper codex

        ensureGlobalNpmTools(container);

        // 2 checks + 1 cleanup + 1 install + 2 wrappers = 6 calls
        expect(spawnSyncMock).toHaveBeenCalledTimes(6);

        // Verify install command uses mise exec node@22 (index 3 after cleanup)
        const installCall = spawnSyncMock.mock.calls[3];
        expect(installCall[0]).toBe("docker");
        const installArgs = installCall[1] as string[];
        expect(installArgs).toContain("exec");
        expect(installArgs).toContain(container);
        const shCmd = installArgs[installArgs.length - 1];
        expect(shCmd).toContain("mise exec node@22");
        expect(shCmd).toContain("@google/gemini-cli");
        expect(shCmd).toContain("@openai/codex");

        // Verify wrapper creation
        const wrapperCall = spawnSyncMock.mock.calls[4];
        const wrapperArgs = wrapperCall[1] as string[];
        const wrapperCmd = wrapperArgs[wrapperArgs.length - 1];
        expect(wrapperCmd).toContain("mise exec node@22 -- gemini");
        expect(wrapperCmd).toContain("chmod +x");

        expect(console.log).toHaveBeenCalledWith("Installing gemini, codex...");
    });

    it("installs only missing tools (partial)", () => {
        // gemini exists, codex missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // gemini exists
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // codex missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // npm install success
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper codex

        ensureGlobalNpmTools(container);

        // 2 checks + 1 cleanup + 1 install + 1 wrapper = 5 calls
        expect(spawnSyncMock).toHaveBeenCalledTimes(5);

        // Install only codex (index 3 after cleanup)
        const installCall = spawnSyncMock.mock.calls[3];
        const shCmd = (installCall[1] as string[])[
            (installCall[1] as string[]).length - 1
        ];
        expect(shCmd).toContain("@openai/codex");
        expect(shCmd).not.toContain("@google/gemini-cli");

        expect(console.log).toHaveBeenCalledWith("Installing codex...");
    });

    it("warns and skips wrappers on install failure", () => {
        // Both missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // gemini missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // codex missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // npm install FAIL

        ensureGlobalNpmTools(container);

        // 2 checks + 1 cleanup + 1 install = 4 calls (no wrapper calls)
        expect(spawnSyncMock).toHaveBeenCalledTimes(4);
        expect(console.warn).toHaveBeenCalledWith(
            "Warning: Failed to install some global npm tools (non-fatal)",
        );
    });

    it("checks correct wrapper paths", () => {
        spawnSyncMock.mockReturnValue(makeResult(0));

        ensureGlobalNpmTools(container);

        const geminiCheck = spawnSyncMock.mock.calls[0];
        const geminiArgs = geminiCheck[1] as string[];
        expect(geminiArgs).toContain("test -x /home/ccc/.local/bin/gemini");

        const codexCheck = spawnSyncMock.mock.calls[1];
        const codexArgs = codexCheck[1] as string[];
        expect(codexArgs).toContain("test -x /home/ccc/.local/bin/codex");
    });
});
