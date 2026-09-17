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

    it("does nothing when all tools already exist", () => {
        // Single combined check returns empty stdout (all present)
        spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));

        ensureTools(container, getToolByName("gemini")!);

        // Only 1 combined check call, no install
        expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        expect(console.log).not.toHaveBeenCalled();
    });

    it("installs missing tools independently and creates each wrapper", () => {
        // Combined check returns all 3 missing
        spawnSyncMock.mockReturnValue(makeResult(0));
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\ncodex\nopencode\n"));

        ensureTools(container, getToolByName("gemini")!);

        const installCalls = spawnSyncMock.mock.calls.filter(([, args]) =>
            (args as string[]).at(-1)!.includes("npm install -g"),
        );
        expect(installCalls.map(([, args]) => (args as string[]).at(-1))).toEqual([
            "~/.local/bin/mise exec node@22 -- npm install -g @google/gemini-cli",
            "~/.local/bin/mise exec node@22 -- npm install -g @openai/codex",
            "~/.local/bin/mise exec node@22 -- npm install -g opencode-ai",
        ]);
        for (const [cli, args] of installCalls) {
            expect(cli).toBe("docker");
            expect(args).toEqual(expect.arrayContaining(["exec", container]));
        }

        const wrapperCommands = spawnSyncMock.mock.calls
            .map(([, args]) => (args as string[]).at(-1)!)
            .filter((script) => script.includes("cat > /home/ccc/.local/bin/"));
        expect(wrapperCommands).toHaveLength(3);
        for (const cmd of ["gemini", "codex", "opencode"]) {
            expect(wrapperCommands).toContainEqual(expect.stringContaining(`mise exec node@22 -- ${cmd}`));
            expect(wrapperCommands).toContainEqual(expect.stringContaining(`chmod +x /home/ccc/.local/bin/${cmd}`));
        }

        expect(console.log).toHaveBeenCalledWith("Installing gemini, codex, opencode...");
    });

    it("installs only missing tools (partial)", () => {
        // Combined check returns only codex missing
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "codex\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale shims
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // npm install success
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // mise reshim
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper codex

        ensureTools(container, getToolByName("gemini")!);

        // 1 check + 2 cleanups + 1 install + 1 reshim + 1 wrapper = 6 calls
        expect(spawnSyncMock).toHaveBeenCalledTimes(6);

        // Install only codex (index 3 after cleanup)
        const installCall = spawnSyncMock.mock.calls[3];
        const shCmd = (installCall[1] as string[])[
            (installCall[1] as string[]).length - 1
        ];
        expect(shCmd).toContain("@openai/codex");
        expect(shCmd).not.toContain("@google/gemini-cli");

        expect(console.log).toHaveBeenCalledWith("Installing codex...");
    });

    it("fails active installation while preserving independent tool wrappers", () => {
        spawnSyncMock.mockImplementation((_cli, args) => {
            const script = (args as string[]).at(-1)!;
            if (script.startsWith("[ -x ")) return makeResult(0, "gemini\ncodex\nopencode\n");
            if (script === "~/.local/bin/mise exec node@22 -- npm install -g @google/gemini-cli") {
                return { ...makeResult(1), stderr: "npm error EACCES" };
            }
            return makeResult(0);
        });

        expect(() => ensureTools(container, getToolByName("gemini")!))
            .toThrow(/install gemini \(@google\/gemini-cli\).*EACCES/);

        const wrapperCommands = spawnSyncMock.mock.calls
            .map(([, args]) => (args as string[]).at(-1)!)
            .filter((script) => script.includes("cat > /home/ccc/.local/bin/"));
        expect(wrapperCommands).toHaveLength(2);
        expect(wrapperCommands).toContainEqual(expect.stringContaining("mise exec node@22 -- codex"));
        expect(wrapperCommands).toContainEqual(expect.stringContaining("mise exec node@22 -- opencode"));
        expect(wrapperCommands).not.toContainEqual(expect.stringContaining("mise exec node@22 -- gemini"));
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("checks all tools in single docker exec", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));

        ensureTools(container, getToolByName("gemini")!);

        // Verify the combined check command
        const checkCall = spawnSyncMock.mock.calls[0];
        const checkArgs = checkCall[1] as string[];
        const shCmd = checkArgs[checkArgs.length - 1];
        expect(shCmd).toContain("[ -x /home/ccc/.local/bin/gemini ]");
        expect(shCmd).toContain("[ -x /home/ccc/.local/bin/codex ]");
    });
});
