import { describe, expect, it } from "vitest";
import { createRuntimeCapabilitiesCollector } from "../../application/runtime-capabilities.js";
import { decodeDockerRootlessOptions, deriveRuntimeFlavor, parseRuntimeVersion } from "../../domain/runtime-capabilities.js";
import type { RuntimeInfo } from "../../domain/runtime-capabilities.js";
import type { RuntimeCapabilitiesPorts, RuntimeCapabilityProbeResult } from "../../ports/runtime-capabilities.js";

function fixture() {
    const trace: string[] = [];
    let cached: RuntimeInfo | null = null;
    const result = (name: string, status: number | null, stdout: string): RuntimeCapabilityProbeResult => ({
        get status() { trace.push(`${name}.status`); return status; },
        get stdout() { trace.push(`${name}.stdout`); return stdout; },
    });
    const ports: RuntimeCapabilitiesPorts = {
        readCachedInfo: () => { trace.push("cache"); return cached; },
        publishCachedInfo: info => { trace.push("publish"); cached = info; return undefined; },
        readVitestFlag: () => { trace.push("vitest"); return undefined; },
        readExplicitOverride: () => { trace.push("override"); return null; },
        selectRuntime: () => { trace.push("select"); return "docker"; },
        readPlatform: () => { trace.push("platform"); return "linux"; },
        observeVersion: () => { trace.push("version"); return result("version", 0, "Docker 27.1.1"); },
        observeDockerOperatingSystem: () => { trace.push("os"); return result("os", 0, "Ubuntu"); },
        readSelectedDockerEndpoint: () => { trace.push("endpoint"); return "unix:///selected.sock"; },
        observePodmanRemote: () => { trace.push("remote"); return result("remote", 0, "false"); },
        observeDockerSecurityOptions: () => { trace.push("security"); return result("security", 0, "[]"); },
        observePodmanRootless: () => { trace.push("rootless"); return result("rootless", 0, "false"); },
        readWslDistributionName: () => { trace.push("wsl"); return undefined; },
        observeWslMirroredLoopback: () => { trace.push("loopback"); return false; },
        readRuntimeSocketOverride: () => { trace.push("socket"); return undefined; },
        readXdgRuntimeDirectory: () => { trace.push("xdg"); return undefined; },
        readEffectiveUidOrDefault: () => { trace.push("uid"); return 1000; },
        joinPodmanSocketPath: xdg => { trace.push("join"); return `${xdg}/podman/podman.sock`; },
    };
    return { ports, trace, collect: () => createRuntimeCapabilitiesCollector(ports), cached: () => cached };
}

