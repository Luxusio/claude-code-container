import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "../helpers/native-runtime-fixture.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), filesystem: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(),
    spawnSync: native.spawn,
    spawn: () => { throw new Error("Forbidden fixture process"); },
    exec: () => { throw new Error("Forbidden fixture process"); },
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
            if (selected instanceof URL && selected.href === manifest.href) {
                return JSON.stringify({ version: "0.0.0-fixture" });
            }
            return blocked();
        },
        existsSync: blocked, statSync: blocked, lstatSync: blocked, realpathSync: blocked,
        mkdirSync: blocked, writeFileSync: blocked, openSync: blocked, fstatSync: blocked,
        closeSync: blocked, rmSync: blocked, chmodSync: blocked, readdirSync: blocked,
        unlinkSync: blocked, renameSync: blocked, readSync: blocked,
    };
});
vi.mock("os", async original => ({
    ...await original<typeof import("node:os")>(),
    homedir: () => process.platform === "win32" ? "C:\\ccc-socket-fake\\home" : "/ccc-socket-fake/home",
}));

// Docker, application, native composition and runtime selection remain real.
const docker = await import("../../docker.js");
const runtime = await import("../../container-runtime.js");
const nativeCalls = () => native.spawn.mock.calls.map(call => normalizeNativeRuntimeCall(call));
const probeScript = 's=/var/run/docker.sock; [ -S "$s" ] || exit 0; [ -r "$s" ] && [ -w "$s" ] && exit 0; id -un; stat -c %g "$s"; exit 10';
const grantScript = 'u="$1"; g="$2"; n=$(getent group "$g" | cut -d: -f1); if [ -z "$n" ]; then if getent group ccc-host-socket >/dev/null; then groupmod -g "$g" ccc-host-socket; else groupadd -g "$g" ccc-host-socket; fi; n=ccc-host-socket; fi; usermod -aG "$n" "$u"';
const warning = "[ccc] Could not grant the container user access to the container-manager socket; docker commands inside the container may need sudo.";
const probeCall = (cli: string, target: string) => [cli, ["exec", target, "sh", "-c", probeScript], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
}];
const grantCall = (cli: string, target: string, user = "ccc", gid = "0") => [cli, [
    "exec", "--user", "root", target, "timeout", "-k", "2s", "8s", "sh", "-c", grantScript, "ccc-socket-grant", user, gid,
], { stdio: "ignore", timeout: 10_000 }];
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}
beforeEach(() => {
    vi.resetAllMocks();
    preloadNativeRuntimeFixture(runtime, { runtime: "docker" });
    docker.resetContainerManagerSocketAccessWarningForTest();
    native.spawn.mockImplementation(() => { throw new Error("Unplanned fixture native command"); });
    vi.spyOn(console, "warn").mockImplementation(function (this: unknown) {
        return undefined;
    });
});
afterEach(() => {
    expect(native.filesystem).not.toHaveBeenCalled();
    docker.resetContainerManagerSocketAccessWarningForTest();
    runtime._resetRuntimeCacheForTest();
    vi.restoreAllMocks();
});

