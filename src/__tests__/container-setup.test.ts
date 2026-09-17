import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
    isClaudeVersionLine,
    isMiseShim,
    isValidClaudeBinary,
    saveClaudeBinaryToVolume,
    ensureClaudeInContainer,
    ensureTools,
} = await import("../container-setup.js");

const toolRegistry = await import("../tool-registry.js");
const { getDefaultTool, getToolByName } = toolRegistry;

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

    describe("ensureTools", () => {
        const codexTool = getToolByName("codex")!;
        const npmPrefix = "~/.local/bin/mise exec node@22 -- npm install -g ";

        function scripts(): string[] {
            return spawnSyncMock.mock.calls.map(([, args]) => (args as string[]).at(-1)!);
        }

        function mockNpmSetup(
            missing: string[],
            failure?: { command: string; result: SpawnSyncReturns<string> },
        ): void {
            spawnSyncMock.mockImplementation((_cli, args) => {
                const script = (args as string[]).at(-1)!;
                if (script.startsWith("[ -x ")) return makeResult(0, missing.join("\n"));
                if (failure && script.includes(failure.command)) return failure.result;
                return makeResult(0);
            });
        }

        it("calls ensureClaudeInContainer when activeTool is claude", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            ensureTools(container, getDefaultTool());
            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        });

        it("does nothing beyond readiness when all npm tools are present", () => {
            mockNpmSetup([]);
            ensureTools(container, codexTool);
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
            expect(scripts()[0]).toContain("/home/ccc/.local/bin/codex");
        });

        it("installs missing packages in separate commands and creates each wrapper", () => {
            mockNpmSetup(["gemini", "codex", "opencode"]);
            ensureTools(container, codexTool);
            expect(scripts().filter((script) => script.startsWith(npmPrefix))).toEqual([
                `${npmPrefix}@google/gemini-cli`,
                `${npmPrefix}@openai/codex`,
                `${npmPrefix}opencode-ai`,
            ]);
            for (const cmd of ["gemini", "codex", "opencode"]) {
                expect(scripts().some((script) => script.includes(`cat > /home/ccc/.local/bin/${cmd}`))).toBe(true);
            }
        });

        it.each([false, true])("retains Codex when OpenCode fails (OpenCode first: %s)", (opencodeFirst) => {
            if (opencodeFirst) {
                vi.spyOn(toolRegistry, "getNpmTools").mockReturnValue([
                    { cmd: "opencode", pkg: "opencode-ai" },
                    { cmd: "codex", pkg: "@openai/codex" },
                ]);
            }
            mockNpmSetup(["codex", "opencode"], {
                command: `${npmPrefix}opencode-ai`,
                result: { ...makeResult(1), stderr: "npm error EBADPLATFORM" },
            });

            expect(() => ensureTools(container, codexTool)).not.toThrow();

            expect(scripts().filter((script) => script.startsWith(npmPrefix))).toEqual(
                (opencodeFirst ? ["opencode-ai", "@openai/codex"] : ["@openai/codex", "opencode-ai"])
                    .map((pkg) => `${npmPrefix}${pkg}`),
            );
            expect(scripts().some((script) => script.includes("cat > /home/ccc/.local/bin/codex"))).toBe(true);
            expect(scripts().some((script) => script.includes("cat > /home/ccc/.local/bin/opencode"))).toBe(false);
            expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/install opencode \(opencode-ai\).*EBADPLATFORM/));
        });

        it("reports active installation failure after preserving independent successes", () => {
            mockNpmSetup(["codex", "opencode"], {
                command: `${npmPrefix}@openai/codex`,
                result: { ...makeResult(1), stderr: "npm error EACCES" },
            });

            expect(() => ensureTools(container, codexTool)).toThrow(/install codex \(@openai\/codex\).*EACCES/);
            expect(scripts().some((script) => script.includes("cat > /home/ccc/.local/bin/codex"))).toBe(false);
            expect(scripts().some((script) => script.includes("cat > /home/ccc/.local/bin/opencode"))).toBe(true);
        });

        it.each([
            { ...makeResult(1), stderr: "container is not running" },
            { ...makeResult(0), status: null, error: new Error("spawn docker ENOENT") },
        ])("rejects failed readiness instead of assuming empty stdout means ready", (result) => {
            spawnSyncMock.mockReturnValue(result);
            expect(() => ensureTools(container, codexTool)).toThrow(/check.*codex.*(container is not running|spawn docker ENOENT)/);
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("includes the spawn cause when active package installation cannot launch", () => {
            mockNpmSetup(["codex"], {
                command: `${npmPrefix}@openai/codex`,
                result: { ...makeResult(0), status: null, error: new Error("spawn docker ENOENT") },
            });
            expect(() => ensureTools(container, codexTool)).toThrow(/install codex \(@openai\/codex\).*spawn docker ENOENT/);
        });

        it("fails active setup when its wrapper cannot be created", () => {
            mockNpmSetup(["codex"], {
                command: "cat > /home/ccc/.local/bin/codex",
                result: { ...makeResult(1), stderr: "Permission denied" },
            });
            expect(() => ensureTools(container, codexTool)).toThrow(/wrapper.*codex \(@openai\/codex\).*Permission denied/);
        });

        it.skipIf(process.platform === "win32").each(["write", "chmod", "success"])(
            "runs wrapper shell with correct cleanup when outcome is %s",
            async (outcome) => {
                mockNpmSetup(["codex"]);
                ensureTools(container, codexTool);
                const script = scripts().find((command) => command.includes("cat > /home/ccc/.local/bin/codex"))!;
                const { spawnSync: actualSpawnSync } = await vi.importActual<typeof import("child_process")>("child_process");
                const directory = mkdtempSync(join(tmpdir(), "ccc-wrapper-test-"));
                const wrapper = join(directory, "codex");
                const failure = outcome === "write"
                    ? "cat() { printf partial; return 1; }\n"
                    : outcome === "chmod" ? "chmod() { return 1; }\n" : "";
                try {
                    const result = actualSpawnSync("sh", ["-c", failure + script.replaceAll("/home/ccc/.local/bin/codex", '"$CCC_TEST_WRAPPER_PATH"')], {
                        encoding: "utf-8",
                        env: { ...process.env, CCC_TEST_WRAPPER_PATH: wrapper },
                    });
                    expect(result.error).toBeUndefined();
                    if (outcome === "success") {
                        expect(result.status).toBe(0);
                        expect(readFileSync(wrapper, "utf-8")).toBe('#!/bin/sh\nexec ~/.local/bin/mise exec node@22 -- codex "$@"\n');
                        expect(statSync(wrapper).mode & 0o111).not.toBe(0);
                    } else {
                        expect(result.status).not.toBe(0);
                        expect(existsSync(wrapper)).toBe(false);
                    }
                } finally {
                    rmSync(directory, { recursive: true, force: true });
                }
            },
        );

        it("warns and continues when an optional wrapper cannot be created", () => {
            mockNpmSetup(["gemini", "codex"], {
                command: "cat > /home/ccc/.local/bin/gemini",
                result: { ...makeResult(1), stderr: "No space left on device" },
            });
            expect(() => ensureTools(container, codexTool)).not.toThrow();
            expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/wrapper.*gemini \(@google\/gemini-cli\).*No space left on device/));
            expect(scripts().some((script) => script.includes("cat > /home/ccc/.local/bin/codex"))).toBe(true);
        });

        it("only installs missing tools", () => {
            mockNpmSetup(["codex"]);
            ensureTools(container, codexTool);
            expect(scripts().filter((script) => script.startsWith(npmPrefix))).toEqual([`${npmPrefix}@openai/codex`]);
        });

        it("only checks and repairs the selected npm tool in active-only mode", () => {
            mockNpmSetup(["codex"]);
            ensureTools(container, codexTool, { activeOnly: true });
            expect(scripts()[0]).toContain("/home/ccc/.local/bin/codex");
            expect(scripts()[0]).not.toMatch(/gemini|opencode/);
            expect(scripts().filter((script) => script.startsWith(npmPrefix))).toEqual([`${npmPrefix}@openai/codex`]);
        });

        it("skips npm checks for Claude in active-only mode", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n"));
            ensureTools(container, getDefaultTool(), { activeOnly: true });
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });
    });
});
