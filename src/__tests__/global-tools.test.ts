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
const { ensureTools } = await import("../container-setup.js");
const { getToolByName } = await import("../tool-registry.js");

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

describe("ensureTools (npm tools)", () => {
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
        // All 3 wrapper checks succeed (status 0): gemini, codex, opencode
        spawnSyncMock.mockReturnValue(makeResult(0));

        ensureTools(container, getToolByName("gemini")!);

        // Only 3 calls: check gemini + check codex + check opencode
        expect(spawnSyncMock).toHaveBeenCalledTimes(3);
        expect(console.log).not.toHaveBeenCalled();
    });

    it("installs missing tools and creates wrappers", () => {
        // Check gemini → missing, check codex → missing, check opencode → missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // gemini missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // codex missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // opencode missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // npm install success
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper gemini
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper codex
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper opencode

        ensureTools(container, getToolByName("gemini")!);

        // 3 checks + 1 cleanup + 1 install + 3 wrappers = 8 calls
        expect(spawnSyncMock).toHaveBeenCalledTimes(8);

        // Verify install command uses mise exec node@22 (index 4 after cleanup)
        const installCall = spawnSyncMock.mock.calls[4];
        expect(installCall[0]).toBe("docker");
        const installArgs = installCall[1] as string[];
        expect(installArgs).toContain("exec");
        expect(installArgs).toContain(container);
        const shCmd = installArgs[installArgs.length - 1];
        expect(shCmd).toContain("mise exec node@22");
        expect(shCmd).toContain("@google/gemini-cli");
        expect(shCmd).toContain("@openai/codex");
        expect(shCmd).toContain("opencode-ai");

        // Verify wrapper creation
        const wrapperCall = spawnSyncMock.mock.calls[5];
        const wrapperArgs = wrapperCall[1] as string[];
        const wrapperCmd = wrapperArgs[wrapperArgs.length - 1];
        expect(wrapperCmd).toContain("mise exec node@22 -- gemini");
        expect(wrapperCmd).toContain("chmod +x");

        expect(console.log).toHaveBeenCalledWith("Installing gemini, codex, opencode...");
    });

    it("installs only missing tools (partial)", () => {
        // gemini exists, codex missing, opencode exists
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // gemini exists
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // codex missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // opencode exists
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // npm install success
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper codex

        ensureTools(container, getToolByName("gemini")!);

        // 3 checks + 1 cleanup + 1 install + 1 wrapper = 6 calls
        expect(spawnSyncMock).toHaveBeenCalledTimes(6);

        // Install only codex (index 4 after cleanup)
        const installCall = spawnSyncMock.mock.calls[4];
        const shCmd = (installCall[1] as string[])[
            (installCall[1] as string[]).length - 1
        ];
        expect(shCmd).toContain("@openai/codex");
        expect(shCmd).not.toContain("@google/gemini-cli");

        expect(console.log).toHaveBeenCalledWith("Installing codex...");
    });

    it("warns and skips wrappers on install failure", () => {
        // All 3 missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // gemini missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // codex missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // opencode missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // npm install FAIL

        ensureTools(container, getToolByName("gemini")!);

        // 3 checks + 1 cleanup + 1 install = 5 calls (no wrapper calls)
        expect(spawnSyncMock).toHaveBeenCalledTimes(5);
        expect(console.warn).toHaveBeenCalledWith(
            "Warning: Failed to install some global npm tools (non-fatal)",
        );
    });

    it("checks correct wrapper paths", () => {
        spawnSyncMock.mockReturnValue(makeResult(0));

        ensureTools(container, getToolByName("gemini")!);

        const geminiCheck = spawnSyncMock.mock.calls[0];
        const geminiArgs = geminiCheck[1] as string[];
        expect(geminiArgs).toContain("test -x /home/ccc/.local/bin/gemini");

        const codexCheck = spawnSyncMock.mock.calls[1];
        const codexArgs = codexCheck[1] as string[];
        expect(codexArgs).toContain("test -x /home/ccc/.local/bin/codex");

        const opencodeCheck = spawnSyncMock.mock.calls[2];
        const opencodeArgs = opencodeCheck[1] as string[];
        expect(opencodeArgs).toContain("test -x /home/ccc/.local/bin/opencode");
    });
});