describe("container socket access actual public facade", () => {
    it("preserves both literal native script exports", () => {
        expect(docker.CONTAINER_MANAGER_SOCKET_PROBE).toBe(probeScript);
        expect(docker.CONTAINER_MANAGER_SOCKET_GRANT).toBe(grantScript);
        expect(grantScript).not.toMatch(/\bch(mod|own|grp)\b/);
    });
    it.each(["docker", "podman"] as const)("dispatches exactly one default-user %s probe on status zero", cli => {
        preloadNativeRuntimeFixture(runtime, { runtime: cli });
        native.spawn.mockReturnValueOnce({ status: 0, stdout: "invalid ignored output" });
        expect(docker.ensureContainerManagerSocketAccess("selected-target")).toBeUndefined();
        expect(nativeCalls()).toEqual([probeCall(cli, "selected-target")]);
        expect(console.warn).not.toHaveBeenCalled();
    });
    it.each([
        ["a", "0"], ["_", "1"], ["a_b-9", "000"], ["a".repeat(32), "1234567890"], ["ubuntu", "1000"],
    ])("accepts native user %s and GID %s at the syntax boundaries", (user, gid) => {
        native.spawn.mockReturnValueOnce({ status: 10, stdout: `${user}\n${gid}\n` }).mockReturnValueOnce({ status: 0 });
        expect(docker.ensureContainerManagerSocketAccess("target")).toBeUndefined();
        expect(nativeCalls()).toEqual([probeCall("docker", "target"), grantCall("docker", "target", user, gid)]);
        expect(console.warn).not.toHaveBeenCalled();
    });
    it("keeps exact bounded root grant arguments, leading-zero GID and the first two whitespace-delimited tokens", () => {
        native.spawn.mockReturnValueOnce({ status: 10, stdout: " \tubuntu\n00042 surplus output\n" })
            .mockReturnValueOnce({ status: 0 });
        expect(docker.ensureContainerManagerSocketAccess("pinned-id")).toBeUndefined();
        expect(nativeCalls()).toEqual([probeCall("docker", "pinned-id"), grantCall("docker", "pinned-id", "ubuntu", "00042")]);
        expect(console.warn).not.toHaveBeenCalled();
    });
    it("selects the actual runtime separately at probe and grant dispatch", () => {
        native.spawn.mockImplementationOnce(() => {
            preloadNativeRuntimeFixture(runtime, { runtime: "podman", flavor: "podman-rootless", rootless: true });
            return { status: 10, stdout: "ccc 0" };
        }).mockReturnValueOnce({ status: 0 });
        docker.ensureContainerManagerSocketAccess("target");
        expect(nativeCalls()).toEqual([probeCall("docker", "target"), grantCall("podman", "target")]);
    });
    it.each([1, -1, null, 124, 137])("warns once for native probe status %s without privileged dispatch", status => {
        native.spawn.mockReturnValue({ status, stdout: "ccc 0" });
        docker.ensureContainerManagerSocketAccess("one");
        docker.ensureContainerManagerSocketAccess("two");
        expect(nativeCalls()).toEqual([probeCall("docker", "one"), probeCall("docker", "two")]);
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
    });
    it.each([
        undefined, null, "", " \t\n", "ccc", "0ccc 0", "CCC 0", "bad;user 0", "ccc$(id) 0",
        `${"a".repeat(33)} 0`, "ccc -1", "ccc 0x1", "ccc 1;id", "ccc 12345678901", 123,
    ])("refuses malformed status-ten native output %s without privileged dispatch", stdout => {
        native.spawn.mockReturnValueOnce({ status: 10, stdout });
        expect(docker.ensureContainerManagerSocketAccess("target")).toBeUndefined();
        expect(nativeCalls()).toEqual([probeCall("docker", "target")]);
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
    });
    it.each([1, -1, null, 124, 137])("warns and continues after native grant status %s", status => {
        native.spawn.mockReturnValueOnce({ status: 10, stdout: "ccc 0" }).mockReturnValueOnce({ status });
        expect(docker.ensureContainerManagerSocketAccess("target")).toBeUndefined();
        expect(nativeCalls()).toEqual([probeCall("docker", "target"), grantCall("docker", "target")]);
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
    });
    it.each([0, 10])("preserves status-only native probe classification for status %s even with an error field", status => {
        native.spawn.mockReturnValueOnce({ status, stdout: "ccc 0", error: new Error("probe fixture detail") })
            .mockReturnValueOnce({ status: 0, error: new Error("grant fixture detail") });
        expect(docker.ensureContainerManagerSocketAccess("target")).toBeUndefined();
        expect(nativeCalls()).toEqual([probeCall("docker", "target"), ...(status === 10 ? [grantCall("docker", "target")] : [])]);
        expect(console.warn).not.toHaveBeenCalled();
    });
    it.each(["probe", "grant"] as const)("propagates native %s dispatch exceptions without a warning or later dispatch", step => {
        for (const failure of [new Error(step), { step }]) {
            native.spawn.mockReset();
            if (step === "grant") native.spawn.mockReturnValueOnce({ status: 10, stdout: "ccc 0" });
            native.spawn.mockImplementationOnce(() => { throw failure; });
            expect(thrown(() => docker.ensureContainerManagerSocketAccess("target"))).toBe(failure);
            expect(nativeCalls()).toEqual([probeCall("docker", "target"), ...(step === "grant" ? [grantCall("docker", "target")] : [])]);
            expect(console.warn).not.toHaveBeenCalled();
        }
    });
    it("shares warning state across probe/grant failures and targets; reset has no native effects", () => {
        native.spawn.mockReturnValueOnce({ status: 10, stdout: "ccc 0" }).mockReturnValueOnce({ status: null })
            .mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 10, stdout: "ccc 0" }).mockReturnValueOnce({ status: 1 });
        docker.ensureContainerManagerSocketAccess("one"); docker.ensureContainerManagerSocketAccess("two");
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
        const previous = [...nativeCalls()];
        expect(docker.resetContainerManagerSocketAccessWarningForTest()).toBeUndefined();
        expect(nativeCalls()).toEqual(previous);
        docker.ensureContainerManagerSocketAccess("three");
        expect(console.warn).toHaveBeenCalledTimes(2);
        expect(nativeCalls()).toEqual([probeCall("docker", "one"), grantCall("docker", "one"), probeCall("docker", "two"), probeCall("docker", "three"), grantCall("docker", "three")]);
    });
    it("deduplicates reentrant and later warnings after publication throws", () => {
        const failure = { warning: "failure" };
        native.spawn.mockReturnValue({ status: 1 });
        vi.mocked(console.warn).mockImplementation(function (this: unknown, message) {
            expect(message).toBe(warning);
            docker.ensureContainerManagerSocketAccess("reentrant");
            throw failure;
        });
        expect(thrown(() => docker.ensureContainerManagerSocketAccess("outer"))).toBe(failure);
        expect(docker.ensureContainerManagerSocketAccess("later")).toBeUndefined();
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(nativeCalls()).toEqual([probeCall("docker", "outer"), probeCall("docker", "reentrant"), probeCall("docker", "later")]);
        docker.resetContainerManagerSocketAccessWarningForTest();
        vi.mocked(console.warn).mockImplementation(() => undefined);
        docker.ensureContainerManagerSocketAccess("reset");
        expect(console.warn).toHaveBeenCalledTimes(2);
    });
});
