import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncOptions, SpawnSyncReturns } from "child_process";
import { basename, resolve } from "node:path";
import { createClean } from "../application/clean.js";
import type { CleanPorts, CleanRuntimePorts } from "../ports/clean.js";
import type { CleanOutcome, CleanProgress, ContainerInfo } from "../domain/clean.js";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(command: string, args: string[], options: SpawnSyncOptions) => SpawnSyncReturns<string>>();
const nativeSpawnSyncMock = vi.fn<(command: string, args: string[], options: SpawnSyncOptions) => void>();
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: (command: string, args: string[], options: SpawnSyncOptions) => {
        // Exercise the actual invocation compiler while keeping existing CLI
        // behavior cases readable in terms of their semantic runtime commands.
        nativeSpawnSyncMock(command, args, options);
        const start = args.findIndex(arg => ["ps", "images", "volume", "stop", "rm", "rmi"].includes(arg));
        const semanticOptions = { ...options };
        delete semanticOptions.env;
        delete semanticOptions.shell;
        delete semanticOptions.cwd;
        return spawnSyncMock(basename(command), start < 0 ? args : args.slice(start), semanticOptions);
    } };
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

function invocation(selected: "docker" | "podman" = "docker", engine = "a"): NativeRuntimeInvocation {
    const directory = resolve("/fixture", engine);
    return runtime.validateNativeRuntimeInvocation({
        version: 1, runtime: selected, executable: resolve(directory, selected),
        transport: selected === "docker"
            ? { kind: "docker", host: `unix:///fixture/engine-${engine}.sock`, configDirectory: resolve(directory, "config"),
                tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } }
            : { kind: "podman-local", graphRoot: resolve(directory, "store"), runRoot: resolve(directory, "run"),
                storageDriver: "overlay", storageOptions: [], transientStore: false },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, key === "PATH" ? directory : null])),
    });
}

function selectInvocation(selected: "docker" | "podman" = "docker", engine = "a"): NativeRuntimeInvocation {
    runtime._setRuntimeInfoForTest({ runtime: selected });
    const captured = invocation(selected, engine);
    runtime._setRuntimeInvocationForTest(captured);
    return captured;
}

function makeResult(
    status: number | null,
    stdout = "",
): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

