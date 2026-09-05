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
    CLAUDE_DATA_DIR,
    CLAUDE_DATA_VOLUME_DIR,
    CLAUDE_LEGACY_CACHE_FILE,
    CLAUDE_EXECUTABLE,
    CLAUDE_BIN_PATH,
    CONTAINER_TOOL_PROBE_TIMEOUT_MS,
    CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS,
    CONTAINER_TOOL_MUTATION_TIMEOUT_MS,
    ensureClaudeInContainer,
    ensureUvAvailable,
    ensureTools,
} = await import("../container-setup.js");

const { getDefaultTool, getToolByName } = await import("../tool-registry.js");

function makeResult(status: number, stdout = "", stderr = ""): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr, status, signal: null };
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

    describe("what a successful start still tells the user", () => {
        // The probe can change state every project on the host shares — removing
        // a version name held by a link — and succeed. That was reported on
        // none of the paths where it happens: dropped on VALID, dropped on the
        // first probe of an INSTALL, which is the one that does the removing.
        const note = "removed 2.1.261: a version must be a real file, not a symlink"

        it("reports a shared-volume change on a start that needed nothing else", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n", `${note}\n`))

            ensureClaudeInContainer(container)

            expect(console.log).toHaveBeenCalledWith(note)
        })

        it("reports it on the reuse path", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "RESTORED 2.1.261\n", `${note}\n`))

            ensureClaudeInContainer(container)

            expect(console.log).toHaveBeenCalledWith(note)
        })

        it("reports the removal that unblocked an install, from the probe that did it", () => {
            // The confirm probe cannot report it: by then the entry is gone and
            // it has nothing to say. Only the first probe knows.
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n", `${note}\n`))
            spawnSyncMock.mockReturnValueOnce(makeResult(0))
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "RESTORED 2.1.261\n"))

            ensureClaudeInContainer(container)

            expect(console.log).toHaveBeenCalledWith(note)
        })

        it("says a persisting failure once, not once per probe", () => {
            const stuck = "cannot remove 2.1.261: a version must be a real file, not a symlink"
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n", `${stuck}\n`))
            spawnSyncMock.mockReturnValueOnce(makeResult(0))
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "RESTORED 2.1.261\n", `${stuck}\n`))

            ensureClaudeInContainer(container)

            const said = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
                .filter(call => call[0] === stuck)
            expect(said).toHaveLength(1)
        })

        it("does not relay the noise of the tools the probe calls", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n",
                "rm: cannot remove '/vol/versions/2.1.261': Permission denied\n"))

            ensureClaudeInContainer(container)

            expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Permission denied"))
        })

        it("strips control bytes out of a name it repeats", () => {
            // The name comes from a volume every project can write to, so it is
            // data on its way to a terminal, not text to trust.
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n",
                "removed 2.1.261\u001b[31mHACK: a version must be a real file, not a symlink\n"))

            ensureClaudeInContainer(container)

            expect(console.log).toHaveBeenCalledWith(
                "removed 2.1.261?[31mHACK: a version must be a real file, not a symlink")
        })
    })

    describe("constants", () => {
        it("puts the claude data dir inside the persistent named volume", () => {
            // /home/ccc/.local/share/mise is the ccc-mise-cache volume mount.
            // versions/ has to live under it or an in-container `claude update`
            // is discarded when the container is recreated.
            expect(CLAUDE_DATA_VOLUME_DIR).toBe(
                "/home/ccc/.local/share/mise/.claude-data",
            );
            expect(CLAUDE_DATA_DIR).toBe("/home/ccc/.local/share/claude");
        });

        it("still knows the pre-symlink cache path, for migration only", () => {
            expect(CLAUDE_LEGACY_CACHE_FILE).toBe(
                "/home/ccc/.local/share/mise/.claude-bin/claude",
            );
        });

        it("exports CLAUDE_EXECUTABLE", () => {
            expect(CLAUDE_EXECUTABLE).toBe("claude");
        });

        it("exports CLAUDE_BIN_PATH", () => {
            expect(CLAUDE_BIN_PATH).toBe("/home/ccc/.local/bin/claude");
        });
    });

    describe("ensureClaudeInContainer", () => {
        // This describe covers orchestration only: how many docker execs run,
        // which statuses are accepted, and how failures surface. What the probe
        // script actually DOES to the filesystem is covered by executing it, in
        // claude-launcher-layout.test.ts — substring assertions on generated
        // shell are what let the launcher bug live here undetected.

        it("does nothing when the launcher is already correct", () => {
            // Single probe script returns VALID
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n"));
            ensureClaudeInContainer(container);
            // Only 1 call: the combined probe script
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("names the version it reused, because that is the question this line answers", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "RESTORED 2.1.261\n"));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Reusing claude 2.1.261 from the shared volume.",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
        });

        it("still reports a reuse when the probe names no version", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "RESTORED\n"));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Reusing claude from the shared volume.",
            );
        });

        it("puts the probe's stderr into the failure, so the cause is not lost", () => {
            spawnSyncMock.mockReturnValueOnce({
                ...makeResult(1, ""),
                stderr: "cp: cannot create regular file: Read-only file system\n",
            });
            expect(() => ensureClaudeInContainer(container)).toThrow(
                /Read-only file system/,
            );
        });

        it("installs, then re-probes to confirm the installer left a usable launcher", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "RESTORED\n"));
            ensureClaudeInContainer(container);
            expect(console.log).toHaveBeenCalledWith(
                "Installing claude (first run)...",
            );
            expect(spawnSyncMock).toHaveBeenCalledTimes(3);
        });

        it("throws when the installer exits 0 but leaves nothing usable", () => {
            // `curl | bash` succeeding is not evidence the launcher exists.
            // Without this the failure surfaced much later, as an unexplained
            // "tool is unavailable after setup".
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n"));
            expect(() => ensureClaudeInContainer(container)).toThrow(
                "Claude installation left no usable launcher",
            );
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

        it("runs the probe against the real container paths", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "VALID\n"));
            ensureClaudeInContainer(container);
            const shCmd = (spawnSyncMock.mock.calls[0][1] as string[]).at(-1) as string;
            expect(shCmd).toContain(CLAUDE_BIN_PATH);
            expect(shCmd).toContain(CLAUDE_DATA_DIR);
            expect(shCmd).toContain(CLAUDE_DATA_VOLUME_DIR);
            expect(shCmd).toContain(CLAUDE_LEGACY_CACHE_FILE);
        });

        it("hands the install step nothing but the installer", () => {
            // The old install command appended `cp -L $CACHE $BIN`, which is the
            // line that flattened the launcher into a regular file. The native
            // installer creates the symlink itself; ccc must not overwrite it.
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "INSTALL\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "RESTORED\n"));
            ensureClaudeInContainer(container);
            const shCmd = (spawnSyncMock.mock.calls[1][1] as string[]).at(-1) as string;
            expect(shCmd).toContain("curl -fsSL");
            expect(shCmd).not.toContain("cp -L");
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
