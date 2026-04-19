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

function makeResult(status: number, stdout = ""): SpawnSyncReturns<string> {
    return {
        pid: 1,
        output: [],
        stdout,
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
        // Single combined check returns empty stdout (all present)
        spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));

        ensureGlobalNpmTools(container);

        // Only 1 combined check call, no install
        expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        expect(console.log).not.toHaveBeenCalled();
    });

    it("installs missing tools and creates wrappers", () => {
        // Combined check returns both missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\ncodex\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // npm install success
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper gemini
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper codex

        ensureGlobalNpmTools(container);

        // 1 check + 1 cleanup + 1 install + 2 wrappers = 5 calls
        expect(spawnSyncMock).toHaveBeenCalledTimes(5);

        // Verify install command uses mise exec node@22 (index 2 after cleanup)
        const installCall = spawnSyncMock.mock.calls[2];
        expect(installCall[0]).toBe("docker");
        const installArgs = installCall[1] as string[];
        expect(installArgs).toContain("exec");
        expect(installArgs).toContain(container);
        const shCmd = installArgs[installArgs.length - 1];
        expect(shCmd).toContain("mise exec node@22");
        expect(shCmd).toContain("@google/gemini-cli");
        expect(shCmd).toContain("@openai/codex");

        // Verify wrapper creation
        const wrapperCall = spawnSyncMock.mock.calls[3];
        const wrapperArgs = wrapperCall[1] as string[];
        const wrapperCmd = wrapperArgs[wrapperArgs.length - 1];
        expect(wrapperCmd).toContain("mise exec node@22 -- gemini");
        expect(wrapperCmd).toContain("chmod +x");

        expect(console.log).toHaveBeenCalledWith("Installing gemini, codex...");
    });

    it("installs only missing tools (partial)", () => {
        // Combined check returns only codex missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "codex\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // npm install success
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper codex

        ensureGlobalNpmTools(container);

        // 1 check + 1 cleanup + 1 install + 1 wrapper = 4 calls
        expect(spawnSyncMock).toHaveBeenCalledTimes(4);

        // Install only codex (index 2 after cleanup)
        const installCall = spawnSyncMock.mock.calls[2];
        const shCmd = (installCall[1] as string[])[
            (installCall[1] as string[]).length - 1
        ];
        expect(shCmd).toContain("@openai/codex");
        expect(shCmd).not.toContain("@google/gemini-cli");

        expect(console.log).toHaveBeenCalledWith("Installing codex...");
    });

    it("warns and skips wrappers on install failure", () => {
        // Combined check returns both missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\ncodex\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // npm install FAIL

        ensureGlobalNpmTools(container);

        // 1 check + 1 cleanup + 1 install = 3 calls (no wrapper calls)
        expect(spawnSyncMock).toHaveBeenCalledTimes(3);
        expect(console.warn).toHaveBeenCalledWith(
            "Warning: Failed to install some global npm tools (non-fatal)",
        );
    });

    it("checks all tools in single docker exec", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));

        ensureGlobalNpmTools(container);

        // Verify the combined check command
        const checkCall = spawnSyncMock.mock.calls[0];
        const checkArgs = checkCall[1] as string[];
        const shCmd = checkArgs[checkArgs.length - 1];
        expect(shCmd).toContain("[ -x /home/ccc/.local/bin/gemini ]");
        expect(shCmd).toContain("[ -x /home/ccc/.local/bin/codex ]");
    });
});