describe("cleanContainers", () => {
    beforeEach(() => {
        spawnSyncMock.mockReset();
        nativeSpawnSyncMock.mockReset();
        runtime._resetRuntimeCacheForTest();
        selectInvocation();
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
        runtime._resetRuntimeCacheForTest();
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

    it("keeps the observed runtime authority through confirmation and captures a new selection only on a later call", async () => {
        const initial = selectInvocation();
        spawnSyncMock.mockImplementation((_command, args) => {
            if (args[0] === "ps") return makeResult(0,
                "111111111111\tccc-running-aabb1122ccdd\tUp 10 minutes\n222222222222\tccc-claimed-eeff33445566\tExited (0) 1 day ago");
            if (args[0] === "images") return makeResult(0, "ccc\tsha256image\t500MB");
            if (args[0] === "volume" && args[1] === "ls") return makeResult(0, "ccc-cache");
            return makeResult(0);
        });
        getSessionLockClaimsForContainerMock.mockImplementation(prefix => prefix === "claimed-eeff33445566" ? ["claim"] : []);
        promptMock.mockImplementation(async () => {
            expect(spawnSyncMock.mock.calls.every(([, args]) => ["ps", "images", "volume"].includes(args[0]))).toBe(true);
            selectInvocation("podman", "b");
            return "yes";
        });
        try {
            expect(cleanContainers.name).toBe("cleanContainers");
            expect(cleanContainers.constructor.name).toBe("AsyncFunction");
            await expect(cleanContainers({ all: true, volumes: true })).rejects.toThrow("process.exit called");

            const mutations = spawnSyncMock.mock.calls.filter(([, args]) =>
                ["stop", "rm", "rmi"].includes(args[0]) || args[0] === "volume" && args[1] === "rm");
            expect(mutations.map(([command, args]) => [command, args])).toEqual([
                ["docker", ["stop", "111111111111"]], ["docker", ["rm", "111111111111"]],
                ["docker", ["rmi", "sha256image"]], ["docker", ["volume", "rm", "ccc-cache"]],
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
            for (const [executable, args, options] of nativeSpawnSyncMock.mock.calls) {
                expect(executable).toBe(initial.executable);
                expect(args.slice(0, 4)).toEqual(["--config", resolve("/fixture/a/config"), "--host", "unix:///fixture/engine-a.sock"]);
                expect(options.env?.PATH).toBe(resolve("/fixture/a"));
                expect(options.shell).toBe(false);
            }
            const firstCallCount = nativeSpawnSyncMock.mock.calls.length;
            await cleanContainers({ dryRun: true });
            const laterCalls = nativeSpawnSyncMock.mock.calls.slice(firstCallCount);
            expect(laterCalls.length).toBeGreaterThan(0);
            for (const [executable, args] of laterCalls) {
                expect(executable).toBe(resolve("/fixture/b/podman"));
                expect(args).toContain(resolve("/fixture/b/store"));
            }
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

});

describe("reusable clean operation", () => {
    const stopped: ContainerInfo = { id: "111111111111", name: "ccc-project", status: "Exited", running: false };

    function fixture() {
        const runtime: CleanRuntimePorts = {
            ensureRuntimeReady: vi.fn<CleanRuntimePorts["ensureRuntimeReady"]>(() => undefined),
            observeContainers: vi.fn<CleanRuntimePorts["observeContainers"]>(() => ({ kind: "observed", items: [stopped] })),
            observeImages: vi.fn<CleanRuntimePorts["observeImages"]>(() => ({ kind: "observed", items: [] })),
            observeVolumes: vi.fn<CleanRuntimePorts["observeVolumes"]>(() => ({ kind: "observed", items: [] })),
            stopContainer: vi.fn<CleanRuntimePorts["stopContainer"]>(() => ({ ok: true })),
            removeContainer: vi.fn<CleanRuntimePorts["removeContainer"]>(() => ({ ok: true })),
            removeImage: vi.fn<CleanRuntimePorts["removeImage"]>(() => ({ ok: true })),
            removeVolume: vi.fn<CleanRuntimePorts["removeVolume"]>(() => ({ ok: true })),
        };
        const facts: CleanProgress[] = [];
        const ports: CleanPorts = {
            captureRuntime: vi.fn<CleanPorts["captureRuntime"]>(() => runtime), registryImage: "registry/ccc",
            confirm: vi.fn<CleanPorts["confirm"]>(async () => "yes"),
            withLifecycleLock: vi.fn<CleanPorts["withLifecycleLock"]>((_prefix, operation) => operation()),
            sessionClaims: vi.fn<CleanPorts["sessionClaims"]>(() => []),
            capturePublication: () => fact => { facts.push(fact); return undefined; },
        };
        return { runtime, ports, facts };
    }

    it("captures once before readiness and inventory, keeps that runtime across confirmation, and recaptures on a later invocation", async () => {
        const first = fixture(), later = fixture();
        vi.mocked(later.runtime.observeContainers).mockReturnValue({ kind: "observed", items: [] });
        let selected = first.runtime;
        const trace: string[] = [];
        vi.mocked(first.runtime.ensureRuntimeReady).mockImplementation(() => { trace.push("ready"); return undefined; });
        vi.mocked(first.runtime.observeContainers).mockImplementation(() => { trace.push("inventory"); return { kind: "observed", items: [stopped] }; });
        let answer!: (value: string) => void;
        const ports: CleanPorts = { ...first.ports,
            captureRuntime: vi.fn<CleanPorts["captureRuntime"]>(() => { trace.push("capture"); return selected; }),
            confirm: vi.fn<CleanPorts["confirm"]>(() => new Promise(resolve => { trace.push("confirm"); answer = resolve; })),
        };
        const clean = createClean(ports);
        expect(ports.captureRuntime).not.toHaveBeenCalled();
        const pending = clean({});
        expect(trace).toEqual(["capture", "ready", "inventory", "confirm"]);
        selected = later.runtime;
        answer("yes");
        await expect(pending).resolves.toEqual({ kind: "completed", removed: 1 });
        expect(first.runtime.removeContainer).toHaveBeenCalledWith(stopped.id);
        expect(later.runtime.removeContainer).not.toHaveBeenCalled();
        await expect(clean({ yes: true })).resolves.toEqual({ kind: "nothing-to-clean" });
        expect(ports.captureRuntime).toHaveBeenCalledTimes(2);
        expect(later.runtime.ensureRuntimeReady).toHaveBeenCalledOnce();
    });

    it.each([
        { options: { dryRun: true }, answer: "yes", expected: { kind: "dry-run" } },
        { options: {}, answer: "n", expected: { kind: "aborted" } },
    ])("returns $expected.kind without mutation or lifecycle claims", async ({ options, answer, expected }) => {
        const { runtime, ports } = fixture();
        vi.mocked(ports.confirm).mockResolvedValue(answer);
        await expect(createClean(ports)(options)).resolves.toEqual(expected);
        expect(runtime.removeContainer).not.toHaveBeenCalled();
        expect(ports.withLifecycleLock).not.toHaveBeenCalled();
        expect(ports.sessionClaims).not.toHaveBeenCalled();
    });

    it("reports only completed removals and skips claimed containers under their lifecycle lock", async () => {
        const { runtime, ports, facts } = fixture();
        vi.mocked(runtime.observeContainers).mockReturnValue({ kind: "observed", items: [stopped,
            { ...stopped, id: "222222222222", name: "ccc-claimed", running: true }] });
        vi.mocked(runtime.observeImages).mockReturnValue({ kind: "observed", items: [{ repository: "ccc", id: "image", size: "1MB" }] });
        vi.mocked(runtime.observeVolumes).mockReturnValue({ kind: "observed", items: ["ccc-cache"] });
        vi.mocked(ports.sessionClaims).mockImplementation(prefix => prefix === "claimed" ? ["claim"] : []);
        await expect(createClean(ports)({ all: true, yes: true })).resolves.toEqual({ kind: "completed", removed: 3 });
        expect(runtime.removeContainer).toHaveBeenCalledExactlyOnceWith(stopped.id);
        expect(runtime.stopContainer).not.toHaveBeenCalled();
        expect(runtime.removeImage).toHaveBeenCalledExactlyOnceWith("image");
        expect(runtime.removeVolume).toHaveBeenCalledExactlyOnceWith("ccc-cache");
        expect(ports.withLifecycleLock).toHaveBeenCalledWith("claimed", expect.any(Function));
        expect(facts).toContainEqual({ kind: "container-claimed", name: "ccc-claimed", claimCount: 1 });
        expect(facts.at(-1)).toEqual({ kind: "completed", removed: 3 });
    });

    it.each(["containers", "images", "volumes"] as const)("returns a failed %s inventory outcome before confirmation or mutation", async inventory => {
        const { runtime, ports } = fixture();
        const observation = inventory === "containers" ? runtime.observeContainers : inventory === "images" ? runtime.observeImages : runtime.observeVolumes;
        vi.mocked(observation).mockReturnValue({ kind: "unavailable" });
        await expect(createClean(ports)({ all: true })).resolves.toEqual({ kind: "failed", failure: { kind: "inventory-unavailable", inventory }, removed: 0 });
        expect(ports.confirm).not.toHaveBeenCalled();
        expect(ports.withLifecycleLock).not.toHaveBeenCalled();
        expect(runtime.removeContainer).not.toHaveBeenCalled();
    });

    it("returns a failed stop outcome before removal or later cleanup effects", async () => {
        const { runtime, ports } = fixture();
        vi.mocked(runtime.observeContainers).mockReturnValue({ kind: "observed", items: [{ ...stopped, running: true }] });
        vi.mocked(runtime.stopContainer).mockReturnValue({ ok: false });
        await expect(createClean(ports)({ all: true, yes: true })).resolves.toEqual({
            kind: "failed", failure: { kind: "stop-container-failed", name: stopped.name }, removed: 0,
        });
        expect(runtime.stopContainer).toHaveBeenCalledExactlyOnceWith(stopped.id);
        expect(runtime.removeContainer).not.toHaveBeenCalled();
        expect(runtime.removeImage).not.toHaveBeenCalled();
        expect(runtime.removeVolume).not.toHaveBeenCalled();
    });

    it("returns a later mutation failure with the successful removal count and no later volume effect", async () => {
        const { runtime, ports, facts } = fixture();
        vi.mocked(runtime.observeImages).mockReturnValue({ kind: "observed", items: [{ repository: "ccc", id: "image", size: "1MB" }] });
        vi.mocked(runtime.observeVolumes).mockReturnValue({ kind: "observed", items: ["ccc-cache"] });
        vi.mocked(runtime.removeImage).mockReturnValue({ ok: false });
        const expected: CleanOutcome = { kind: "failed", failure: { kind: "remove-image-failed", repository: "ccc" }, removed: 1 };
        await expect(createClean(ports)({ volumes: true, yes: true })).resolves.toEqual(expected);
        expect(runtime.removeContainer).toHaveBeenCalledExactlyOnceWith(stopped.id);
        expect(runtime.removeVolume).not.toHaveBeenCalled();
        expect(facts.some(fact => fact.kind === "completed")).toBe(false);
    });

    it("propagates an unexpected native readiness exception without inventing a cleanup outcome", async () => {
        const { runtime, ports } = fixture();
        const cause = new Error("unexpected readiness failure");
        vi.mocked(runtime.ensureRuntimeReady).mockImplementation(() => { throw cause; });
        await expect(createClean(ports)({ yes: true })).rejects.toBe(cause);
        expect(runtime.observeContainers).not.toHaveBeenCalled();
        expect(ports.confirm).not.toHaveBeenCalled();
        expect(runtime.removeContainer).not.toHaveBeenCalled();
    });
});