describe("complete runtime capability policy", () => {
    it("requires every explicit semantic port, including lazy WSL observation", () => {
        const { ports } = fixture();
        for (const name of Object.keys(ports)) {
            const incomplete = { ...ports }; Reflect.deleteProperty(incomplete, name);
            expect(() => createRuntimeCapabilitiesCollector(incomplete)).toThrow(`callable ${name} port`);
        }
    });
    it("collects in original order and publishes only complete info", () => {
        const { collect, trace } = fixture();
        expect(collect()()).toEqual({ runtime: "docker", flavor: "docker-native", version: "27.1.1", socketPath: "/var/run/docker.sock", rootless: false, remote: false, dockerDesktop: false });
        expect(trace).toEqual(["cache", "vitest", "select", "version", "version.status", "version.stdout", "os", "os.status", "os.stdout", "platform", "wsl", "platform", "security", "security.status", "security.stdout", "socket", "publish", "cache"]);
    });
    it("returns cache by identity before environment and retains external mutation", () => {
        const { collect, ports, trace } = fixture(); const get = collect(); const first = get(); first.version = "mutated"; trace.length = 0;
        ports.readVitestFlag = () => { throw Error("environment must be skipped"); };
        expect(get()).toBe(first); expect(trace).toEqual(["cache"]);
    });
    it("publishes the fixed Vitest stub unless a current explicit override exists", () => {
        const { ports, collect, trace } = fixture(); ports.readVitestFlag = () => "1";
        expect(collect()()).toMatchObject({ runtime: "docker", version: "0.0.0", rootless: false, remote: false, dockerDesktop: false });
        expect(trace).toEqual(["cache", "override", "publish", "cache"]);
        const actual = fixture(); actual.ports.readVitestFlag = () => "1"; actual.ports.readExplicitOverride = () => "docker";
        expect(actual.collect()().version).toBe("27.1.1");
    });
    it.each([false, true])("observes mirrored loopback only for truthy Linux Docker WSL, mirrored=%s", mirrored => {
        const { ports, collect, trace } = fixture(); ports.readWslDistributionName = () => "Ubuntu"; ports.observeWslMirroredLoopback = () => { trace.push("loopback"); return mirrored; };
        expect(collect()().remote).toBe(!mirrored); expect(trace).toContain("loopback");
        const falsy = fixture(); falsy.ports.readWslDistributionName = () => ""; falsy.ports.observeWslMirroredLoopback = () => { throw Error("skip loopback"); };
        expect(falsy.collect()().remote).toBe(false);
    });
    it("propagates WSL getter faults without publishing and skips WSL for Desktop", () => {
        const failed = fixture(); const fault = Error("wsl"); failed.ports.readWslDistributionName = () => { throw fault; };
        expect(() => failed.collect()()).toThrow(fault); expect(failed.cached()).toBeNull();
        const desktop = fixture(); desktop.ports.observeDockerOperatingSystem = () => ({ status: 0, stdout: "Docker Desktop" }); desktop.ports.readWslDistributionName = () => { throw fault; };
        expect(desktop.collect()()).toMatchObject({ dockerDesktop: true, remote: true });
    });
    it("keeps changing platform observations separate across phases", () => {
        const { ports, collect, trace } = fixture(); const platforms = ["win32", "linux", "darwin", "linux"];
        ports.observeDockerOperatingSystem = () => ({ status: 1, get stdout(): never { throw Error("failed OS stdout must be skipped"); } });
        ports.readPlatform = () => { trace.push("platform"); return platforms.shift()!; };
        expect(collect()()).toMatchObject({ dockerDesktop: false, remote: true, rootless: false, flavor: "docker-desktop" });
        expect(trace.filter(name => name === "platform")).toHaveLength(4);
    });
    it("successful nonDesktop OS defeats exact Windows pipe and skips endpoint", () => {
        const { ports, collect, trace } = fixture(); ports.readPlatform = () => "win32";
        ports.readSelectedDockerEndpoint = () => { throw Error("endpoint must be skipped"); };
        expect(collect()()).toMatchObject({ dockerDesktop: false, remote: true, flavor: "docker-desktop" }); expect(trace).not.toContain("endpoint");
    });
    it.each(["ssh://remote", "tcp://remote:2376", null])("does not grant Desktop through nonlocal endpoint %s", endpoint => {
        const { ports, collect } = fixture(); ports.observeDockerOperatingSystem = () => ({ status: 0, stdout: "Docker Desktop" }); ports.readSelectedDockerEndpoint = () => endpoint;
        expect(collect()().dockerDesktop).toBe(false);
    });
    it.each(["version", "os", "security", "socket"])("retries complete collection after %s failure without publishing", stage => {
        const { ports, collect, trace, cached } = fixture(); const fault = Error(stage);
        const operations = { version: "observeVersion", os: "observeDockerOperatingSystem", security: "observeDockerSecurityOptions", socket: "readRuntimeSocketOverride" } as const;
        Object.defineProperty(ports, operations[stage as keyof typeof operations], { value: () => { throw fault; } });
        const get = collect(); for (let index = 0; index < 2; index++) expect(() => get()).toThrow(fault);
        expect(cached()).toBeNull(); expect(trace.filter(name => name === "select")).toHaveLength(2); expect(trace).not.toContain("publish");
    });
    it("consumes raw result lazily and never accesses failed-version stdout", () => {
        const { ports, collect, trace } = fixture(); let statusReads = 0;
        ports.observeVersion = () => ({ get status() { statusReads++; return 1; }, get stdout(): never { throw Error("stdout"); } });
        expect(collect()().version).toBeNull(); expect(statusReads).toBe(1); expect(trace).not.toContain("version.stdout");
    });
    it("distinguishes ignored rootless UID failures from propagating socket UID failures", () => {
        const { ports, collect } = fixture(); ports.selectRuntime = () => "podman"; ports.observePodmanRootless = () => ({ status: 1, stdout: "" }); ports.readEffectiveUidOrDefault = () => { throw Error("uid"); };
        expect(collect()().rootless).toBe(false);
        const socket = fixture(); socket.ports.selectRuntime = () => "podman"; socket.ports.observePodmanRootless = () => ({ status: 0, stdout: "true" }); socket.ports.readEffectiveUidOrDefault = () => { throw Error("socket-uid"); };
        expect(() => socket.collect()()).toThrow("socket-uid"); expect(socket.cached()).toBeNull();
    });
    it("prioritizes socket override then XDG join over UID", () => {
        const { ports, collect } = fixture(); ports.selectRuntime = () => "podman"; ports.observePodmanRootless = () => ({ status: 0, stdout: "true" }); ports.readRuntimeSocketOverride = () => " raw socket "; ports.readXdgRuntimeDirectory = () => { throw Error("skip"); };
        expect(collect()().socketPath).toBe(" raw socket ");
        const xdg = fixture(); xdg.ports.selectRuntime = () => "podman"; xdg.ports.observePodmanRootless = () => ({ status: 0, stdout: "true" }); xdg.ports.readXdgRuntimeDirectory = () => "/run/custom"; xdg.ports.readEffectiveUidOrDefault = () => { throw Error("skip"); };
        expect(xdg.collect()().socketPath).toBe("/run/custom/podman/podman.sock");
    });
});

describe("runtime capability domain compatibility", () => {
    it("preserves version matching, rootless JSON/fallback and remote flavor", () => {
        expect(parseRuntimeVersion("Docker version 27.1.1")).toBe("27.1.1"); expect(parseRuntimeVersion("podman version 5.2")).toBe("5.2"); expect(parseRuntimeVersion("unavailable")).toBeNull();
        expect(decodeDockerRootlessOptions('["name=rootless"]')).toBe(true); expect(decodeDockerRootlessOptions("rootless")).toBe(true); expect(decodeDockerRootlessOptions('"rootless"')).toBe(false);
        expect(deriveRuntimeFlavor("docker", true, false)).toBe("docker-desktop"); expect(deriveRuntimeFlavor("podman", true, false)).toBe("podman-machine");
    });
});
