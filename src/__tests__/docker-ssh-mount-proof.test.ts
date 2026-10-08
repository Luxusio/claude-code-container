import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("child_process", async () => ({ ...await vi.importActual("child_process"), spawnSync: native.spawnSync }));
vi.mock("../container-runtime.js", async () => ({ ...await vi.importActual("../container-runtime.js"), runtimeCli: () => "docker" }));
import { readDirectoryMountMarker } from "../docker.js";
const marker = `/home/ccc/.ssh/.ccc-mount-identity-${"a".repeat(32)}`;
beforeEach(() => native.spawnSync.mockReset());
it("retries an unreadable SSH mount challenge as root without reading a key", () => {
    native.spawnSync.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0, stdout: "challenge" });
    expect(readDirectoryMountMarker("container-id", marker).stdout).toBe("challenge");
    expect(native.spawnSync.mock.calls[1][1]).toEqual(["exec", "--user", "root", "container-id", "cat", marker]);
});
it.each(["/home/ccc/.ssh/id_ed25519", "/other/.ccc-mount-identity-" + "a".repeat(32), "/home/ccc/.ssh/../secret"])("never elevates non-challenge path %s", path => {
    native.spawnSync.mockReturnValue({ status: 1 });
    expect(readDirectoryMountMarker("container-id", path).status).toBe(1);
    expect(native.spawnSync).toHaveBeenCalledTimes(1);
});
it("keeps a failed elevated challenge failed", () => {
    native.spawnSync.mockReturnValue({ status: 1 });
    expect(readDirectoryMountMarker("container-id", marker).status).toBe(1);
    expect(native.spawnSync).toHaveBeenCalledTimes(2);
});

it.each([
    { status: 1, stderr: "request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.56/exec/123/json, check if the server supports the requested api version" },
    { status: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" },
])("does not re-exec a generated SSH marker after engine transport failure", result => {
    native.spawnSync.mockReturnValue(result);
    expect(() => readDirectoryMountMarker("container-id", marker)).toThrow("Container engine is unavailable");
    expect(native.spawnSync).toHaveBeenCalledTimes(1);
    expect(native.spawnSync.mock.calls[0][2].timeout).toBe(5000);
});

it.each([
    { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
    { status: null, signal: "SIGTERM" },
])("does not elevate a timed-out or signaled marker probe", result => {
    native.spawnSync.mockReturnValue(result);
    expect(readDirectoryMountMarker("container-id", marker)).toBe(result);
    expect(native.spawnSync).toHaveBeenCalledTimes(1);
});
