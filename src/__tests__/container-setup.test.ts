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
    ensureGlobalNpmTools,
} = await import("../container-setup.js");

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
        // The new implementation uses a single docker exec with a shell script
        // that returns VALID, RESTORED, or INSTALL as stdout.

        it("does nothing when valid binary exists at known path", () => {
            // Single probe script returns VALID
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n"));
            ensureClaudeInContainer(container);
            // Only 1 call: the combined probe script
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("restores from cache when volume has valid claude binary", () => {
            // Single probe script returns RESTORED (cache found and symlinked)
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "RESTORED\n"));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Restored claude from cache.",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("does fresh install when probe returns INSTALL", () => {
            // Probe returns INSTALL (no valid binary at either path)
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n"));
            // Fresh install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Installing claude (first run)...",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        });

        it("throws when fresh install fails", () => {
            // Probe returns INSTALL
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n"));
            // Install fails
            spawnSyncMock.mockReturnValueOnce(makeResult(1));

            expect(() => ensureClaudeInContainer(container)).toThrow(
                "Failed to install claude in container",
            );
        });

        it("falls through to install on unexpected probe output", () => {
            // Probe returns unexpected output
            spawnSyncMock.mockReturnValueOnce(makeResult(1, ""));
            // Fresh install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Installing claude (first run)...",
            );
        });

        it("probe script checks both bin path and cache path", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n"));
            ensureClaudeInContainer(container);
            const probeCall = spawnSyncMock.mock.calls[0];
            const shCmd = (probeCall[1] as string[]).at(-1) as string;
            expect(shCmd).toContain(CLAUDE_BIN_PATH);
            expect(shCmd).toContain(CLAUDE_PERSIST_DIR);
            expect(shCmd).toContain("is_shim");
            expect(shCmd).toContain("is_claude");
        });

        it("install command caches binary to volume", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            const installCall = spawnSyncMock.mock.calls[1];
            const shCmd = (installCall[1] as string[]).at(-1) as string;
            expect(shCmd).toContain("curl -fsSL");
            expect(shCmd).toContain(CLAUDE_PERSIST_DIR);
        });
    });

    describe("ensureGlobalNpmTools", () => {
        // The new implementation uses a single docker exec to check all tools at once.

        it("should be exported as a function", () => {
            expect(typeof ensureGlobalNpmTools).toBe("function");
        });

        it("does nothing when all tools are already installed", () => {
            // Single combined check returns empty stdout (all present)
            spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));
            ensureGlobalNpmTools(container);
            // Only 1 combined check call, no install
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
            expect(console.log).not.toHaveBeenCalled();
        });

        it("installs all missing tools when none are installed and creates wrapper scripts", () => {
            // Combined check returns both missing
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\ncodex\n"));
            // cleanup spawnSync
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // npm install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // wrapper script for gemini
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // wrapper script for codex
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureGlobalNpmTools(container);
            // 1 check + cleanup + install + 2 wrappers = 5 calls
            expect(spawnSyncMock).toHaveBeenCalledTimes(5);
            // Verify wrapper script calls reference the tool names
            const geminiWrapperCall = spawnSyncMock.mock.calls[3];
            const geminiCmd = (geminiWrapperCall[1] as string[]).at(-1) as string;
            expect(geminiCmd).toContain("gemini");
            const codexWrapperCall = spawnSyncMock.mock.calls[4];
            const codexCmd = (codexWrapperCall[1] as string[]).at(-1) as string;
            expect(codexCmd).toContain("codex");
        });

        it("logs warning but does not throw when npm install fails", () => {
            // Combined check returns both missing
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\ncodex\n"));
            // cleanup spawnSync
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // npm install fails
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // Should not throw
            expect(() => ensureGlobalNpmTools(container)).not.toThrow();
            expect(console.warn).toHaveBeenCalledWith(
                "Warning: Failed to install some global npm tools (non-fatal)",
            );
            // No wrapper scripts created (install failed, early return after warn)
            expect(spawnSyncMock).toHaveBeenCalledTimes(3);
        });

        it("only installs missing tools when some are already present", () => {
            // Combined check returns only codex missing
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "codex\n"));
            // cleanup spawnSync
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // npm install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // wrapper script for codex only
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureGlobalNpmTools(container);
            expect(console.log).toHaveBeenCalledWith("Installing codex...");
            // 1 check + cleanup + install + 1 wrapper = 4 calls
            expect(spawnSyncMock).toHaveBeenCalledTimes(4);
            // Verify the npm install call contains only the missing package
            const installCall = spawnSyncMock.mock.calls[2];
            const installCmd = (installCall[1] as string[]).at(-1) as string;
            expect(installCmd).toContain("@openai/codex");
            expect(installCmd).not.toContain("@google/gemini-cli");
        });

        it("creates wrapper scripts with correct content for each missing tool", () => {
            // Combined check returns only gemini missing
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\n"));
            // cleanup spawnSync
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // npm install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // wrapper script for gemini
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureGlobalNpmTools(container);
            // 1 check + cleanup + install + 1 wrapper = 4 calls
            expect(spawnSyncMock).toHaveBeenCalledTimes(4);
            const wrapperCall = spawnSyncMock.mock.calls[3];
            const wrapperCmd = (wrapperCall[1] as string[]).at(-1) as string;
            // Should contain shebang and exec pattern
            expect(wrapperCmd).toContain("#!/bin/sh");
            expect(wrapperCmd).toContain("exec");
            expect(wrapperCmd).toContain("mise exec node@22");
            expect(wrapperCmd).toContain("gemini");
            expect(wrapperCmd).toContain("chmod +x");
        });
    });
});
