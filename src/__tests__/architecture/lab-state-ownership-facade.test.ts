import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ spawn: vi.fn(), filesystem: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(),
    spawnSync: native.spawn,
    spawn: () => { throw new Error("Forbidden fixture process"); },
    exec: () => { throw new Error("Forbidden fixture process"); },
    execSync: () => { throw new Error("Forbidden fixture process"); },
    execFile: () => { throw new Error("Forbidden fixture process"); },
    fork: () => { throw new Error("Forbidden fixture process"); },
}));
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    const blocked = () => { native.filesystem(); throw new Error("Forbidden fixture filesystem effect"); };
    const manifest = new URL("../package.json", import.meta.resolve("@ccc/device-lab"));
    return {
        ...actual,
        readFileSync: (selected: unknown) => {
            if (selected instanceof URL && selected.href === manifest.href) return JSON.stringify({ version: "0.0.0-fixture" });
            return blocked();
        },
        existsSync: blocked, statSync: blocked, lstatSync: blocked, realpathSync: blocked,
        mkdirSync: blocked, writeFileSync: blocked, openSync: blocked, fstatSync: blocked,
        closeSync: blocked, rmSync: blocked, chmodSync: blocked, readdirSync: blocked,
        unlinkSync: blocked, renameSync: blocked, readSync: blocked,
    };
});
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => "/ccc-lab-state-fake/home" }));

