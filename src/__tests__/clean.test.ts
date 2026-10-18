import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncOptions, SpawnSyncReturns } from "child_process";
import { createClean } from "../application/clean.js";
import type { CleanPorts, CleanMutationPorts } from "../ports/clean.js";
import type { CleanFailure, CleanProgress, ContainerInfo, ImageInfo } from "../domain/clean.js";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(command: string, args: string[], options: SpawnSyncOptions) => SpawnSyncReturns<string>>();
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

const getSessionLockClaimsForContainerMock = vi.fn<(...args: unknown[]) => string[]>();
const withContainerLifecycleLockMock = vi.fn((_: string, operation: () => unknown) => operation());
vi.mock("../session.js", () => ({
    getSessionLockClaimsForContainer: getSessionLockClaimsForContainerMock,
    withContainerLifecycleLock: withContainerLifecycleLockMock,
}));

// Import AFTER mocks
const { cleanContainers } = await import("../clean.js");
const runtime = await import("../container-runtime.js");

function makeResult(
    status: number | null,
    stdout = "",
): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

describe("cleanContainers", () => {
    beforeEach(() => {
        spawnSyncMock.mockReset();
        promptMock.mockReset();
        ensureDockerRunningMock.mockReset();
        getSessionLockClaimsForContainerMock.mockReset();
        getSessionLockClaimsForContainerMock.mockReturnValue([]);
        withContainerLifecycleLockMock.mockClear();
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

    it("requests untruncated container IDs for destructive cleanup", async () => {
        spawnSyncMock.mockReturnValue(makeResult(0, ""));
        await cleanContainers({ yes: true });
        const listCall = spawnSyncMock.mock.calls.find((call) => (call[1] as string[])[0] === "ps");
        expect(listCall?.[1]).toContain("--no-trunc");
    });

    it("shows 'Nothing to clean' when no containers or images found", async () => {
        spawnSyncMock.mockReturnValue(makeResult(0, ""));
        await cleanContainers({ yes: true });
        expect(console.log).toHaveBeenCalledWith("Nothing to clean.");
    });

    it.each([
        { stage: "containers", kind: "containers", result: { ...makeResult(0), error: new Error("container inventory unavailable") } },
        { stage: "local images", kind: "images", result: makeResult(2, "ccc\tsha256local\t500MB") },
        { stage: "registry images", kind: "images", result: makeResult(null, "registry/ccc\tsha256registry\t500MB") },
        { stage: "requested volumes", kind: "volumes", result: makeResult(1, "ccc-mise-cache") },
    ].flatMap(failure => [
        { mode: "confirmation", options: {} },
        { mode: "dry-run", options: { dryRun: true } },
        { mode: "yes", options: { yes: true } },
    ].map(mode => ({ ...failure, ...mode }))))("aborts before confirmation or mutation when $stage inventory fails in $mode mode", async ({ stage, kind, result, options }) => {
        let failureObserved = false;
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const command = args as string[];
            const inventory = command[0] === "ps" ? "containers"
                : command[0] === "images" ? (command[command.length - 1] === "ccc" ? "local images" : "registry images")
                    : command[0] === "volume" && command[1] === "ls" ? "requested volumes" : null;
            if (inventory === stage) {
                failureObserved = true;
                return result;
            }
            if (inventory === "containers") return makeResult(0, "111111111111\tccc-running-aabbcc112233\tUp 10 minutes");
            if (inventory === "local images") return makeResult(0, "ccc\tsha256local\t500MB");
            if (inventory === "registry images") return makeResult(0, "registry/ccc\tsha256registry\t500MB");
            return makeResult(0, "");
        });
        promptMock.mockResolvedValue("yes");

        await expect(cleanContainers({ all: true, volumes: true, ...options })).rejects.toThrow(`Failed to list ${kind}; cleanup aborted.`);

        expect(failureObserved).toBe(true);
        expect(promptMock).not.toHaveBeenCalled();
        expect(withContainerLifecycleLockMock).not.toHaveBeenCalled();
        expect(getSessionLockClaimsForContainerMock).not.toHaveBeenCalled();
        const commands = spawnSyncMock.mock.calls.map(call => call[1] as string[]);
        expect(commands.some(command => ["stop", "rm", "rmi"].includes(command[0])
            || command[0] === "volume" && command[1] === "rm")).toBe(false);
        expect(process.exit).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
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
                    "111111111111\tccc-myproj-aabbcc112233\tExited (0) 2 days ago\r\n222222222222\tccc-other-ddeeff445566\tUp 5 minutes\r\n",
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
        expect(calls).toContain("rm 111111111111");
        // Should NOT stop/remove the running container
        expect(calls).not.toContain("stop 222222222222");
        expect(calls).not.toContain("rm 222222222222");
        // Should remove the image
        expect(calls.some((c) => c.startsWith("rmi sha256abcd1234"))).toBe(true);
    });

    it("--volumes: also removes ccc-* volumes", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "111111111111\tccc-proj-aabbcc112233\tExited (0) 1 hour ago");
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
                    "111111111111\tccc-running-aabb1122ccdd\tUp 10 minutes\n222222222222\tccc-stopped-eeff33445566\tExited (0) 3 days ago",
                );
            }
            if (argsArr[0] === "images") return makeResult(0, "");
            if (argsArr[0] === "volume" && argsArr[1] === "ls") return makeResult(0, "");
            return makeResult(0, "");
        });

        await expect(cleanContainers({ all: true, yes: true })).rejects.toThrow("process.exit called");

        const calls = spawnSyncMock.mock.calls.map((c) => (c[1] as string[]).join(" "));
        // Should stop the running container
        expect(calls).toContain("stop 111111111111");
        // Should remove both containers
        expect(calls).toContain("rm 111111111111");
        expect(calls).toContain("rm 222222222222");
        expect(calls.indexOf("stop 111111111111")).toBeLessThan(calls.indexOf("rm 111111111111"));
        expect(withContainerLifecycleLockMock).toHaveBeenCalledWith("running-aabb1122ccdd", expect.any(Function));
        expect(withContainerLifecycleLockMock).toHaveBeenCalledWith("stopped-eeff33445566", expect.any(Function));
    });

    it.each([
        { failure: "nonzero status", result: makeResult(1) },
        { failure: "missing status", result: makeResult(null) },
        { failure: "native error with zero status", result: { ...makeResult(0), error: new Error("stop unavailable") } },
    ])("aborts all later cleanup when its pinned stop has $failure", async ({ result }) => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0,
                "111111111111\tccc-running-aabb1122ccdd\tUp 10 minutes\n222222222222\tccc-stopped-eeff33445566\tExited (0) 1 day ago");
            if (argsArr[0] === "images") return makeResult(0, "ccc\tsha256later\t500MB");
            if (argsArr[0] === "volume" && argsArr[1] === "ls") return makeResult(0, "ccc-later-cache");
            if (argsArr[0] === "stop") return result;
            return makeResult(0, "");
        });

        await expect(cleanContainers({ all: true, volumes: true, yes: true })).rejects.toThrow("Failed to stop container ccc-running-aabb1122ccdd; cleanup aborted.");

        const mutations = spawnSyncMock.mock.calls.map(call => call[1] as string[])
            .filter(command => ["stop", "rm", "rmi"].includes(command[0])
                || command[0] === "volume" && command[1] === "rm");
        expect(mutations).toEqual([["stop", "111111111111"]]);
        expect(process.exit).not.toHaveBeenCalled();
    });

    it("reports failure when removal of a pinned container ID fails", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "222222222222\tccc-stopped-eeff33445566\tExited (0) 1 day ago");
            if (argsArr[0] === "images") return makeResult(0, "");
            if (argsArr[0] === "volume" && argsArr[1] === "ls") return makeResult(0, "");
            if (argsArr[0] === "rm") return makeResult(1, "");
            return makeResult(0, "");
        });

        await expect(cleanContainers({ all: true, yes: true })).rejects.toThrow("Failed to remove container ccc-stopped-eeff33445566; cleanup aborted.");
        expect(spawnSyncMock).toHaveBeenCalledWith(expect.any(String), ["rm", "222222222222"], { stdio: "inherit" });
    });

    it("reports image removal failure", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "");
            if (argsArr[0] === "images") return makeResult(0, "ccc\tsha256bad\t500MB");
            if (argsArr[0] === "rmi") return makeResult(1, "");
            return makeResult(0, "");
        });

        await expect(cleanContainers({ yes: true })).rejects.toThrow("Failed to remove image ccc; cleanup aborted.");
    });

    it("reports volume removal failure", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps" || argsArr[0] === "images") return makeResult(0, "");
            if (argsArr[0] === "volume" && argsArr[1] === "ls") return makeResult(0, "ccc-mise-cache");
            if (argsArr[0] === "volume" && argsArr[1] === "rm") return makeResult(1, "");
            return makeResult(0, "");
        });

        await expect(cleanContainers({ volumes: true, yes: true })).rejects.toThrow("Failed to remove volume ccc-mise-cache; cleanup aborted.");
    });

    it("never stops or removes a container with any CCC session ownership claim", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "111111111111\tccc-live-aabbcc112233\tUp 10 minutes");
            if (argsArr[0] === "images") return makeResult(0, "");
            if (argsArr[0] === "volume" && argsArr[1] === "ls") return makeResult(0, "");
            return makeResult(0, "");
        });
        getSessionLockClaimsForContainerMock.mockReturnValue(["live.lock"]);

        await expect(cleanContainers({ all: true, yes: true })).rejects.toThrow("process.exit called");

        const commands = spawnSyncMock.mock.calls.map(call => call[1] as string[]);
        expect(commands.some(command => command[0] === "stop" || command[0] === "rm")).toBe(false);
        expect(console.log).toHaveBeenCalledWith("Skipping ccc-live-aabbcc112233: 1 CCC session ownership claim(s).");
    });

    it("--dry-run: prints plan but does not execute docker rm/rmi/volume rm", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") return makeResult(0, "111111111111\tccc-proj-aabbcc112233\tExited (0) 1 day ago");
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
            if (argsArr[0] === "ps") return makeResult(0, "111111111111\tccc-proj-aabbcc112233\tExited (0) 1 day ago");
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
            if (argsArr[0] === "ps") return makeResult(0, "111111111111\tccc-proj-aabbcc112233\tExited (0) 1 day ago");
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
            if (argsArr[0] === "ps") return makeResult(0, "111111111111\tccc-proj-aabbcc112233\tExited (0) 1 day ago");
            if (argsArr[0] === "images") return makeResult(0, "");
            return makeResult(0, "");
        });

        await expect(cleanContainers({ yes: true })).rejects.toThrow("process.exit called");
        expect(process.exit).toHaveBeenCalledWith(0);
    });

    it("ignores malformed or unmanaged container inventory rows", async () => {
        spawnSyncMock.mockImplementation((_cmd: unknown, args: unknown[]) => {
            const argsArr = args as string[];
            if (argsArr[0] === "ps") {
                return makeResult(0, "not-an-id\tccc-bad\tExited\n111111111111\tnot-ccc\tExited");
            }
            return makeResult(0, "");
        });

        await cleanContainers({ all: true, yes: true });

        expect(console.log).toHaveBeenCalledWith("Nothing to clean.");
        expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm"].includes((call[1] as string[])[0]))).toBe(false);
    });

    it("preserves exact progress and uses the runtime selected after confirmation for every pinned mutation", async () => {
        runtime._setRuntimeInfoForTest({ runtime: "docker" });
        spawnSyncMock.mockImplementation((_command, args) => {
            if (args[0] === "ps") return makeResult(0,
                "111111111111\tccc-running-aabb1122ccdd\tUp 10 minutes\n222222222222\tccc-claimed-eeff33445566\tExited (0) 1 day ago");
            if (args[0] === "images") return makeResult(0, "ccc\tsha256image\t500MB");
            if (args[0] === "volume" && args[1] === "ls") return makeResult(0, "ccc-cache");
            if (args[0] === "stop") runtime._setRuntimeInfoForTest({ runtime: "docker" });
            return makeResult(0);
        });
        getSessionLockClaimsForContainerMock.mockImplementation(prefix => prefix === "claimed-eeff33445566" ? ["claim"] : []);
        promptMock.mockImplementation(async () => {
            expect(spawnSyncMock.mock.calls.every(([, args]) => ["ps", "images", "volume"].includes(args[0]))).toBe(true);
            runtime._setRuntimeInfoForTest({ runtime: "podman" });
            return "yes";
        });
        try {
            expect(cleanContainers.name).toBe("cleanContainers");
            expect(cleanContainers.constructor.name).toBe("AsyncFunction");
            await expect(cleanContainers({ all: true, volumes: true })).rejects.toThrow("process.exit called");

            const mutations = spawnSyncMock.mock.calls.filter(([, args]) =>
                ["stop", "rm", "rmi"].includes(args[0]) || args[0] === "volume" && args[1] === "rm");
            expect(mutations.map(([command, args]) => [command, args])).toEqual([
                ["podman", ["stop", "111111111111"]], ["podman", ["rm", "111111111111"]],
                ["podman", ["rmi", "sha256image"]], ["podman", ["volume", "rm", "ccc-cache"]],
            ]);
            expect(vi.mocked(console.log).mock.calls).toEqual([
                ["\nContainers to stop:"], ["  ccc-running-aabb1122ccdd  (Up 10 minutes)"],
                ["\nContainers to remove:"], ["  ccc-running-aabb1122ccdd  (Up 10 minutes)"],
                ["  ccc-claimed-eeff33445566  (Exited (0) 1 day ago)"],
                ["\nImages to remove:"], ["  ccc  sha256image  (500MB)"],
                ["\nVolumes to remove:"], ["  ccc-cache"],
                ["Stopping ccc-running-aabb1122ccdd..."], ["Removing container ccc-running-aabb1122ccdd..."],
                ["Skipping ccc-claimed-eeff33445566: 1 CCC session ownership claim(s)."],
                ["Removing image ccc (sha256image)..."], ["Removing volume ccc-cache..."],
                ["\nDone. Removed 3 item(s)."],
            ]);
            expect(process.exit).toHaveBeenCalledWith(0);
        } finally { runtime._resetRuntimeCacheForTest(); }
    });

    it("captures the current console callee separately for each publication", async () => {
        spawnSyncMock.mockImplementation((_command, args) => args[0] === "ps"
            ? makeResult(0, "111111111111\tccc-proj-aabbcc112233\tExited") : makeResult(0));
        const initial = vi.mocked(console.log);
        const replacement = vi.fn<typeof console.log>();
        initial.mockImplementation(() => { console.log = replacement; });
        try {
            await cleanContainers({ dryRun: true });
            expect(initial.mock.calls).toEqual([["\nContainers to remove:"]]);
            expect(replacement.mock.calls).toEqual([["  ccc-proj-aabbcc112233  (Exited)"], ["\n(dry run - no changes made)"]]);
            expect(promptMock).not.toHaveBeenCalled();
            expect(withContainerLifecycleLockMock).not.toHaveBeenCalled();
        } finally { console.log = initial; }
    });

    it("captures publication before reading container and image presentation facts", async () => {
        const trace: string[] = [];
        const facts: CleanProgress[] = [];
        const container: ContainerInfo = { id: "111111111111", name: "ccc-project", running: false,
            get status() { trace.push("read-status"); return "Exited"; } };
        const image: ImageInfo = { id: "sha256image",
            get repository() { trace.push("read-repository"); return "ccc"; },
            get size() { trace.push("read-size"); return "500MB"; } };
        const unexpected = () => { throw new Error("unexpected cleanup effect"); };
        const ports: CleanPorts = {
            ensureRuntimeReady: () => undefined,
            observeContainers: () => ({ kind: "observed", items: [container] }),
            observeImages: () => ({ kind: "observed", items: [image] }),
            registryImage: "registry/ccc", observeVolumes: () => ({ kind: "observed", items: [] }),
            confirm: unexpected, captureMutationRuntime: unexpected, withLifecycleLock: unexpected, sessionClaims: unexpected,
            capturePublication: () => {
                trace.push("capture");
                return fact => { facts.push(fact); trace.push(fact.kind); return undefined; };
            },
            failureError: unexpected, exitSuccess: unexpected,
        };
        const clean = createClean(ports);
        expect(trace).toEqual([]);
        await clean({ dryRun: true });
        expect(trace).toEqual([
            "capture", "containers-to-remove", "capture", "read-status", "container-selected",
            "capture", "images-to-remove", "capture", "read-repository", "read-size", "image-selected",
            "capture", "dry-run",
        ]);
        expect(facts).toEqual([
            { kind: "containers-to-remove" }, { kind: "container-selected", name: "ccc-project", status: "Exited" },
            { kind: "images-to-remove" }, { kind: "image-selected", repository: "ccc", id: "sha256image", size: "500MB" },
            { kind: "dry-run" },
        ]);
    });

    it("throws the mapped stop failure by identity before capturing a later mutation callee", async () => {
        const failure = new Error("mapped native stop failure");
        const failureError = vi.fn<(fact: CleanFailure) => Error>(() => failure);
        const stop = vi.fn(() => ({ ok: false }));
        const remove = vi.fn(() => ({ ok: true }));
        const captured = vi.fn(() => undefined);
        const mutation: CleanMutationPorts = {
            stopContainer: stop,
            get removeContainer() { captured(); return remove; },
            get removeImage(): CleanMutationPorts["removeImage"] { throw new Error("image callee captured after failure"); },
            get removeVolume(): CleanMutationPorts["removeVolume"] { throw new Error("volume callee captured after failure"); },
        };
        const ports: CleanPorts = {
            ensureRuntimeReady: () => undefined,
            observeContainers: () => ({ kind: "observed", items: [{id: "111111111111", name: "ccc-project", status: "Up", running: true}] }),
            observeImages: () => ({ kind: "observed", items: [] }), registryImage: "registry/ccc",
            observeVolumes: () => ({ kind: "observed", items: [] }), confirm: async () => "yes",
            captureMutationRuntime: () => mutation, withLifecycleLock: (_prefix, operation) => operation(), sessionClaims: () => [],
            capturePublication: () => () => undefined, failureError,
            exitSuccess: () => { throw new Error("cleanup exited after failure"); },
        };
        await expect(createClean(ports)({ all: true, yes: true })).rejects.toBe(failure);
        expect(failureError.mock.calls).toEqual([[{ kind: "stop-container-failed", name: "ccc-project" }]]);
        expect(stop.mock.calls).toEqual([["111111111111"]]);
        expect(captured).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
    });
});
