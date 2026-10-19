import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", () => ({ spawnSync: spawn }));
vi.mock("../container-runtime.js", async () => {
    const { validateNativeRuntimeInvocation } = await import("../adapters/container-runtime-invocation.js");
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../ports/container-runtime-invocation.js");
    const invocation = validateNativeRuntimeInvocation({
        version: 1, runtime: "docker", executable: "/fixture/runtime/docker",
        transport: { kind: "docker", host: "unix:///fixture/engine.sock", configDirectory: "/fixture/config",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    // This unit owner supplies the process leaf explicitly; emitted integration owns native routing.
    const runner = () => { const capturedCli = "docker"; return { invocation,
        spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => spawn(capturedCli, args, options),
    }; };
    return { ...({ runtimeCli: () => "docker", runtimeExtraRunArgs: () => [] }), getRuntimeInvocation: () => invocation, bindNativeRuntimeInvocation: runner,
        runtimeSpawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => runner().spawnSync(args, options),
        runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation() };
});
import { prepareLabStateOwnership } from "../lab-state-ownership.js";

const volume = "ccc-example-lab-state";
const image = `sha256:${"a".repeat(64)}`;
const previous = `sha256:${"b".repeat(64)}`;
const identity = { uid: 2001, gid: 3001, mapping: "host" as const, contractVersion: "1" };
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
beforeEach(() => {
    spawn.mockReset().mockImplementation((_cli, args: string[]) => {
        if (args[0] === "volume") return ok(volume + "\n");
        if (args.includes(previous)) return ok("1001:1002");
        return ok();
    });
});

describe("retained lab volume ownership", () => {
    it("uses immutable old image provenance and mounts only the exact named volume", () => {
        prepareLabStateOwnership(volume, image, identity, previous);
        const calls = spawn.mock.calls.map(call => call[1] as string[]);
        expect(calls[1]).toEqual(["ps", "-q", "--filter", `volume=${volume}`]);
        expect(calls[2]).toContain(previous);
        expect(calls[2]).not.toContain("--mount");
        expect(calls[3]).toContain(`type=volume,source=${volume},target=/state`);
        expect(calls[3].filter(arg => arg.includes("type="))).toHaveLength(1);
        expect(calls[3].at(-1)).toContain("-uid 1001 -exec chown -h 2001");
        expect(calls[3].at(-1)).toContain("-gid 1002 -exec chgrp -h 3001");
        expect(calls[3].at(-1)).toContain("chown 2001:3001 /state");
    });
    it("does not create an absent volume", () => {
        spawn.mockReturnValue(ok());
        prepareLabStateOwnership(volume, image, identity);
        expect(spawn).toHaveBeenCalledTimes(1);
    });
    it("requires a matching existing root when previous image provenance is absent", () => {
        prepareLabStateOwnership(volume, image, identity);
        const script = spawn.mock.calls.at(-1)![1].at(-1);
        expect(script).toBe('test "$(stat -c %u:%g /state)" = 2001:3001');
        expect(script).not.toMatch(/chown|chgrp/);
    });
    it.each([ok("running-container"), { status: 1 }, { status: null, error: new Error("timeout") }])(
        "refuses active or uninspectable users without running a repair helper", result => {
            spawn.mockImplementation((_cli, args: string[]) => args[0] === "volume" ? ok(volume + "\n") : result);
            expect(() => prepareLabStateOwnership(volume, image, identity, previous)).toThrow(/in use/);
            expect(spawn.mock.calls.some(call => call[1][0] === "run")).toBe(false);
        },
    );
    it.each(["0:1001", "1001:0", "4294967295:1001", "1001:4294967295", "4294967296:1", "1:4294967296", "-1:2", "1.5:2", "unknown", "1001:1001\nextra"])(
        "rejects unknown previous numeric owners %s", ids => {
            spawn.mockImplementation((_cli, args: string[]) => args[0] === "volume" ? ok(volume + "\n") : args.includes(previous) ? ok(ids) : ok());
            expect(() => prepareLabStateOwnership(volume, image, identity, previous)).toThrow(/previous lab state owner/);
            expect(spawn.mock.calls.some(call => call[1].includes("--mount"))).toBe(false);
        },
    );
    it("rejects mutable image provenance and mount-option injection", () => {
        expect(() => prepareLabStateOwnership(volume, image, identity, "ccc:old")).toThrow(/immutable/);
        expect(() => prepareLabStateOwnership("x,target=/host", image, identity)).toThrow(/volume name/);
        expect(spawn).not.toHaveBeenCalled();
    });
    it("retains the volume on migration failure", () => {
        spawn.mockImplementation((_cli, args: string[]) => args[0] === "volume" ? ok(volume + "\n") : args.includes(previous) ? ok("1001:1001") : args.includes("--mount") ? { status: 1 } : ok());
        expect(() => prepareLabStateOwnership(volume, image, identity, previous)).toThrow(/Existing data was retained/);
        expect(spawn.mock.calls.some(call => call[1].includes("rm") && call[1][0] !== "run")).toBe(false);
    });
    it.each(["before\n" + volume + "\nafter", volume, "\n" + volume + "\n"])("finds only the exact native listed volume in %j", names => {
        spawn.mockReturnValueOnce(ok(names));
        prepareLabStateOwnership(volume, image, identity);
        expect(spawn).toHaveBeenCalledTimes(3);
        expect(spawn.mock.calls[2][1]).toContain(`type=volume,source=${volume},target=/state`);
    });
    it.each([{ status: 0, stdout: volume + "\n", error: new Error("unavailable") }, { status: 1, stdout: volume + "\n" }, { status: null, stdout: volume + "\n" }])(
        "does not treat failed listing as absent or trust its successful-looking output", result => {
            spawn.mockReturnValueOnce(result);
            expect(() => prepareLabStateOwnership(volume, image, identity)).toThrow("Unable to inspect lab state volumes.");
            expect(spawn).toHaveBeenCalledTimes(1);
        },
    );
    it("decodes whitespace-only users as idle before running the ownership helper", () => {
        spawn.mockImplementation((_cli, args: string[]) => args[0] === "volume" ? ok(volume + "\n") : args[0] === "ps" ? ok(" \r\n\t") : ok());
        prepareLabStateOwnership(volume, image, identity);
        expect(spawn).toHaveBeenCalledTimes(3);
        expect(spawn.mock.calls[2][1]).toContain("--mount");
    });
    it.each([" 00001:00002\n", "4294967294:4294967294", "2001:3001"])("decodes bounded prior principal %j before migration", ids => {
        spawn.mockImplementation((_cli, args: string[]) => args[0] === "volume" ? ok(volume + "\n") : args.includes(previous) ? ok(ids) : ok());
        prepareLabStateOwnership(volume, image, identity, previous);
        const [uid, gid] = ids.trim().split(":").map(Number);
        expect(spawn.mock.calls[3][1].at(-1)).toBe(`set -eu; find -P /state -xdev -uid ${uid} -exec chown -h 2001 {} +; find -P /state -xdev -gid ${gid} -exec chgrp -h 3001 {} +; chown 2001:3001 /state`);
    });
    it.each([{ status: 0, stdout: "1001:1002", error: new Error("unavailable") }, { status: 1, stdout: "1001:1002" }, { status: null, stdout: "1001:1002" }])(
        "refuses prior principal output when its native observation is unavailable", result => {
            spawn.mockImplementation((_cli, args: string[]) => args[0] === "volume" ? ok(volume + "\n") : args.includes(previous) ? result : ok());
            expect(() => prepareLabStateOwnership(volume, image, identity, previous)).toThrow("Cannot establish previous lab state owner");
            expect(spawn).toHaveBeenCalledTimes(3);
        },
    );
    it("does not confirm or replay an ownership helper with an error and zero exit status", () => {
        spawn.mockImplementation((_cli, args: string[]) => args[0] === "volume" ? ok(volume + "\n") : args.includes("--mount") ? { status: 0, error: new Error("unconfirmed") } : ok());
        expect(() => prepareLabStateOwnership(volume, image, identity)).toThrow("Existing data was retained");
        expect(spawn).toHaveBeenCalledTimes(3);
    });
});
