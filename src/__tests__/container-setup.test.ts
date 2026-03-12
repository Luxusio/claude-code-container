import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: spawnSyncMock };
});

// Import AFTER mocks
const {
    CLAUDE_PERSIST_DIR,
    CLAUDE_BIN_PATH,
    isMiseShim,
    isValidClaudeBinary,
    saveClaudeBinaryToVolume,
    ensureClaudeInContainer,
    ensureTools,
} = await import("../container-setup.js");

const { getDefaultTool, getToolByName } = await import("../tool-registry.js");

function makeResult(status: number, stdout = ""): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

describe("container-setup.ts module", () => {
    const container = "test-container";

    beforeEach(() => {
        spawnSyncMock.mockReset();
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("constants", () => {
        it("exports CLAUDE_PERSIST_DIR", () => {
            expect(CLAUDE_PERSIST_DIR).toBe(
                "/home/ccc/.local/share/mise/.claude-bin",
            );
        });

        it("exports CLAUDE_BIN_PATH", () => {
            expect(CLAUDE_BIN_PATH).toBe("/home/ccc/.local/bin/claude");
        });
    });

    describe("isMiseShim", () => {
        it("returns true when head+grep finds mise in file", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            expect(isMiseShim(container, "/some/path")).toBe(true);
        });

        it("returns false when grep does not find mise", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            expect(isMiseShim(container, "/some/path")).toBe(false);
        });

        it("passes correct docker exec command", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            isMiseShim(container, "/usr/bin/claude");
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker",
                [
                    "exec",
                    container,
                    "sh",
                    "-c",
                    "head -c 500 '/usr/bin/claude' 2>/dev/null | grep -q mise",
                ],
                expect.any(Object),
            );
        });
    });

    describe("isValidClaudeBinary", () => {
        it("returns true when --version contains claude", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            expect(isValidClaudeBinary(container, "/usr/bin/claude")).toBe(true);
        });

        it("returns false when --version does not contain claude", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            expect(isValidClaudeBinary(container, "/usr/bin/claude")).toBe(
                false,
            );
        });
    });

    describe("saveClaudeBinaryToVolume", () => {
        it("skips saving if binary is a mise shim", () => {
            // isMiseShim returns true (status 0)
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            saveClaudeBinaryToVolume(container);
            // Only 1 call (isMiseShim check), no copy
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("skips saving if binary is not valid claude", () => {
            // isMiseShim returns false (status 1)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // isValidClaudeBinary returns false (status 1)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            saveClaudeBinaryToVolume(container);
            // 2 calls: isMiseShim + isValidClaudeBinary, no copy
            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        });

        it("copies binary when valid and not a shim", () => {
            // isMiseShim returns false
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // isValidClaudeBinary returns true
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // cp command
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            saveClaudeBinaryToVolume(container);
            expect(spawnSyncMock).toHaveBeenCalledTimes(3);
            // Verify the copy command
            const cpCall = spawnSyncMock.mock.calls[2];
            expect(cpCall[0]).toBe("docker");
            const args = cpCall[1] as string[];
            expect(args).toContain("exec");
            const shCmd = args[args.length - 1];
            expect(shCmd).toContain("cp -L");
            expect(shCmd).toContain(CLAUDE_BIN_PATH);
        });
    });

    describe("ensureClaudeInContainer", () => {
        it("does nothing when valid binary exists at known path", () => {
            // test -x passes
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // isMiseShim returns false
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // isValidClaudeBinary returns true
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            expect(spawnSyncMock).toHaveBeenCalledTimes(3);
        });

        it("removes stale mise shim and does fresh install", () => {
            // test -x passes
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // isMiseShim returns true → remove
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // rm -f
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // volume check fails (no cache)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // fresh install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Detected stale mise shim at claude path, removing...",
            );
            expect(console.log).toHaveBeenCalledWith(
                "Installing claude (first run)...",
            );
        });

        it("throws when fresh install fails", () => {
            // test -x fails (binary doesn't exist)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // volume check fails
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // install fails
            spawnSyncMock.mockReturnValueOnce(makeResult(1));

            expect(() => ensureClaudeInContainer(container)).toThrow(
                "Failed to install claude in container",
            );
        });

        it("removes non-valid binary at CLAUDE_BIN_PATH and falls through to fresh install", () => {
            // test -x passes (binary exists)
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // isMiseShim returns false (not a shim)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // isValidClaudeBinary returns false (not valid claude)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // rm -f the invalid binary
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // volume check fails (no cache)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // fresh install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Binary at claude path is not valid claude, removing...",
            );
            expect(console.log).toHaveBeenCalledWith(
                "Installing claude (first run)...",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(6);
        });

        it("purges volume cache when cached binary is a mise shim then does fresh install", () => {
            // test -x fails (no binary at CLAUDE_BIN_PATH)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // volume check passes (cache exists)
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // isMiseShim on cached binary returns true
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // rm -f cached binary
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // fresh install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Cached claude is a mise shim, purging cache...",
            );
            expect(console.log).toHaveBeenCalledWith(
                "Installing claude (first run)...",
            );
        });

        it("purges volume cache when cached binary is not valid claude then does fresh install", () => {
            // test -x fails (no binary at CLAUDE_BIN_PATH)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // volume check passes (cache exists)
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // isMiseShim on cached binary returns false (not a shim)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // isValidClaudeBinary on cached binary returns false
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // rm -f cached binary
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // fresh install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Cached binary is not valid claude, purging cache...",
            );
            expect(console.log).toHaveBeenCalledWith(
                "Installing claude (first run)...",
            );
        });

        it("restores from cache when volume has valid claude binary (symlink happy path)", () => {
            // test -x fails (no binary at CLAUDE_BIN_PATH)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // volume check passes (cache exists)
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // isMiseShim on cached binary returns false
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // isValidClaudeBinary on cached binary returns true
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // symlink command
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Restoring claude from cache...",
            );
            // 5 calls: test -x, volume check, isMiseShim, isValidClaudeBinary, symlink
            expect(spawnSyncMock).toHaveBeenCalledTimes(5);
            // Verify the symlink command references both paths
            const symlinkCall = spawnSyncMock.mock.calls[4];
            const shCmd = (symlinkCall[1] as string[]).at(-1) as string;
            expect(shCmd).toContain("ln -sf");
            expect(shCmd).toContain(CLAUDE_PERSIST_DIR);
            expect(shCmd).toContain(CLAUDE_BIN_PATH);
        });

        it("no binary and no cache leads to fresh install", () => {
            // test -x fails (no binary at CLAUDE_BIN_PATH)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // volume check fails (no cache)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // fresh install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Installing claude (first run)...",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(3);
        });
    });

    describe("ensureTools", () => {
        it("should be exported as a function", () => {
            expect(typeof ensureTools).toBe("function");
        });

        it("calls ensureClaudeInContainer when activeTool is claude", () => {
            const claudeTool = getDefaultTool();
            // ensureClaudeInContainer: test -x passes, not shim, valid binary
            spawnSyncMock.mockReturnValueOnce(makeResult(0)); // test -x
            spawnSyncMock.mockReturnValueOnce(makeResult(1)); // not shim
            spawnSyncMock.mockReturnValueOnce(makeResult(0)); // valid claude
            // ensureNpmTools: all present
            spawnSyncMock.mockReturnValueOnce(makeResult(0)); // gemini
            spawnSyncMock.mockReturnValueOnce(makeResult(0)); // codex
            spawnSyncMock.mockReturnValueOnce(makeResult(0)); // opencode
            ensureTools(container, claudeTool);
            expect(spawnSyncMock).toHaveBeenCalledTimes(6);
        });

        it("skips ensureClaudeInContainer when activeTool is not claude", () => {
            const geminiTool = getToolByName("gemini")!;
            // ensureNpmTools: all present
            spawnSyncMock.mockReturnValueOnce(makeResult(0)); // gemini
            spawnSyncMock.mockReturnValueOnce(makeResult(0)); // codex
            spawnSyncMock.mockReturnValueOnce(makeResult(0)); // opencode
            ensureTools(container, geminiTool);
            // Only 3 npm checks, no claude install
            expect(spawnSyncMock).toHaveBeenCalledTimes(3);
        });

        it("installs all missing npm tools when none are installed", () => {
            const geminiTool = getToolByName("gemini")!;
            // gemini check: missing
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // codex check: missing
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // opencode check: missing
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // cleanup spawnSync
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // npm install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // wrapper scripts
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureTools(container, geminiTool);
            expect(spawnSyncMock).toHaveBeenCalledTimes(8);
        });

        it("logs warning but does not throw when npm install fails", () => {
            const geminiTool = getToolByName("gemini")!;
            // all missing
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // cleanup
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // npm install fails
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            expect(() => ensureTools(container, geminiTool)).not.toThrow();
            expect(console.warn).toHaveBeenCalledWith(
                "Warning: Failed to install some global npm tools (non-fatal)",
            );
        });

        it("only installs missing tools when some are already present", () => {
            const geminiTool = getToolByName("gemini")!;
            // gemini: present, codex: missing, opencode: present
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // cleanup
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // npm install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // wrapper for codex
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureTools(container, geminiTool);
            expect(console.log).toHaveBeenCalledWith("Installing codex...");
            expect(spawnSyncMock).toHaveBeenCalledTimes(6);
        });
    });
});
