import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import type { RuntimeName } from "../../domain/container-runtime.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), cli: vi.fn(), info: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("../../container-runtime.js", async original => ({
    ...await original<typeof import("../../container-runtime.js")>(),
    runtimeCli: native.cli, getRuntimeInfo: native.info,
}));

// Both the public Docker facade and its application policy remain real.
const docker = await import("../../docker.js");
const options = { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] };
const cases: Array<[RuntimeName, string, string]> = [
    ["docker", "docker-desktop", "Please start Docker Desktop and try again."],
    ["docker", "docker-native", "Please start the docker service (e.g. `sudo systemctl start docker`) and try again."],
    ["podman", "podman-machine", "Please start the Podman machine (`podman machine start`) and try again."],
    ["podman", "podman-rootless", "Please start the rootless Podman service (`systemctl --user start podman.socket`) and try again."],
    ["podman", "podman-rootful", "Please start the Podman service (`sudo systemctl start podman.socket`) and try again."],
    ["docker", "podman-machine", "Please start the docker service (e.g. `sudo systemctl start docker`) and try again."],
    ["docker", "future-flavor", "Please start the docker service (e.g. `sudo systemctl start docker`) and try again."],
    ["podman", "docker-desktop", "Please start the Podman service (`sudo systemctl start podman.socket`) and try again."],
    ["podman", "unknown", "Please start the Podman service (`sudo systemctl start podman.socket`) and try again."],
    ["podman", "future-flavor", "Please start the Podman service (`sudo systemctl start podman.socket`) and try again."],
];

function result(status: number | null = 1, stderr = ""): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout: "", stderr, status, signal: null };
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

function fixture(runtime: RuntimeName = "docker", flavor = "docker-native", status: number | null = 1, stderr = "") {
    const trace: string[] = [];
    const info = { runtime, flavor };
    native.cli.mockImplementation(() => { trace.push("cli"); return "fixture-runtime"; });
    native.spawn.mockImplementation(() => { trace.push("probe"); return result(status, stderr); });
    native.info.mockImplementation(() => { trace.push("info"); return info; });
    vi.spyOn(console, "error").mockImplementation(function (this: unknown, message) {
        trace.push(message);
    });
    vi.spyOn(process, "exit").mockImplementation((function (this: unknown, code: unknown) {
        trace.push(`exit:${code}`);
    }) as typeof process.exit);
    return { trace, info };
}

function assertOnlyInfoProbe() {
    expect(native.spawn.mock.calls).toEqual([["fixture-runtime", ["info"], options]]);
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("DEBUG", "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("container runtime readiness public facade", () => {
    it.each([0, 1, 127, null])("preserves native info probe options and status %s classification", status => {
        fixture("docker", "docker-native", status);
        expect(docker.isDockerRunning()).toBe(status === 0);
        assertOnlyInfoProbe();
        expect(native.info).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
    });

    it("returns undefined on readiness without facts, diagnostics or exit", () => {
        const f = fixture("docker", "docker-native", 0);
        vi.stubEnv("DEBUG", "1");
        expect(docker.ensureDockerRunning()).toBeUndefined();
        expect(f.trace).toEqual(["cli", "probe"]);
        assertOnlyInfoProbe();
        expect(native.info).not.toHaveBeenCalled();
    });

    it.each(["docker", "podman"] as const)("probes the selected %s executable with info", runtime => {
        fixture(runtime);
        native.cli.mockReturnValue(runtime);
        expect(docker.isDockerRunning()).toBe(false);
        expect(native.spawn.mock.calls).toEqual([[runtime, ["info"], options]]);
        expect(native.info).not.toHaveBeenCalled();
    });

    it("does not report stderr from a successful probe even with DEBUG enabled", () => {
        fixture("podman", "podman-machine", 0, "native warning");
        vi.stubEnv("DEBUG", "1");
        expect(docker.ensureDockerRunning()).toBeUndefined();
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
        assertOnlyInfoProbe();
    });

    it.each(cases)("prints exact %s/%s guidance and exits once without service commands", (runtime, flavor, hint) => {
        const f = fixture(runtime, flavor);
        expect(docker.ensureDockerRunning()).toBeUndefined();
        expect(f.trace).toEqual(["cli", "probe", "info", `Error: ${runtime} is not running.`, hint, "exit:1"]);
        expect(native.info).toHaveBeenCalledTimes(1);
        assertOnlyInfoProbe();
    });

    it.each([
        ["1", "  native failure\n", true],
        ["1", " \n\t", false],
        ["", "native failure", false],
        [undefined, "native failure", false],
    ] as const)("preserves DEBUG %s with stderr %s before refusal", (debug, stderr, visible) => {
        const f = fixture("docker", "docker-native", 1, stderr);
        vi.stubEnv("DEBUG", debug);
        docker.ensureDockerRunning();
        expect(f.trace).toEqual([
            "cli", "probe",
            ...(visible ? ["cli", "[ccc:debug] fixture-runtime info failed: native failure"] : []),
            "info", "Error: docker is not running.", cases[1][2], "exit:1",
        ]);
        assertOnlyInfoProbe();
    });

});

describe("container runtime readiness facade failure behavior", () => {
    const steps = ["cli", "probe", "info", "report:1", "report:2", "exit"];

    it.each(steps)("preserves Error and non-Error throws at %s and stops later effects", step => {
        for (const failure of [new Error("native failure"), { failure: step }]) {
            const f = fixture("podman", "podman-rootless");
            let reports = 0;
            const visit = (name: string) => {
                f.trace.push(name);
                if (step === name) throw failure;
            };
            native.cli.mockImplementation(() => { visit("cli"); return "fixture-runtime"; });
            native.spawn.mockImplementation(() => { visit("probe"); return result(); });
            native.info.mockImplementation(() => { visit("info"); return f.info; });
            vi.mocked(console.error).mockImplementation(() => { visit(`report:${++reports}`); });
            vi.mocked(process.exit).mockImplementation((() => { visit("exit"); }) as typeof process.exit);
            expect(thrown(() => docker.ensureDockerRunning())).toBe(failure);
            expect(f.trace).toEqual(steps.slice(0, steps.indexOf(step) + 1));
        }
    });

});
