import { beforeEach, expect, it, vi } from "vitest";
import { containerEngineFailureHint, ContainerEngineUnavailableError } from "../domain/container-runtime.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectId } from "../utils.js";
const native = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("child_process", async () => ({ ...await vi.importActual("child_process"), spawnSync: native.spawnSync }));
vi.mock("../container-runtime.js", async () => ({ ...await vi.importActual("../container-runtime.js"), runtimeCli: () => "docker" }));
import { getManagedProjectContainerIdentity, getContainerIdentity } from "../docker.js";
const failure = "request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.56/exec/18c123/json, check if the server supports the requested api version";
beforeEach(() => native.spawnSync.mockReset());

it("stops JSON inspection retries after a known unavailable engine", () => {
    native.spawnSync.mockReturnValue({ status: 1, stderr: failure });
    expect(() => getManagedProjectContainerIdentity("ccc-fixture", "/project/fixture")).toThrow(ContainerEngineUnavailableError);
    expect(native.spawnSync).toHaveBeenCalledTimes(1);
    expect(native.spawnSync.mock.calls[0][1]).toEqual(["inspect", "-f", "{{json .}}", "ccc-fixture"]);
    expect(native.spawnSync.mock.calls[0][2].timeout).toBe(5000);
});

it("keeps failed identity inspection unknown and bounded", () => {
    native.spawnSync.mockReturnValue({ status: 1, stderr: failure });
    expect(getContainerIdentity("ccc-fixture")).toBeNull();
    expect(native.spawnSync).toHaveBeenCalledTimes(1);
    expect(native.spawnSync.mock.calls[0][2].timeout).toBe(5000);
});

it("preserves engine diagnosis after successful inspection followed by a live mount-proof failure", () => {
    const project = mkdtempSync(join(tmpdir(), "ccc-engine-proof-"));
    try {
        native.spawnSync.mockImplementation((_command, args = []) => args[0] === "inspect"
            ? { status: 0, stdout: JSON.stringify({ Id: "fixture-id", State: { Running: true }, Config: { Labels: { "ccc.managed": "true", "ccc.project.path": project } }, Mounts: [{ Type: "bind", Source: project, Destination: `/project/${getProjectId(project)}`, RW: true }] }) }
            : { status: 1, stderr: failure });
        expect(() => getManagedProjectContainerIdentity("ccc-fixture", project)).toThrow(ContainerEngineUnavailableError);
        expect(native.spawnSync.mock.calls.filter(call => call[0] === "docker").map(call => call[1][0])).toEqual(["inspect", "exec"]);
    } finally {
        rmSync(project, { recursive: true, force: true });
    }
});

it.each(["Permission denied", "No such container: test", "unknown command app-server", "Error: daemon executable not found", undefined, { message: failure }])("does not mistake a nontransport outcome for engine failure: %s", text => {
    expect(containerEngineFailureHint(text)).toBeUndefined();
});

it.each([failure, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock", "error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified."])("classifies the engine failure without exposing the raw diagnostic", text => {
    const hint = containerEngineFailureHint(text);
    expect(hint).toContain("Container engine is unavailable");
    expect(hint).not.toContain("18c123");
});
