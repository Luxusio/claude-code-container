import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", () => ({ spawnSync: spawn }));
vi.mock("../container-runtime.js", () => ({ runtimeCli: () => "docker", runtimeExtraRunArgs: () => [] }));
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
    it.each(["0:1001", "1001:0", "4294967295:1001", "1001:4294967295", "unknown", "1001:1001\nextra"])(
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
});
