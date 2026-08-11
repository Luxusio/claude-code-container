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

    it("does nothing when the selected tool already exists", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // requested-tool proof

        ensureTools(container, getToolByName("gemini")!);

        // Selected-tool check + exact requested-tool proof, no install.
        expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        expect(console.log).not.toHaveBeenCalled();
    });

    it("installs the selected missing tool and creates its wrapper", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale shims
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // npm install success
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // mise reshim
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper gemini
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // requested-tool proof

        ensureTools(container, getToolByName("gemini")!);

        expect(spawnSyncMock).toHaveBeenCalledTimes(7);

        // Verify install command uses mise exec node@22 (index 3 after cleanup)
        const installCall = spawnSyncMock.mock.calls[3];
        expect(installCall[0]).toBe("docker");
        const installArgs = installCall[1] as string[];
        expect(installArgs).toContain("exec");
        expect(installArgs).toContain(container);
        const shCmd = installArgs[installArgs.length - 1];
        expect(shCmd).toContain("mise exec node@22");
        expect(shCmd).toContain("@google/gemini-cli");
        expect(shCmd).not.toContain("@openai/codex");
        expect(shCmd).not.toContain("opencode-ai");

        // Verify wrapper creation
        const wrapperCall = spawnSyncMock.mock.calls[5];
        const wrapperArgs = wrapperCall[1] as string[];
        const wrapperCmd = wrapperArgs[wrapperArgs.length - 1];
        expect(wrapperCmd).toContain("mise exec node@22 -- gemini");
        expect(wrapperCmd).toContain("chmod +x");

        expect(console.log).toHaveBeenCalledWith("Installing gemini...");
    });

    it("does not inspect missing inactive tools", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));
        spawnSyncMock.mockReturnValueOnce(makeResult(0));
        ensureTools(container, getToolByName("gemini")!);
        expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        const shCmd = (spawnSyncMock.mock.calls[0][1] as string[]).at(-1) as string;
        expect(shCmd).toContain("gemini");
        expect(shCmd).not.toContain("codex");
        expect(shCmd).not.toContain("opencode");
    });

    it("warns, skips wrappers, and fails when install leaves the requested tool absent", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale shims
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // npm install FAIL

        expect(() => ensureTools(container, getToolByName("gemini")!)).toThrow(
            "Container gemini installation failed",
        );

        // 1 check + 2 cleanups + failed install; no later mutation or proof.
        expect(spawnSyncMock).toHaveBeenCalledTimes(4);
    });

    it("checks only the selected tool in one docker exec", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));
        spawnSyncMock.mockReturnValueOnce(makeResult(0));

        ensureTools(container, getToolByName("gemini")!);

        const checkCall = spawnSyncMock.mock.calls[0];
        const checkArgs = checkCall[1] as string[];
        const shCmd = checkArgs[checkArgs.length - 1];
        expect(shCmd).toContain("[ -x /home/ccc/.local/bin/gemini ]");
        expect(shCmd).not.toContain("[ -x /home/ccc/.local/bin/codex ]");
        expect(shCmd).not.toContain("[ -x /home/ccc/.local/bin/opencode ]");
    });
});
