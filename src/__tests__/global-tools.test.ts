import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "MISSING\n")); // persisted binary probe
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale shims
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // npm install success
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // mise reshim
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper gemini
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // requested-tool proof

        ensureTools(container, getToolByName("gemini")!);

        expect(spawnSyncMock).toHaveBeenCalledTimes(8);

        // Verify install command uses mise exec node@22 (index 3 after cleanup)
        const installCall = spawnSyncMock.mock.calls[4];
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
        const wrapperCall = spawnSyncMock.mock.calls[6];
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
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "MISSING\n")); // persisted binary probe
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale dirs
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // cleanup stale shims
        spawnSyncMock.mockReturnValueOnce(makeResult(1)); // npm install FAIL

        expect(() => ensureTools(container, getToolByName("gemini")!)).toThrow(
            "Container gemini installation failed",
        );

        // 1 check + 2 cleanups + failed install; no later mutation or proof.
        expect(spawnSyncMock).toHaveBeenCalledTimes(5);
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
    it("restores a healthy cached tool wrapper without installs or shim removal", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "READY\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // executable proof
        ensureTools(container, getToolByName("gemini")!);
        expect(spawnSyncMock).toHaveBeenCalledTimes(4);
        const commands = spawnSyncMock.mock.calls.map(call => (call[1] as string[]).at(-1)).join("\n");
        expect(commands).toContain("MISE_OFFLINE=1");
        expect(commands).toContain('"$node_dir/bin/gemini" --version');
        expect(commands).toContain("chmod +x /home/ccc/.local/bin/gemini");
        expect(commands).not.toContain("npm install");
        expect(commands).not.toContain("rm -f ~/.local/share/mise/shims");
        expect(commands).not.toContain("mise reshim");
    });

    it.each([1, 42, 126, 127, 124, 137])("does not reinstall when persisted binary verification fails with %s", status => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(status));
        expect(() => ensureTools(container, getToolByName("gemini")!)).toThrow(/cached executable probe/);
        expect(spawnSyncMock).toHaveBeenCalledTimes(2);
        const commands = spawnSyncMock.mock.calls.map(call => (call[1] as string[]).at(-1)).join("\n");
        expect(commands).not.toMatch(/npm install|rm -rf|rm -f|mise reshim|cat > /);
    });

    it("rejects unexpected cache probe output before changing the installation", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "noise\nREADY\n"));
        expect(() => ensureTools(container, getToolByName("gemini")!)).toThrow("invalid result");
        expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    });

    it("fails when a cached tool wrapper cannot be created", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "gemini\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "READY\n"));
        spawnSyncMock.mockReturnValueOnce(makeResult(1));
        expect(() => ensureTools(container, getToolByName("gemini")!)).toThrow("wrapper creation failed");
        expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    });
        // This runs the Linux container probe verbatim, including coreutils timeout.
        it.skipIf(process.platform !== "linux").each([
            "healthy", "missing", "broken", "runtime-missing", "missing-node", "resolver-failure", "timeout", "killed", "missing-timeout",
        ])("executes the persisted binary probe with %s state and a PATH decoy", async (outcome) => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "codex\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(0, "READY\n"));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce(makeResult(0)); // upstream bubblewrap readiness
            ensureTools(container, getToolByName("codex")!);
            const script = (spawnSyncMock.mock.calls[1][1] as string[]).at(-1)!;
            const { spawnSync: actualSpawnSync } = await vi.importActual<typeof import("child_process")>("child_process");
            const directory = mkdtempSync(join(tmpdir(), "ccc-persisted-tool-"));
            const bin = join(directory, ".local", "share", "mise", "installs", "node", "22.0.0", "bin");
            const localBin = join(directory, ".local", "bin");
            const decoy = join(directory, "decoy");
            const marker = join(directory, "executed");
            mkdirSync(bin, { recursive: true });
            mkdirSync(localBin, { recursive: true });
            mkdirSync(decoy);
            writeFileSync(join(localBin, "mise"), `#!/bin/sh
if [ "$1 $2 $3" = 'exec node@22 --' ]; then
    shift 3
    PATH="$CCC_TEST_NODE_DIR/bin:$PATH" exec "$@"
fi
[ "$MISE_OFFLINE" = 1 ] && [ "$*" = 'where node@22' ] || exit 92
if [ "$CCC_TEST_OUTCOME" = resolver-failure ]; then echo 'mise resolution failed' >&2; exit 7; fi
printf '%s\\n' "$CCC_TEST_NODE_DIR"
`, { mode: 0o755 });
            if (outcome !== "missing-node") writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
            writeFileSync(join(decoy, "codex"), '#!/bin/sh\nprintf decoy > "$CCC_TEST_MARKER"\n', { mode: 0o755 });
            if (outcome !== "missing") writeFileSync(join(bin, "codex"), `#!/bin/sh
[ "$1" = --version ] && [ "\${PATH%%:*}" = "$CCC_TEST_NODE_DIR/bin" ] || exit 91
printf actual > "$CCC_TEST_MARKER"
if [ "$CCC_TEST_OUTCOME" = timeout ]; then sleep 5; fi
if [ "$CCC_TEST_OUTCOME" = killed ]; then kill -KILL $$; fi
if [ "$CCC_TEST_OUTCOME" = broken ]; then echo 'broken package' >&2; exit 1; fi
if [ "$CCC_TEST_OUTCOME" = runtime-missing ]; then echo 'runtime dependency missing' >&2; exit 127; fi
printf '1.0.0\\n'
`, { mode: 0o755 });
            try {
                const probe = actualSpawnSync("/bin/sh", ["-c", script
                    .replaceAll("~/.local/", '"$CCC_TEST_HOME"/.local/')
                    .replaceAll("$HOME", "$CCC_TEST_HOME")
                    .replaceAll("/usr/bin/timeout", outcome === "missing-timeout" ? '"$CCC_TEST_HOME"/missing-timeout' : "/usr/bin/timeout")
                    .replace("timeout -k 1s 10s", "timeout -k 0.05s 0.05s")], {
                    encoding: "utf-8", timeout: 2_000,
                    env: {
                        ...process.env, MISE_DATA_DIR: join(directory, ".local", "share", "mise"),
                        PATH: outcome === "missing-timeout" ? decoy : `${decoy}:/usr/bin:/bin`,
                        CCC_TEST_HOME: directory, CCC_TEST_NODE_DIR: join(bin, ".."),
                        CCC_TEST_OUTCOME: outcome, CCC_TEST_MARKER: marker,
                    },
                });
                expect(probe.error).toBeUndefined();
                if (["broken", "runtime-missing", "resolver-failure", "timeout", "killed", "missing-timeout"].includes(outcome)) {
                    expect(probe.status).not.toBe(0);
                    expect(probe.stderr).toMatch(/broken package|runtime dependency missing|mise resolution failed|Timed out verifying|was killed \(exit 137\)|requires timeout/);
                    if (outcome === "broken") expect(probe.status).toBe(1);
                    if (outcome === "runtime-missing") expect(probe.status).toBe(127);
                    if (outcome === "timeout") expect(probe.status).toBe(124);
                    if (outcome === "killed") expect(probe.status).toBe(137);
                } else {
                    expect(probe.status).toBe(0);
                    expect(probe.stdout.trim()).toBe(outcome === "healthy" ? "READY" : "MISSING");
                }
                if (existsSync(marker)) expect(readFileSync(marker, "utf-8")).toBe("actual");
                if (["missing", "missing-node"].includes(outcome)) expect(existsSync(marker)).toBe(false);
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        });

    it("prepares selected OpenCode data before probing an existing wrapper", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // data access
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // wrapper exists
        spawnSyncMock.mockReturnValueOnce(makeResult(0)); // ready
        ensureTools(container, getToolByName("opencode")!);
        expect(spawnSyncMock).toHaveBeenCalledTimes(3);
        expect((spawnSyncMock.mock.calls[0][1] as string[]).at(-1)).toContain("dir=/home/ccc/.local/share/opencode");
        expect((spawnSyncMock.mock.calls[1][1] as string[]).at(-1)).toContain("[ -x /home/ccc/.local/bin/opencode ]");
    });

    it("stops selected OpenCode setup when data access cannot be checked", () => {
        spawnSyncMock.mockReturnValueOnce(makeResult(127));
        expect(() => ensureTools(container, getToolByName("opencode")!)).toThrow("Unable to prepare OpenCode data");
        expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    });

});