const { prepareLabStateOwnership } = await import("../../lab-state-ownership.js");
const runtime = await import("../../container-runtime.js");
const application = await import("../../application/container/lab-state-ownership.js");
const volume = "ccc-example-lab-state";
const image = `sha256:${"a".repeat(64)}`;
const previous = `sha256:${"b".repeat(64)}`;
const identity = { uid: 2001, gid: 3001, mapping: "host" as const, contractVersion: "1" };
const options = { encoding: "utf-8", timeout: 300_000 };
const oldScript = 'printf "%s:%s" "$(id -u ccc)" "$(id -g ccc)"';
const migrateScript = "set -eu; find -P /state -xdev -uid 1001 -exec chown -h 2001 {} +; find -P /state -xdev -gid 1002 -exec chgrp -h 3001 {} +; chown 2001:3001 /state";
const verifyScript = 'test "$(stat -c %u:%g /state)" = 2001:3001';
const runArgs = (extras: string[] = []) => ["run", "--rm", "--network", "none", ...extras, "--entrypoint", "/bin/sh"];
function success(stdout = "") { return { status: 0, stdout, stderr: "" }; }
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}
beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("container", "");
    vi.stubEnv("CCC_PODMAN_CGROUPS", "");
    runtime._setRuntimeInfoForTest({ runtime: "docker", flavor: "docker-native", rootless: false, remote: false });
    native.spawn.mockImplementation((_cli: string, args: string[]) => {
        if (args[0] === "volume") return success(volume + "\n");
        if (args[0] === "ps" || args.includes("--mount")) return success();
        if (args.includes(previous)) return success("1001:1002");
        throw new Error("Unplanned fixture native command");
    });
});
afterEach(() => {
    expect(native.filesystem).not.toHaveBeenCalled();
    runtime._resetRuntimeCacheForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe("Lab ownership actual public facade and retained native bindings", () => {
    it("keeps named arity four, synchronous undefined and actual inward composition", () => {
        const factory = vi.spyOn(application, "createLabStateOwnershipPreparation");
        expect(prepareLabStateOwnership.name).toBe("prepareLabStateOwnership");
        expect(prepareLabStateOwnership).toHaveLength(4);
        expect(prepareLabStateOwnership(volume, image, identity, previous)).toBeUndefined();
        expect(factory).toHaveBeenCalledOnce();
        expect(Object.keys(factory.mock.calls[0][0])).toEqual(["normalizeImageId", "observeVolume", "observeVolumeUsers", "captureHelperScope", "observePreviousAccount", "applyOwnership"]);
    });
    it("preserves complete native argv/options and selective-owner shell bytes", () => {
        prepareLabStateOwnership(volume, image, identity, previous);
        expect(native.spawn.mock.calls).toEqual([
            ["docker", ["volume", "ls", "--format", "{{.Name}}"], options],
            ["docker", ["ps", "-q", "--filter", `volume=${volume}`], options],
            ["docker", [...runArgs(), "--user", "ccc", previous, "-c", oldScript], options],
            ["docker", [...runArgs(), "--user", "root", "--mount", `type=volume,source=${volume},target=/state`, image, "-c", migrateScript], options],
        ]);
    });
    it.each([undefined, ""])("keeps exact root verification bytes with previous %s", prior => {
        prepareLabStateOwnership(volume, image, identity, prior);
        expect(native.spawn.mock.calls).toEqual([
            ["docker", ["volume", "ls", "--format", "{{.Name}}"], options],
            ["docker", ["ps", "-q", "--filter", `volume=${volume}`], options],
            ["docker", [...runArgs(), "--user", "root", "--mount", `type=volume,source=${volume},target=/state`, image, "-c", verifyScript], options],
        ]);
    });
    it("captures actual Podman extras once and retains them while runtime changes during account probe", () => {
        runtime._setRuntimeInfoForTest({ runtime: "podman", flavor: "podman-rootless", rootless: true, remote: false });
        vi.stubEnv("CCC_PODMAN_CGROUPS", "disabled");
        native.spawn.mockImplementation((_cli: string, args: string[]) => {
            if (args[0] === "volume") return success(volume + "\n");
            if (args[0] === "ps" || args.includes("--mount")) return success();
            runtime._setRuntimeInfoForTest({ runtime: "docker", flavor: "docker-native", rootless: false, remote: false });
            return success("1001:1002");
        });
        prepareLabStateOwnership(volume, image, identity, previous);
        const extras = ["--cgroups=disabled", "--userns=keep-id:uid=1000,gid=1000"];
        expect(native.spawn.mock.calls[2]).toEqual(["podman", [...runArgs(extras), "--user", "ccc", previous, "-c", oldScript], options]);
        expect(native.spawn.mock.calls[3]).toEqual(["docker", [...runArgs(extras), "--user", "root", "--mount", `type=volume,source=${volume},target=/state`, image, "-c", migrateScript], options]);
    });


    it.each(["list", "users", "account", "helper"])("does not translate a thrown %s native runner failure", stage => {
        const failure = Object.freeze({ stage }), original = native.spawn.getMockImplementation()!;
        native.spawn.mockImplementation((cli, args, supplied) => {
            const current = args[0] === "volume" ? "list" : args[0] === "ps" ? "users" : args.includes("--mount") ? "helper" : "account";
            if (current === stage) throw failure;
            return original(cli, args, supplied);
        });
        expect(thrown(() => prepareLabStateOwnership(volume, image, identity, previous))).toBe(failure);
        expect(native.spawn).toHaveBeenCalledTimes(["list", "users", "account", "helper"].indexOf(stage) + 1);
    });

    it.each([1, null, 124])("retains volume data after helper status %s without deletion/retry", status => {
        const original = native.spawn.getMockImplementation()!;
        native.spawn.mockImplementation((cli, args, supplied) => args.includes("--mount") ? { status } : original(cli, args, supplied));
        expect(() => prepareLabStateOwnership(volume, image, identity, previous)).toThrow(`Lab state ownership preparation failed for ${volume}. Existing data was retained; repair its ownership before retrying.`);
        expect(native.spawn).toHaveBeenCalledTimes(4);
        expect(native.spawn.mock.calls.every(([, args]) => ["volume", "ps", "run"].includes(args[0]))).toBe(true);
    });
    it.each(["", volume + "\r\n", " " + volume + "\n", volume + "-other\n", volume.toUpperCase() + "\n"])("stops after the list when exact volume is absent in %j", listed => {
        native.spawn.mockReturnValueOnce(success(listed));
        expect(prepareLabStateOwnership(volume, image, identity, previous)).toBeUndefined();
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });
    it.each(["mutable-current", "mutable-previous", "invalid-volume"])("fails %s before native dispatch", fault => {
        expect(() => prepareLabStateOwnership(fault === "invalid-volume" ? "x,target=/host" : volume, fault === "mutable-current" ? "ccc:latest" : image, identity, fault === "mutable-previous" ? "ccc:old" : previous)).toThrow(fault === "invalid-volume" ? "Invalid lab state volume name." : "Container identity requires an immutable sha256 image ID.");
        expect(native.spawn).not.toHaveBeenCalled();
    });
    it("normalizes bare immutable IDs without changing native account authority", () => {
        prepareLabStateOwnership(volume, image.slice(7), identity, previous.slice(7));
        expect(native.spawn.mock.calls[2][1]).toContain(previous);
        expect(native.spawn.mock.calls[3][1]).toContain(image);
    });
});
