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
    CLAUDE_EXECUTABLE,
    CLAUDE_BIN_PATH,
    CONTAINER_TOOL_PROBE_TIMEOUT_MS,
    CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS,
    CONTAINER_TOOL_MUTATION_TIMEOUT_MS,
    isClaudeVersionLine,
    isMiseShim,
    isValidClaudeBinary,
    saveClaudeBinaryToVolume,
    ensureClaudeInContainer,
    ensureUvAvailable,
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

        it("exports CLAUDE_EXECUTABLE", () => {
            expect(CLAUDE_EXECUTABLE).toBe("claude");
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
        it("accepts Claude Code version lines", () => {
            expect(isClaudeVersionLine("2.1.158")).toBe(true);
            expect(isClaudeVersionLine("1.0.83 (Claude Code)")).toBe(true);
            expect(isClaudeVersionLine("Claude Code 1.0.83")).toBe(true);
        });

        it("rejects Bun crash output even when it mentions the claude path", () => {
            expect(isClaudeVersionLine("============================================================")).toBe(false);
            expect(isClaudeVersionLine('Args: "/home/ccc/.local/bin/claude" "--dangerously-skip-permissions"')).toBe(false);
            expect(isClaudeVersionLine("Bun v1.3.14 (521eedd6) Linux x64")).toBe(false);
        });

        it("returns true when --version has Claude Code version shape", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            expect(isValidClaudeBinary(container, "/usr/bin/claude")).toBe(true);

            const shCmd = (spawnSyncMock.mock.calls[0][1] as string[]).at(-1) as string;
            expect(shCmd).toContain("head -n 1");
            expect(shCmd).toContain("claude([[:space:]]+code)?");
        });

        it("returns false when --version does not match Claude Code version shape", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            expect(isValidClaudeBinary(container, "/usr/bin/claude")).toBe(
                false,
            );
        });
    });

    describe("saveClaudeBinaryToVolume", () => {
        it("skips saving if binary is a mise shim", () => {
            // command -v claude resolves
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "/home/ccc/.claude/local/claude\n"));
            // isMiseShim returns true (status 0)
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            saveClaudeBinaryToVolume(container);
            // resolve + isMiseShim, no copy
            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        });

        it("skips saving if binary is not valid claude", () => {
            // command -v claude resolves
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "/home/ccc/.claude/local/claude\n"));
            // isMiseShim returns false (status 1)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // isValidClaudeBinary returns false (status 1)
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            saveClaudeBinaryToVolume(container);
            // 3 calls: resolve + isMiseShim + isValidClaudeBinary, no copy
            expect(spawnSyncMock).toHaveBeenCalledTimes(3);
        });

        it("copies binary when valid and not a shim", () => {
            // command -v claude resolves
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "/home/ccc/.claude/local/claude\n"));
            // isMiseShim returns false
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            // isValidClaudeBinary returns true
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // cp command
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            saveClaudeBinaryToVolume(container);
            expect(spawnSyncMock).toHaveBeenCalledTimes(4);
            // Verify the copy command
            const cpCall = spawnSyncMock.mock.calls[3];
            expect(cpCall[0]).toBe("docker");
            const args = cpCall[1] as string[];
            expect(args).toContain("exec");
            const shCmd = args[args.length - 1];
            expect(shCmd).toContain("cp -L");
            expect(shCmd).toContain("/home/ccc/.claude/local/claude");
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
            // Single probe script returns RESTORED (cache found and copied back)
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
                "Claude installation failed",
            );
        });

        it("fails closed on an unsuccessful probe", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(1, ""));
            expect(() => ensureClaudeInContainer(container)).toThrow(
                "Claude readiness probe failed",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("fails closed when the probe times out", () => {
            spawnSyncMock.mockReturnValueOnce({
                ...makeResult(0),
                status: null,
                error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
            });
            expect(() => ensureClaudeInContainer(container)).toThrow(
                "Claude readiness probe timed out",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("fails closed on an invalid successful probe response", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "UNKNOWN\n"));
            expect(() => ensureClaudeInContainer(container)).toThrow(
                "Claude readiness probe returned an invalid result",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("probe script checks both bin path and cache path", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n"));
            ensureClaudeInContainer(container);
            const probeCall = spawnSyncMock.mock.calls[0];
            const shCmd = (probeCall[1] as string[]).at(-1) as string;
            expect(shCmd).toContain(CLAUDE_BIN_PATH);
            expect(shCmd).toContain(CLAUDE_PERSIST_DIR);
            expect(shCmd).toContain("command -v claude");
            expect(shCmd).toContain("is_shim");
            expect(shCmd).toContain("is_claude");
            expect(shCmd).toContain("head -n 1");
            expect(shCmd).toContain("claude([[:space:]]+code)?");
        });

        it("install command caches binary to volume", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureClaudeInContainer(container);
            const installCall = spawnSyncMock.mock.calls[1];
            const shCmd = (installCall[1] as string[]).at(-1) as string;
            expect(shCmd).toContain("curl -fsSL");
            expect(shCmd).toContain("command -v claude");
            expect(shCmd).toContain(CLAUDE_PERSIST_DIR);
            expect(shCmd).toContain(`cp -L ${CLAUDE_PERSIST_DIR}/claude ${CLAUDE_BIN_PATH}`);
        });
    });

    describe("ensureUvAvailable", () => {
        it("does not install uv when the bounded probe succeeds", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureUvAvailable(container);
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker",
                expect.any(Array),
                expect.objectContaining({ timeout: CONTAINER_TOOL_PROBE_TIMEOUT_MS }),
            );
        });

        it("fails closed when the uv probe times out", () => {
            spawnSyncMock.mockReturnValueOnce({
                ...makeResult(0),
                status: null,
                error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
            });
            expect(() => ensureUvAvailable(container)).toThrow("Container uv probe timed out");
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("installs uv only after an absent result and rejects install failure", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            expect(() => ensureUvAvailable(container)).toThrow("Container uv installation failed");
            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        });
    });

    describe("ensureTools", () => {
        it("should be exported as a function", () => {
            expect(typeof ensureTools).toBe("function");
        });

        it("calls ensureClaudeInContainer when activeTool is claude", () => {
            const claudeTool = getDefaultTool();
            // ensureClaudeInContainer: combined probe returns VALID
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n"));
            // requested-tool readiness proof
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureTools(container, claudeTool);
            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        });

        it("skips ensureClaudeInContainer when activeTool is not claude", () => {
            const geminiTool = getToolByName("gemini")!;
            // Active npm tool exists.
            spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));
            // requested-tool readiness proof
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureTools(container, geminiTool);
            // Combined npm check + exact requested-tool proof, no claude install
            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        });

        it("installs only the requested npm tool", () => {
            const geminiTool = getToolByName("gemini")!;
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\n"));
            // cleanup partial install dirs
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // stale shim nuke
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // npm install succeeds
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // mise reshim
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // wrapper scripts
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // requested-tool readiness proof
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureTools(container, geminiTool);
            // check + cleanup + shim-nuke + install + reshim + wrapper + proof
            expect(spawnSyncMock).toHaveBeenCalledTimes(7);
            const geminiWrapperCall = spawnSyncMock.mock.calls[5];
            const geminiCmd = (geminiWrapperCall[1] as string[]).at(-1) as string;
            expect(geminiCmd).toContain("gemini");
            const installCmd = (spawnSyncMock.mock.calls[3][1] as string[]).at(-1) as string;
            expect(installCmd).toContain("@google/gemini-cli");
            expect(installCmd).not.toContain("@openai/codex");
            expect(installCmd).not.toContain("opencode-ai");
        });

        it("fails closed when npm install leaves the requested tool unavailable", () => {
            const geminiTool = getToolByName("gemini")!;
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\n"));
            // cleanup
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // stale shim nuke
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            // npm install fails
            spawnSyncMock.mockReturnValueOnce(makeResult(1));
            expect(() => ensureTools(container, geminiTool)).toThrow(
                "Container gemini installation failed",
            );
            // Later mutations and readiness proof must not run.
            expect(spawnSyncMock).toHaveBeenCalledTimes(4);
        });

        it("stops before installation when cleanup times out", () => {
            const codexTool = getToolByName("codex")!;
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "codex\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(124));

            expect(() => ensureTools(container, codexTool)).toThrow(
                "Container codex cleanup timed out",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
            const cleanupCommand = (spawnSyncMock.mock.calls[1][1] as string[]).at(-1) as string;
            expect(cleanupCommand).toContain("timeout -k 2s 8s");
            expect(cleanupCommand).not.toContain("npm install -g");
            expect(spawnSyncMock.mock.calls[1][2]).toEqual(
                expect.objectContaining({ timeout: CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS }),
            );
        });

        it("stops before wrapper creation when reshim fails", () => {
            const codexTool = getToolByName("codex")!;
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "codex\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(1));

            expect(() => ensureTools(container, codexTool)).toThrow(
                "Container codex reshim failed",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(5);
        });

        it("does not inspect or install inactive npm tools", () => {
            const geminiTool = getToolByName("gemini")!;
            // Gemini exists even if other registered tools do not.
            spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureTools(container, geminiTool);
            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
            const probe = (spawnSyncMock.mock.calls[0][1] as string[]).at(-1) as string;
            expect(probe).toContain("gemini");
            expect(probe).not.toContain("codex");
            expect(probe).not.toContain("opencode");
            expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Installing"));
        });

        it("fails closed when the initial readiness probe cannot inspect the container", () => {
            const codexTool = getToolByName("codex")!;
            spawnSyncMock.mockReturnValueOnce(makeResult(1, ""));

            expect(() => ensureTools(container, codexTool)).toThrow(
                "Container npm tool probe failed",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("fails with a bounded error when the npm probe times out", () => {
            const codexTool = getToolByName("codex")!;
            spawnSyncMock.mockReturnValueOnce({
                ...makeResult(0),
                status: null,
                error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
            });

            expect(() => ensureTools(container, codexTool)).toThrow(
                "Container npm tool probe timed out",
            );
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker",
                expect.any(Array),
                expect.objectContaining({ timeout: CONTAINER_TOOL_PROBE_TIMEOUT_MS }),
            );
        });

        it("fails with a bounded error when the final readiness proof times out", () => {
            const codexTool = getToolByName("codex")!;
            spawnSyncMock.mockReturnValueOnce(makeResult(0, ""));
            spawnSyncMock.mockReturnValueOnce({
                ...makeResult(0),
                status: null,
                error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
            });

            expect(() => ensureTools(container, codexTool)).toThrow(
                "Requested tool codex readiness check timed out",
            );
            expect(spawnSyncMock).toHaveBeenLastCalledWith(
                "docker",
                ["exec", container, "test", "-x", "/home/ccc/.local/bin/codex"],
                { stdio: "ignore", timeout: CONTAINER_TOOL_PROBE_TIMEOUT_MS },
            );
        });
    });
});
