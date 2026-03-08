import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: spawnSyncMock };
});

// Mock prompt from utils
const promptMock = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock("../utils.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, prompt: promptMock };
});

// Mock ensureDockerRunning from docker
const ensureDockerRunningMock = vi.fn();
vi.mock("../docker.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, ensureDockerRunning: ensureDockerRunningMock };
});

// Import AFTER mocks
const { cleanContainers } = await import("../clean.js");

function makeResult(
    status: number,
    stdout = "",
): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

describe("cleanContainers", () => {
    beforeEach(() => {
        spawnSyncMock.mockReset();
        promptMock.mockReset();
        ensureDockerRunningMock.mockReset();
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(process, "exit").mockImplementation((_code?: unknown) => {
            throw new Error("process.exit called");
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("calls ensureDockerRunning first", async () => {
        // Return empty lists for all docker queries
        spawnSyncMock.mockReturnValue(makeResult(0, ""));
        await cleanContainers({ yes: true });
        expect(ensureDockerRunningMock).toHaveBeenCalled();
    });

    it("shows 'Nothing to clean' when no containers or images found", async () => {
        spawnSyncMock.mockReturnValue(makeResult(0, ""));
        await cleanContainers({ yes: true });
        expect(console.log).toHaveBeenCalledWith("Nothing to clean.");
    });

    it("default clean: removes stopped containers and ccc images", async () => {
        // Simulate: ps -a returns one stopped container, one running
        // images returns one image
        // volumes not requested
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") {
                return makeResult(
                    0,
                    "ccc-myproj-aabbcc112233\tExited (0) 2 days ago\nccc-other-ddeeff445566\tUp 5 minutes",
                );
            }
            if (argsArr[0] === "images") {
                return makeResult(0, "ccc\tsha256abcd1234\t500MB");
            }
            // rm, rmi
            return makeResult(0, "");
        });

        await expect(cleanContainers({ yes: true })).rejects.toThrow("process.exit called");

        const calls = spawnSyncMock.mock.calls.map((c) => (c[1] as string[]).join(" "));
        // Should remove the stopped container
        expect(calls.some((c) => c.startsWith("rm ccc-myproj"))).toBe(true);
        // Should NOT stop/remove the running container
        expect(calls.some((c) => c.startsWith("stop ccc-other"))).toBe(false);
        expect(calls.some((c) => c.startsWith("rm ccc-other"))).toBe(false);
        // Should remove the image
        expect(calls.some((c) => c.startsWith("rmi sha256abcd1234"))).toBe(true);
    });

    it("--volumes: also removes ccc-* volumes", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "ccc-proj-aabbcc112233\tExited (0) 1 hour ago");
            if (argsArr[0] === "images") return makeResult(0, "");
            if (argsArr[0] === "volume") {
                if (argsArr[1] === "ls") return makeResult(0, "ccc-mise-cache");
                return makeResult(0, ""); // volume rm
            }
            return makeResult(0, "");
        });

        await expect(cleanContainers({ volumes: true, yes: true })).rejects.toThrow("process.exit called");

        const calls = spawnSyncMock.mock.calls.map((c) => (c[1] as string[]).join(" "));
        expect(calls.some((c) => c.startsWith("volume rm ccc-mise-cache"))).toBe(true);
    });

    it("--all: stops running containers before removing everything", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") {
                return makeResult(
                    0,
                    "ccc-running-aabb1122ccdd\tUp 10 minutes\nccc-stopped-eeff33445566\tExited (0) 3 days ago",
                );
            }
            if (argsArr[0] === "images") return makeResult(0, "");
            if (argsArr[0] === "volume" && argsArr[1] === "ls") return makeResult(0, "");
            return makeResult(0, "");
        });

        await expect(cleanContainers({ all: true, yes: true })).rejects.toThrow("process.exit called");

        const calls = spawnSyncMock.mock.calls.map((c) => (c[1] as string[]).join(" "));
        // Should stop the running container
        expect(calls.some((c) => c.startsWith("stop ccc-running"))).toBe(true);
        // Should remove both containers
        expect(calls.some((c) => c.startsWith("rm ccc-running"))).toBe(true);
        expect(calls.some((c) => c.startsWith("rm ccc-stopped"))).toBe(true);
    });

    it("--dry-run: prints plan but does not execute docker rm/rmi/volume rm", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "ccc-proj-aabbcc112233\tExited (0) 1 day ago");
            if (argsArr[0] === "images") return makeResult(0, "ccc\tsha256xyz\t200MB");
            return makeResult(0, "");
        });

        await cleanContainers({ dryRun: true, yes: true });

        const calls = spawnSyncMock.mock.calls.map((c) => (c[1] as string[]).join(" "));
        // dry-run must NOT call rm or rmi
        expect(calls.some((c) => c.startsWith("rm "))).toBe(false);
        expect(calls.some((c) => c.startsWith("rmi "))).toBe(false);
        // Should print dry-run notice
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining("dry run"));
    });

    it("--yes: skips confirmation prompt", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "ccc-proj-aabbcc112233\tExited (0) 1 day ago");
            if (argsArr[0] === "images") return makeResult(0, "");
            return makeResult(0, "");
        });

        await expect(cleanContainers({ yes: true })).rejects.toThrow("process.exit called");

        // prompt should NOT have been called
        expect(promptMock).not.toHaveBeenCalled();
    });

    it("prompts for confirmation when --yes is not set and aborts on 'n'", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "ccc-proj-aabbcc112233\tExited (0) 1 day ago");
            if (argsArr[0] === "images") return makeResult(0, "");
            return makeResult(0, "");
        });
        promptMock.mockResolvedValue("n");

        await cleanContainers({});

        expect(promptMock).toHaveBeenCalled();
        const calls = spawnSyncMock.mock.calls.map((c) => (c[1] as string[]).join(" "));
        expect(calls.some((c) => c.startsWith("rm "))).toBe(false);
        expect(console.log).toHaveBeenCalledWith("Aborted.");
    });

    it("listImages finds both ccc and registry images, deduplicates by ID", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "");
            if (argsArr[0] === "images") {
                const repo = argsArr[argsArr.length - 1] as string;
                if (repo === "ccc") {
                    return makeResult(0, "ccc\tsha256aaa\t500MB");
                }
                // DOCKER_REGISTRY_IMAGE query: same ID (dedup) + unique one
                return makeResult(0, "1uxus/claude-code-container\tsha256aaa\t500MB\n1uxus/claude-code-container\tsha256bbb\t500MB");
            }
            return makeResult(0, "");
        });

        await expect(cleanContainers({ yes: true })).rejects.toThrow("process.exit called");

        // Should call rmi for 2 unique IDs (sha256aaa deduped, sha256bbb unique)
        const rmiCalls = spawnSyncMock.mock.calls.filter(
            (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "rmi"
        );
        const rmiIds = rmiCalls.map((c: unknown[]) => (c[1] as string[])[1]);
        expect(rmiIds).toContain("sha256aaa");
        expect(rmiIds).toContain("sha256bbb");
        expect(rmiIds).toHaveLength(2);
    });

    it("exits with 0 after successful clean", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "ccc-proj-aabbcc112233\tExited (0) 1 day ago");
            if (argsArr[0] === "images") return makeResult(0, "");
            return makeResult(0, "");
        });

        await expect(cleanContainers({ yes: true })).rejects.toThrow("process.exit called");
        expect(process.exit).toHaveBeenCalledWith(0);
    });
});
