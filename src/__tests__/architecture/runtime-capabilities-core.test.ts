import { describe, expect, it } from "vitest";
import { createRuntimeCapabilitiesCollector } from "../../application/runtime-capabilities.js";
import type { RuntimeCapabilitiesPorts } from "../../ports/runtime-capabilities.js";

function fixture() {
    const ports: RuntimeCapabilitiesPorts = {
        selectRuntime: () => "docker", readPlatform: () => "linux",
        observeVersion: () => "27.1.1", observeDockerOperatingSystem: () => "other",
        readSelectedDockerEndpoint: () => "unix:///selected.sock",
        observePodmanRemote: () => false, observeDockerSecurityOptions: () => false,
        observePodmanRootless: () => false, readWslDistributionName: () => undefined,
        observeWslMirroredLoopback: () => false, readRuntimeSocketOverride: () => undefined,
        readXdgRuntimeDirectory: () => undefined, readEffectiveUidOrDefault: () => 1000,
        joinPodmanSocketPath: xdg => `${xdg}/podman/podman.sock`,
    };
    return { ports, collect: () => createRuntimeCapabilitiesCollector(ports)() };
}

describe("runtime capability policy from semantic observations", () => {
    it("derives complete native Docker facts without probing Podman", () => {
        const { ports, collect } = fixture();
        ports.observePodmanRemote = ports.observePodmanRootless = () => { throw Error("unused provider"); };
        expect(collect()).toEqual({ runtime: "docker", flavor: "docker-native", version: "27.1.1", socketPath: "/var/run/docker.sock", rootless: false, remote: false, dockerDesktop: false });
    });
    it.each(["unavailable", "other"] as const)("Windows Desktop fallback distinguishes %s OS", os => {
        const { ports, collect } = fixture(); ports.readPlatform = () => "win32";
        ports.observeDockerOperatingSystem = () => os;
        ports.readSelectedDockerEndpoint = () => "npipe:////./pipe/dockerDesktopLinuxEngine";
        expect(collect()).toMatchObject({ dockerDesktop: os === "unavailable", remote: true, flavor: "docker-desktop", rootless: false });
    });
    it.each(["ssh://remote", "tcp://remote:2376", null])("does not grant Desktop through endpoint %s", endpoint => {
        const { ports, collect } = fixture(); ports.observeDockerOperatingSystem = () => "desktop"; ports.readSelectedDockerEndpoint = () => endpoint;
        expect(collect().dockerDesktop).toBe(false);
    });
    it("grants local Desktop capability and skips WSL", () => {
        const { ports, collect } = fixture(); ports.observeDockerOperatingSystem = () => "desktop";
        ports.readWslDistributionName = () => { throw Error("unused WSL"); };
        expect(collect()).toMatchObject({ dockerDesktop: true, remote: true, flavor: "docker-desktop" });
    });
    it.each([false, true])("preserves WSL mirrored networking=%s", mirrored => {
        const { ports, collect } = fixture(); ports.readWslDistributionName = () => "Ubuntu"; ports.observeWslMirroredLoopback = () => mirrored;
        expect(collect().remote).toBe(!mirrored);
        ports.readWslDistributionName = () => ""; ports.observeWslMirroredLoopback = () => { throw Error("unused loopback"); };
        expect(collect().remote).toBe(false);
    });
    it("preserves non-Linux remote defaults and legacy flavor without Desktop capability", () => {
        const { ports, collect } = fixture(); ports.readPlatform = () => "darwin";
        ports.observeDockerSecurityOptions = () => { throw Error("unused Linux rootless probe"); };
        expect(collect()).toMatchObject({ remote: true, rootless: false, flavor: "docker-desktop", dockerDesktop: false });
    });
    it.each([false, true])("derives Podman remote=%s without Docker probes", remote => {
        const { ports, collect } = fixture(); ports.selectRuntime = () => "podman"; ports.observePodmanRemote = () => remote;
        ports.observeDockerOperatingSystem = () => { throw Error("unused Docker"); }; ports.observeDockerSecurityOptions = () => { throw Error("unused Docker"); };
        expect(collect()).toMatchObject({ remote, flavor: remote ? "podman-machine" : "podman-rootful", dockerDesktop: false });
    });
    it.each([false, true, null])("distinguishes Podman rootless observation %s from UID fallback", rootless => {
        const { ports, collect } = fixture(); ports.selectRuntime = () => "podman"; ports.observePodmanRootless = () => rootless; ports.readRuntimeSocketOverride = () => "/chosen.sock";
        expect(collect().rootless).toBe(rootless ?? true);
    });
    it("ignores unknown-rootless UID faults but propagates socket UID faults", () => {
        const { ports, collect } = fixture(); ports.selectRuntime = () => "podman"; ports.observePodmanRootless = () => null;
        const fault = Error("uid"); ports.readEffectiveUidOrDefault = () => { throw fault; };
        expect(collect()).toMatchObject({ rootless: false, socketPath: "/run/podman/podman.sock" });
        ports.observePodmanRootless = () => true; expect(() => collect()).toThrow(fault);
    });
    it("uses root UID only when Podman rootless is unknown", () => {
        const { ports, collect } = fixture(); ports.selectRuntime = () => "podman"; ports.observePodmanRootless = () => null;
        ports.readEffectiveUidOrDefault = () => 0; expect(collect()).toMatchObject({ rootless: false, socketPath: "/run/podman/podman.sock" });
        ports.observePodmanRootless = () => false; ports.readEffectiveUidOrDefault = () => { throw Error("unused UID"); };
        expect(collect().rootless).toBe(false);
    });
    it("prioritizes socket override then XDG then native UID", () => {
        const { ports, collect } = fixture(); ports.selectRuntime = () => "podman"; ports.observePodmanRootless = () => true;
        ports.readRuntimeSocketOverride = () => " raw socket "; expect(collect().socketPath).toBe(" raw socket ");
        ports.readRuntimeSocketOverride = () => undefined; ports.readXdgRuntimeDirectory = () => "/run/custom";
        expect(collect().socketPath).toBe("/run/custom/podman/podman.sock");
        ports.readXdgRuntimeDirectory = () => undefined; expect(collect().socketPath).toBe("/run/user/1000/podman/podman.sock");
    });
    it("preserves unknown version and Docker rootless flavor", () => {
        const { ports, collect } = fixture(); ports.observeVersion = () => null; ports.observeDockerSecurityOptions = () => true;
        expect(collect()).toMatchObject({ version: null, rootless: true, flavor: "docker-rootless" });
    });
});
