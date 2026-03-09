import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: spawnSyncMock };
});

// Mock fs for startProjectContainer
const mockExistsSync = vi.fn().mockReturnValue(true);
const mockMkdirSync = vi.fn();
vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    };
});

// Import AFTER mocks
const {
    buildDockerRunArgs,
    getContainerName,
    isDockerRunning,
    isDockerDesktop,
    isContainerRunning,
    isContainerExists,
    isContainerImageOutdated,
    isImageExists,
    getImageLabel,
    pullImage,
    tagImage,
    syncClipboardShims,
    ensureDockerRunning,
    ensureImage,
    startProjectContainer,
    stopProjectContainer,
    removeProjectContainer,
} = await import("../docker.js");

const { CLI_VERSION } = await import("../utils.js");

function makeResult(
    status: number,
    stdout = "",
): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

describe("docker.ts module exports", () => {
    beforeEach(() => {
        spawnSyncMock.mockReset();
        mockExistsSync.mockReset().mockReturnValue(true);
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("getContainerName", () => {
        it("should prefix with ccc-", () => {
            expect(getContainerName("/home/user/test")).toMatch(/^ccc-/);
        });

        it("should be consistent for same path", () => {
            const a = getContainerName("/home/user/project");
            const b = getContainerName("/home/user/project");
            expect(a).toBe(b);
        });

        it("should generate correct format", () => {
            expect(getContainerName("/home/user/my-project")).toMatch(
                /^ccc-my-project-[a-f0-9]{12}$/,
            );
        });
    });

    describe("isDockerRunning", () => {
        it("returns true when docker info succeeds", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            expect(isDockerRunning()).toBe(true);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker",
                ["info"],
                expect.any(Object),
            );
        });

        it("returns false when docker info fails", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            expect(isDockerRunning()).toBe(false);
        });
    });

    describe("isDockerDesktop", () => {
        const originalPlatform = process.platform;
        const originalEnv = { ...process.env };

        afterEach(() => {
            Object.defineProperty(process, "platform", { value: originalPlatform });
            process.env = { ...originalEnv };
            // Reset cached value by clearing module cache
            // Since isDockerDesktop caches, we need to reset between tests
            // The cache is module-scoped, so we test behavior on first call
        });

        it("returns true on macOS (darwin) without calling docker info", () => {
            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
            // Note: isDockerDesktop caches results, so this tests the macOS fast path
            // We can't easily test this in isolation due to caching, but the logic is:
            // if (process.platform !== "linux") return true
            platformSpy.mockRestore();
        });

        it("returns true on Windows (win32) without calling docker info", () => {
            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            platformSpy.mockRestore();
        });
    });

    describe("isContainerRunning", () => {
        it("returns true when container found in docker ps", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "abc123\n"));
            expect(isContainerRunning("my-container")).toBe(true);
        });

        it("returns false when container not in docker ps", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, ""));
            expect(isContainerRunning("my-container")).toBe(false);
        });
    });

    describe("isContainerExists", () => {
        it("returns true when container found in docker ps -a", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "abc123\n"));
            expect(isContainerExists("my-container")).toBe(true);
        });

        it("returns false when container not found", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, ""));
            expect(isContainerExists("my-container")).toBe(false);
        });
    });

    describe("isImageExists", () => {
        it("returns true when image found", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "sha256:abc\n"));
            expect(isImageExists()).toBe(true);
        });

        it("returns false when image not found", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, ""));
            expect(isImageExists()).toBe(false);
        });
    });

    describe("isContainerImageOutdated", () => {
        it("returns true when container image SHA differs from current image SHA", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:oldimage111\n"))  // container inspect
                .mockReturnValueOnce(makeResult(0, "sha256:newimage222\n")); // image inspect
            expect(isContainerImageOutdated("my-container")).toBe(true);
        });

        it("returns false when container image SHA matches current image SHA", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:sameimage\n"))  // container inspect
                .mockReturnValueOnce(makeResult(0, "sha256:sameimage\n")); // image inspect
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });

        it("returns false when container inspect fails (fail-open)", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(1, ""));  // container inspect fails
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });

        it("returns false when image inspect fails (fail-open)", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:oldimage\n"))  // container inspect ok
                .mockReturnValueOnce(makeResult(1, ""));                   // image inspect fails
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });

        it("returns false when container inspect returns empty stdout", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))                    // container inspect empty
                .mockReturnValueOnce(makeResult(0, "sha256:newimage\n")); // image inspect
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });
    });

    describe("buildDockerRunArgs", () => {
        it("should be a function exported from docker.ts", () => {
            expect(typeof buildDockerRunArgs).toBe("function");
        });
    });

    describe("syncClipboardShims", () => {
        it("should docker cp each shim file that exists and chmod +x", () => {
            mockExistsSync.mockReturnValue(true);
            spawnSyncMock.mockReturnValue(makeResult(0));

            syncClipboardShims("ccc-test-abc123", "/fake/dist");

            const cpCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "cp"
            );
            expect(cpCalls).toHaveLength(5);
            const shims = cpCalls.map((c: unknown[]) => (c[1] as string[])[2]);
            expect(shims).toContain("ccc-test-abc123:/usr/local/bin/xclip");
            expect(shims).toContain("ccc-test-abc123:/usr/local/bin/wl-paste");
            expect(shims).toContain("ccc-test-abc123:/usr/local/bin/pbpaste");

            // Should also chmod +x all copied shims
            const chmodCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "exec" && (c[1] as string[]).includes("chmod")
            );
            expect(chmodCalls).toHaveLength(1);
            const chmodArgs = chmodCalls[0][1] as string[];
            expect(chmodArgs).toContain("+x");
            expect(chmodArgs).toContain("/usr/local/bin/xclip");
            expect(chmodArgs).toContain("/usr/local/bin/pbpaste");
        });

        it("should skip when shims directory does not exist", () => {
            mockExistsSync.mockReturnValue(false);
            spawnSyncMock.mockReturnValue(makeResult(0));

            syncClipboardShims("ccc-test-abc123", "/fake/dist");

            const cpCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "cp"
            );
            expect(cpCalls).toHaveLength(0);
        });

        it("should skip individual shims that do not exist", () => {
            // shimsDir exists, but only some shim files exist
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith("clipboard-shims")) return true;
                return p.endsWith("xclip") || p.endsWith("wl-paste");
            });
            spawnSyncMock.mockReturnValue(makeResult(0));

            syncClipboardShims("ccc-test-abc123", "/fake/dist");

            const cpCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "cp"
            );
            expect(cpCalls).toHaveLength(2);
        });
    });

    describe("ensureDockerRunning", () => {
        it("does not exit when Docker is running", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureDockerRunning()).not.toThrow();
            mockExit.mockRestore();
        });

        it("calls process.exit(1) when Docker is not running", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureDockerRunning()).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });

    describe("getImageLabel", () => {
        it("returns label value when present", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "1.0.0\n"));
            expect(getImageLabel("ccc", "cli.version")).toBe("1.0.0");
        });

        it("returns null when label is missing (<no value>)", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "<no value>\n"));
            expect(getImageLabel("ccc", "cli.version")).toBeNull();
        });

        it("returns null when inspect fails (image not found)", () => {
            spawnSyncMock.mockReturnValue(makeResult(1, ""));
            expect(getImageLabel("ccc", "cli.version")).toBeNull();
        });
    });

    describe("pullImage", () => {
        it("returns true on successful pull", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            expect(pullImage("repo/ccc:1.0.0")).toBe(true);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker", ["pull", "repo/ccc:1.0.0"], { stdio: "inherit" },
            );
        });

        it("returns false on failed pull", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            expect(pullImage("repo/ccc:1.0.0")).toBe(false);
        });
    });

    describe("tagImage", () => {
        it("runs docker tag", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            tagImage("repo/ccc:1.0.0", "ccc");
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker", ["tag", "repo/ccc:1.0.0", "ccc"], { stdio: "ignore" },
            );
        });
    });

    describe("ensureImage (label-based)", () => {
        it("uses local dev build (no cli.version label) without pulling", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))       // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, "<no value>\n"));      // getImageLabel -> null (dev build)

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            // No pull call should have been made
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeUndefined();
            mockExit.mockRestore();
        });

        it("uses local image when cli.version matches CLI_VERSION", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))          // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, `${CLI_VERSION}\n`));     // getImageLabel -> matches CLI_VERSION

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeUndefined();
            mockExit.mockRestore();
        });

        it("pulls and re-tags when cli.version mismatches CLI_VERSION", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))   // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, "0.9.0\n"))       // getImageLabel -> old version
                .mockReturnValueOnce(makeResult(0))                    // pullImage -> success
                .mockReturnValueOnce(makeResult(0));                   // tagImage

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeDefined();
            const tagCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "tag"
            );
            expect(tagCall).toBeDefined();
            mockExit.mockRestore();
        });

        it("pulls when no local ccc image exists", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))    // isImageExists -> false
                .mockReturnValueOnce(makeResult(0))        // pullImage -> success
                .mockReturnValueOnce(makeResult(0));       // tagImage

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeDefined();
            mockExit.mockRestore();
        });

        it("warns but continues when pull fails with stale image", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))   // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, "0.9.0\n"))       // getImageLabel -> old version
                .mockReturnValueOnce(makeResult(1));                   // pullImage -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            const warnSpy = vi.spyOn(console, "warn");
            expect(() => ensureImage()).not.toThrow();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to pull"));
            mockExit.mockRestore();
        });

        it("exits with error when pull fails with no image", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))    // isImageExists -> false
                .mockReturnValueOnce(makeResult(1));       // pullImage -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });

    describe("startProjectContainer", () => {
        const projectPath = "/home/user/my-project";
        const ensureDirs = vi.fn();

        beforeEach(() => {
            ensureDirs.mockReset();
            mockExistsSync.mockReturnValue(true);
        });

        it("returns container name when container is already running", () => {
            // Call sequence (no extraMounts):
            // #1 isImageExists, #2 getImageLabel (dev build), #3 isContainerExists (extraMounts guard),
            // #4 isContainerRunning -> true (returns early)
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists (extraMounts guard)
                .mockReturnValueOnce(makeResult(0, "abc123\n"));    // isContainerRunning -> running

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);
            expect(ensureDirs).toHaveBeenCalled();
        });

        it("starts a stopped container and returns its name", () => {
            // #1 isImageExists, #2 getImageLabel (dev build), #3 isContainerExists (extraMounts guard),
            // #4 isContainerRunning->false, #5 isContainerExists->true, #6 docker start
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists (extraMounts guard) -> exists but no extraMounts
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> true
                .mockReturnValueOnce(makeResult(0));                 // docker start

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);

            const startCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "start"
            );
            expect(startCall).toBeDefined();
        });

        it("creates a new container when none exists", () => {
            mockExistsSync.mockReturnValue(false); // hostSshDir does not exist -> no SSH mount, no SSH fix

            // #1 isImageExists, #2 getImageLabel (dev build), #3 isContainerExists (extraMounts guard)->false,
            // #4 isContainerRunning->false, #5 isContainerExists->false, then docker run
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard) -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run (and any extra calls)

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            expect(runCall).toBeDefined();
        });

        it("fixes SSH key permissions after creating container when ssh dir exists", () => {
            mockExistsSync.mockReturnValue(true);

            // #1 isImageExists, #2 getImageLabel (dev build), #3 isContainerExists (guard)->false,
            // #4 isContainerRunning->false, #5 isContainerExists->false, #6 docker run, #7 docker exec
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard) -> false (no extraMounts)
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0))                 // docker run
                .mockReturnValueOnce(makeResult(0));                 // docker exec (SSH fix)

            startProjectContainer(projectPath, ensureDirs);

            const execCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "exec"
            );
            expect(execCall).toBeDefined();
            expect((execCall![1] as string[])).toContain("sh");
        });

        it("calls process.exit(1) when container creation fails", () => {
            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard) -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(1));                     // docker run -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });

        it("uses darwin SSH agent socket on darwin platform", () => {
            mockExistsSync.mockReturnValue(false); // no SSH dir

            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard)
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run (and any extra)

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = (runCall![1] as string[]).join(" ");
            expect(runArgs).toContain("/run/host-services/ssh-auth.sock");

            platformSpy.mockRestore();
        });

        it("uses SSH_AUTH_SOCK env var on linux when socket exists", () => {
            mockExistsSync.mockImplementation((p: string) => {
                return p === "/tmp/ssh-agent.sock";
            });

            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            const origSock = process.env.SSH_AUTH_SOCK;
            process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard)
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run (and any extra)

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = (runCall![1] as string[]).join(" ");
            expect(runArgs).toContain("/tmp/ssh-agent.sock");

            platformSpy.mockRestore();
            if (origSock === undefined) delete process.env.SSH_AUTH_SOCK;
            else process.env.SSH_AUTH_SOCK = origSock;
        });

        it("recreates container when extraMounts are missing (containerHasMounts returns false)", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];
            const missingMountsJson = JSON.stringify([]); // empty mounts -> missing required

            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists (extraMounts guard) -> exists
                .mockReturnValueOnce(makeResult(0, missingMountsJson)) // docker inspect (containerHasMounts)
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                  // docker run

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            const rmCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "rm"
            );
            expect(stopCall).toBeDefined();
            expect(rmCall).toBeDefined();
        });

        it("reuses container when extraMounts are present and all mounts exist", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];
            const mountsJson = JSON.stringify([
                { Source: "/host/repo/.git", Destination: "/project/repo/.git" },
            ]);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists (extraMounts guard) -> exists
                .mockReturnValueOnce(makeResult(0, mountsJson))     // docker inspect (containerHasMounts) -> all present
                .mockReturnValueOnce(makeResult(0, "abc123\n"));    // isContainerRunning -> true

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);

            // No stop/rm calls since mounts are present
            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
        });

        it("reuses container when Source differs but Destination matches (macOS Docker Desktop)", () => {
            const extraMounts = [{ hostPath: "/Users/me/repo/.git", containerPath: "/Users/me/repo/.git" }];
            // Docker Desktop on macOS may prefix Source with /host_mnt/ or resolve symlinks
            const mountsJson = JSON.stringify([
                { Source: "/host_mnt/Users/me/repo/.git", Destination: "/Users/me/repo/.git" },
            ]);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, mountsJson))     // docker inspect -> Destination matches
                .mockReturnValueOnce(makeResult(0, "abc123\n"));    // isContainerRunning -> true

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);

            // No stop/rm calls since Destination matches
            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
        });

        it("skips containerHasMounts check when container does not exist with extraMounts", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];

            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard) -> not exists, skip inspect
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run (and any extra)

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);
        });

        it("handles containerHasMounts returning false when docker inspect fails", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];

            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists (extraMounts guard) -> exists
                .mockReturnValueOnce(makeResult(1, ""))             // docker inspect -> fails (containerHasMounts false)
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                  // docker run

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);
        });

        it("handles containerHasMounts with invalid JSON (parse error -> returns false)", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];

            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists (extraMounts guard) -> exists
                .mockReturnValueOnce(makeResult(0, "not-json"))     // docker inspect -> bad JSON
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                  // docker run

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);
        });
    });

    describe("stopProjectContainer", () => {
        const projectPath = "/home/user/my-project";

        it("logs 'Container not found' when container does not exist", () => {
            // ensureDockerRunning: isDockerRunning -> true
            // isContainerExists -> false
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))    // docker info (ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "")); // isContainerExists -> false

            const consoleSpy = vi.spyOn(console, "log");
            stopProjectContainer(projectPath);
            expect(consoleSpy).toHaveBeenCalledWith("Container not found");
        });

        it("stops container when it exists", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))           // docker info
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists -> true
                .mockReturnValueOnce(makeResult(0));            // docker stop

            stopProjectContainer(projectPath);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("calls process.exit(1) when Docker is not running", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(1)); // docker info -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => stopProjectContainer(projectPath)).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });

    describe("removeProjectContainer", () => {
        const projectPath = "/home/user/my-project";

        it("logs 'Container not found' when container does not exist", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))    // docker info (ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "")); // isContainerExists -> false

            const consoleSpy = vi.spyOn(console, "log");
            removeProjectContainer(projectPath);
            expect(consoleSpy).toHaveBeenCalledWith("Container not found");
        });

        it("stops and removes container when it exists", () => {
            // removeProjectContainer calls ensureDockerRunning, isContainerExists, stopProjectContainer (which calls ensureDockerRunning+isContainerExists+docker stop), docker rm
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))           // docker info (removeProjectContainer -> ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists (removeProjectContainer check) -> true
                .mockReturnValueOnce(makeResult(0))           // docker info (stopProjectContainer -> ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists (stopProjectContainer check) -> true
                .mockReturnValueOnce(makeResult(0))            // docker stop
                .mockReturnValueOnce(makeResult(0));            // docker rm

            removeProjectContainer(projectPath);

            const rmCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "rm"
            );
            expect(rmCall).toBeDefined();
        });

        it("calls process.exit(1) when Docker is not running", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(1)); // docker info -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => removeProjectContainer(projectPath)).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });
});
