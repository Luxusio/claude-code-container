import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeProviderFixturePreloadSource } from "../helpers/node-provider-fixture.js";

const { probe } = vi.hoisted(() => ({ probe: vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>() }));
vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("node:child_process")>(),
    spawnSync: probe,
}));
const { spawnSync: nativeSpawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const runtime = await import("../../container-runtime.js");
const originalEnv = { ...process.env };
const versionArgs = ["--version"];
const probeOptions = { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" };
const noRuntimeError = "No container runtime found. Install podman or docker and ensure the CLI is on PATH.";

function response(status: number | null, stdout = ""): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

function calls(): unknown[][] {
    return probe.mock.calls.map(([command, args]) => [command, args]);
}

describe("container runtime selection compatibility facade", () => {
    beforeEach(() => {
        runtime._resetRuntimeCacheForTest();
        probe.mockReset().mockImplementation((command, args) => {
            if (JSON.stringify(args) === JSON.stringify(versionArgs)) {
                return response(0, command === "podman" ? "podman version 5.2.3" : "Docker version 27.1.1");
            }
            return response(0, "false");
        });
        for (const key of Object.keys(process.env)) {
            if (/^(?:CCC_|VITEST|DOCKER_|CONTAINER_|XDG_)/.test(key)
                || ["container", "WSL_DISTRO_NAME", "HOSTNAME"].includes(key)) delete process.env[key];
        }
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    });

    afterEach(() => {
        runtime._resetRuntimeCacheForTest();
        process.env = { ...originalEnv };
        vi.restoreAllMocks();
    });

    it.each([null, undefined, ""])("no-op override %s preserves cached identity and explicit selection", value => {
        runtime._setRuntimeInfoForTest({ runtime: "podman", version: "cached" });
        const cached = runtime.getRuntimeInfo();
        runtime.setRuntimeOverride(value);
        process.env.CCC_RUNTIME = "invalid";
        expect(runtime.getRuntimeInfo()).toBe(cached);
        expect(runtime.runtimeCli()).toBe("podman");
        expect(probe).not.toHaveBeenCalled();
    });

    it.each(["lxc", " Docker", "DOCKER", "podman ", "ｄｏｃｋｅｒ"])("invalid CLI override %s preserves state and exact error", value => {
        runtime._setRuntimeInfoForTest({ runtime: "docker" });
        const cached = runtime.getRuntimeInfo();
        expect(() => runtime.setRuntimeOverride(value)).toThrow(new Error(
            `Invalid --runtime value: '${value}'. Allowed: 'docker' or 'podman'.`,
        ));
        expect(runtime.getRuntimeInfo()).toBe(cached);
        expect(probe).not.toHaveBeenCalled();
    });

    it("a valid override, including a repeated value, invalidates info and defeats invalid environment", () => {
        runtime._setRuntimeInfoForTest({ runtime: "docker", version: "cached" });
        const cached = runtime.getRuntimeInfo();
        process.env.CCC_RUNTIME = "invalid";
        runtime.setRuntimeOverride("docker");
        const first = runtime.getRuntimeInfo();
        expect(first).not.toBe(cached);
        expect(first.version).toBe("27.1.1");
        expect(calls()).toEqual([
            ["docker", versionArgs],
            ["docker", ["info", "--format", "{{.OperatingSystem}}"]],
            ["docker", ["info", "--format", "{{json .SecurityOptions}}"]],
        ]);
        runtime.setRuntimeOverride("docker");
        expect(runtime.getRuntimeInfo()).not.toBe(first);
        runtime.setRuntimeOverride("podman");
        expect(runtime.runtimeCli()).toBe("podman");
    });

    it("cache lookup precedes changed environment, while uncached calls read current environment", () => {
        process.env.CCC_RUNTIME = "docker";
        const cached = runtime.getRuntimeInfo();
        const count = probe.mock.calls.length;
        process.env.CCC_RUNTIME = "invalid";
        expect(runtime.getRuntimeInfo()).toBe(cached);
        expect(probe).toHaveBeenCalledTimes(count);
        runtime._resetRuntimeCacheForTest();
        process.env.CCC_RUNTIME = "podman";
        expect(runtime.runtimeCli()).toBe("podman");
        runtime._resetRuntimeCacheForTest();
        process.env.CCC_RUNTIME = "docker";
        expect(runtime.runtimeCli()).toBe("docker");
    });

    it("VITEST bypasses invalid environment and probes, until an explicit override is set", () => {
        process.env.VITEST = "true";
        process.env.CCC_RUNTIME = "invalid";
        const stub = runtime.getRuntimeInfo();
        expect(stub).toEqual({
            runtime: "docker", flavor: "docker-native", version: "0.0.0",
            socketPath: "/var/run/docker.sock", rootless: false, remote: false, dockerDesktop: false,
        });
        expect(runtime.getRuntimeInfo()).toBe(stub);
        expect(probe).not.toHaveBeenCalled();
        runtime.setRuntimeOverride("podman");
        expect(runtime.getRuntimeInfo().version).toBe("5.2.3");
        expect(calls()[0]).toEqual(["podman", versionArgs]);
    });

    it.each(["lxc", " docker", "DOCKER"])("invalid CCC_RUNTIME %s fails before effects", value => {
        process.env.CCC_RUNTIME = value;
        expect(() => runtime.runtimeCli()).toThrow(new Error(
            `Invalid CCC_RUNTIME value: '${value}'. Allowed: 'docker' or 'podman'.`,
        ));
        expect(probe).not.toHaveBeenCalled();
    });

    it("empty environment prefers podman and preserves discovery argv/options and subsequent host facts", () => {
        process.env.CCC_RUNTIME = "";
        expect(runtime.getRuntimeInfo()).toEqual({
            runtime: "podman", flavor: "podman-rootful", version: "5.2.3",
            socketPath: "/run/podman/podman.sock", rootless: false, remote: false, dockerDesktop: false,
        });
        expect(calls()).toEqual([
            ["podman", versionArgs], ["podman", versionArgs],
            ["podman", ["info", "--format", "{{.Host.Remote}}"]],
            ["podman", ["info", "--format", "{{.Host.Security.Rootless}}"]],
        ]);
        for (const [, , options] of probe.mock.calls) expect(options).toEqual(probeOptions);
    });

    it.each([1, 127, null])("podman status %s falls back to docker only on exact zero success", status => {
        probe.mockReturnValueOnce(response(status));
        expect(runtime.runtimeCli()).toBe("docker");
        expect(calls().slice(0, 3)).toEqual([
            ["podman", versionArgs], ["docker", versionArgs], ["docker", versionArgs],
        ]);
    });

    it("no available runtime fails after exactly the two ordered availability effects", () => {
        probe.mockReturnValue(response(1));
        expect(() => runtime.getRuntimeInfo()).toThrow(new Error(noRuntimeError));
        expect(calls()).toEqual([["podman", versionArgs], ["docker", versionArgs]]);
    });

    it("an availability exception propagates by identity without fallback or cached failure", () => {
        const failure = new Error("fixture probe failed");
        probe.mockImplementationOnce(() => { throw failure; });
        try { runtime.getRuntimeInfo(); expect.fail("expected probe failure"); }
        catch (error) { expect(error).toBe(failure); }
        expect(calls()).toEqual([["podman", versionArgs]]);
        expect(runtime.runtimeCli()).toBe("podman");
    });
});

type NativeCase = {
    name: string; podmanStatus: number; dockerStatus: number;
    environment?: string; explicit?: string; selected?: "docker" | "podman"; error?: string;
};
const nativeCases: NativeCase[] = [
    { name: "podman preference", podmanStatus: 0, dockerStatus: 0, selected: "podman" },
    { name: "docker fallback", podmanStatus: 7, dockerStatus: 0, selected: "docker" },
    { name: "neither available", podmanStatus: 7, dockerStatus: 9, error: noRuntimeError },
    { name: "environment override", podmanStatus: 0, dockerStatus: 0, environment: "docker", selected: "docker" },
    { name: "environment override keeps unavailable runtime for host detection", podmanStatus: 0, dockerStatus: 7, environment: "docker", selected: "docker" },
    { name: "explicit override beats invalid environment", podmanStatus: 0, dockerStatus: 0, environment: "invalid", explicit: "podman", selected: "podman" },
    { name: "invalid environment", podmanStatus: 0, dockerStatus: 0, environment: " Docker", error: "Invalid CCC_RUNTIME value: ' Docker'. Allowed: 'docker' or 'podman'." },
    { name: "invalid CLI", podmanStatus: 0, dockerStatus: 0, explicit: "DOCKER", error: "Invalid --runtime value: 'DOCKER'. Allowed: 'docker' or 'podman'." },
];

describe.each(["source", "built"] as const)("actual Node %s facade with portable executable fixtures", artifact => {
    it.each(nativeCases)("$name", scenario => {
        const root = mkdtempSync(join(tmpdir(), "ccc-runtime-facade-"));
        const binDir = join(root, "bin");
        const home = join(root, "home");
        const trace = join(root, "trace.jsonl");
        const preload = join(root, "routing.cjs");
        mkdirSync(binDir); mkdirSync(home);
        writeFileSync(trace, "");
        try {
            for (const name of ["docker", "podman"] as const) {
                const status = name === "docker" ? scenario.dockerStatus : scenario.podmanStatus;
                writeFileSync(join(binDir, name), `#!${process.execPath}\n
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify([${JSON.stringify(name)}, args]) + '\\n');
if (args[0] === '--version') {
    process.stdout.write(${JSON.stringify(name === "docker" ? "Docker version 27.1.1\n" : "podman version 5.2.3\n")});
    process.exit(${status});
}
if (args[0] === 'info') {
    process.stdout.write(args[2] === '{{.OperatingSystem}}' ? 'Ubuntu fixture\\n' : 'false\\n');
    process.exit(0);
}
process.exit(91);
`);
            }
            writeFileSync(preload, nodeProviderFixturePreloadSource(binDir));
            const moduleUrl = new URL(artifact === "source" ? "../../container-runtime.ts" : "../../../dist/container-runtime.js", import.meta.url);
            const loader = createRequire(import.meta.url).resolve("tsx");
            const env: NodeJS.ProcessEnv = {
                PATH: binDir, HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home,
            };
            for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) {
                if (originalEnv[key]) env[key] = originalEnv[key];
            }
            if (scenario.environment !== undefined) env.CCC_RUNTIME = scenario.environment;
            const child = nativeSpawnSync(process.execPath, [
                "--require", preload,
                ...(artifact === "source" ? ["--import", pathToFileURL(loader).href] : []),
                "--input-type=module", "-e", `
const runtime = await import(${JSON.stringify(moduleUrl.href)});
try {
    runtime.setRuntimeOverride(${JSON.stringify(scenario.explicit) ?? "undefined"});
    const info = runtime.getRuntimeInfo();
    process.stdout.write(JSON.stringify({ info, cached: runtime.getRuntimeInfo() === info, cli: runtime.runtimeCli() }));
} catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }));
}
`,
            ], { cwd: binDir, env, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
            expect(child.error, `${artifact}: ${fileURLToPath(moduleUrl)}`).toBeUndefined();
            expect(child.status, child.stderr).toBe(0);
            expect(child.stderr).toBe("");
            const outcome = JSON.parse(child.stdout) as { info?: { runtime: string; version: string | null }; cached?: boolean; cli?: string; error?: string };
            const argv = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as [string, string[]]);
            const expected: [string, string[]][] = [];
            if (!scenario.environment && !scenario.explicit) {
                expected.push(["podman", versionArgs]);
                if (scenario.podmanStatus !== 0) expected.push(["docker", versionArgs]);
            }
            if (scenario.selected) {
                const selected = scenario.selected;
                expected.push([selected, versionArgs]);
                if (selected === "docker") expected.push([selected, ["info", "--format", "{{.OperatingSystem}}"]]);
                if (process.platform === "linux") {
                    if (selected === "podman") expected.push([selected, ["info", "--format", "{{.Host.Remote}}"]]);
                    expected.push([selected, ["info", "--format", selected === "docker" ? "{{json .SecurityOptions}}" : "{{.Host.Security.Rootless}}"]]);
                }
                expect(outcome.error).toBeUndefined();
                expect(outcome.info?.runtime).toBe(selected);
                const versionStatus = selected === "docker" ? scenario.dockerStatus : scenario.podmanStatus;
                expect(outcome.info?.version).toBe(versionStatus === 0 ? selected === "docker" ? "27.1.1" : "5.2.3" : null);
                expect(outcome.cached).toBe(true);
                expect(outcome.cli).toBe(selected);
            } else {
                expect(outcome).toEqual({ error: scenario.error });
            }
            expect(argv).toEqual(expected);
        } finally { rmSync(root, { recursive: true, force: true }); }
    }, 30000);
});
