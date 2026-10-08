import { describe, expect, it } from "vitest";
import { createContainerLaunchArguments, createContainerMountArguments } from "../../application/container-launch-arguments.js";
import type { ContainerLaunchOptions, CurrentContainerMount, LaunchRuntimeFacts } from "../../domain/container-launch-arguments.js";
import type { ContainerLaunchArgumentPorts, ContainerMountArgumentPorts } from "../../ports/container-launch-arguments.js";

function mountFixture() {
    const trace: string[] = [];
    const state = { mode: undefined as string | undefined, marker: undefined as string | undefined, vitest: false, enforcing: false, cgroups: undefined as string | undefined,
        facts: { runtime: "docker", flavor: "docker-native", socketPath: "/var/run/docker.sock", remote: false } as LaunchRuntimeFacts, mounts: [] as CurrentContainerMount[] };
    const ports: ContainerMountArgumentPorts = {
        readSelinuxRelabelMode: () => { trace.push("mode"); return state.mode; },
        readRuntimeName: () => { trace.push("runtime"); return state.facts.runtime; },
        observeSelinuxEnforcing: () => { trace.push("selinux"); return state.enforcing; },
        readContainerMarker: () => { trace.push("marker"); return state.marker; },
        isVitestProcess: () => { trace.push("vitest"); return state.vitest; },
        observeCurrentContainerMounts: () => { trace.push("mounts"); return state.mounts; },
        captureHostJoin: () => { trace.push("capture-join"); return (...parts) => { trace.push("join"); return parts.join("/"); }; },
        readRuntimeInfo: () => { trace.push("facts"); return state.facts; },
        readPodmanCgroups: () => { trace.push("cgroups"); return state.cgroups; },
    };
    return { state, trace, ports, app: createContainerMountArguments(ports) };
}

function launchFixture() {
    const trace: string[] = [];
    let facts: LaunchRuntimeFacts = { runtime: "docker", flavor: "docker-native", socketPath: "/var/run/docker.sock", remote: false };
    const present = new Set<string>();
    const ports: ContainerLaunchArgumentPorts<object> = {
        captureBindMountArgs: () => { trace.push("capture-bind"); return (source, destination, options) => {
            trace.push("bind:" + source + ":" + destination + ":" + (options?.sourceNamespace ?? "client"));
            return ["-v", source + ":" + destination + (options?.readonly ? ":ro" : "")];
        }; },
        captureRuntimeExtraRunArgs: () => () => { trace.push("extra"); return []; },
        readRuntimeInfo: () => { trace.push("facts"); return facts; },
        captureExistsSync: () => { trace.push("capture-exists"); return path => { trace.push("exists:" + path); return present.has(path); }; },
        captureHostJoin: () => { trace.push("capture-join"); return (...parts) => parts.join("/"); },
        captureIdentityLabels: () => { trace.push("capture-labels"); return () => { trace.push("labels"); return { "identity.key": "value" }; }; },
        captureEntries: () => { trace.push("capture-entries"); return Object.entries; },
        readCliVersion: () => "fixture-version",
        readProjectMountIdentityLabel: () => "project.identity",
        readDeviceLabMountIdentityLabel: () => "device.identity",
        readCodexPackagesVolumeName: () => "packages",
        readCodexPackagesContainerDir: () => "/home/ccc/.codex/packages",
        readBrokerAuthContainerFile: () => "/run/auth/owner.json",
        readClipboardFilesContainerDir: () => "/run/clipboard-files",
    };
    const options: ContainerLaunchOptions<object> = { containerName: "ccc-fixture", fullPath: "/source", projectMountPath: "/project/fixture", credentialMounts: [], claudeJsonFile: "/claude.json", miseVolumeName: "mise", pidsLimit: "300", imageName: "image", hostSshDir: null, sshAgentSocket: null };
    return { trace, ports, options, present, setFacts: (value: LaunchRuntimeFacts) => { facts = value; }, app: createContainerLaunchArguments(ports) };
}

describe("runtime mount decision policy", () => {
    it("constructs without reading ports or native bindings", () => {
        const unavailable = new Proxy({}, { get() { throw new Error("eager binding"); } });
        expect(() => createContainerMountArguments(unavailable as ContainerMountArgumentPorts)).not.toThrow();
        expect(() => createContainerLaunchArguments(unavailable as ContainerLaunchArgumentPorts<object>)).not.toThrow();
    });
    it.each(["off", "OFF", "force", "FORCE"])("mode %s short-circuits runtime and SELinux", mode => {
        const f = mountFixture(); f.state.mode = mode;
        expect(f.app.needsSelinuxRelabel()).toBe(mode.toLowerCase() === "force"); expect(f.trace).toEqual(["mode"]);
    });
    it("auto only observes SELinux for Podman", () => {
        const f = mountFixture(); f.state.enforcing = true;
        expect(f.app.needsSelinuxRelabel()).toBe(false); expect(f.trace).toEqual(["mode", "runtime"]);
        f.trace.length = 0; f.state.facts.runtime = "podman";
        expect(f.app.needsSelinuxRelabel()).toBe(true); expect(f.trace).toEqual(["mode", "runtime", "selinux"]);
    });
    it("named volumes skip namespace environment and relabel observations", () => {
        const f = mountFixture(); f.state.mode = "force";
        expect(f.app.bindMountArgs("volume", "/target", { readonly: true })).toEqual(["-v", "volume:/target:ro"]); expect(f.trace).toEqual([]);
    });
    it("reads readonly before namespace and daemon bypasses translation", () => {
        const f = mountFixture(); const events: string[] = []; f.state.mode = "force";
        const options = { get readonly() { events.push("readonly"); return true; }, get sourceNamespace() { events.push("namespace"); return "daemon" as const; } };
        expect(f.app.bindMountArgs("/daemon/socket", "/target", options)).toEqual(["-v", "/daemon/socket:/target:ro,Z"]);
        expect(events).toEqual(["readonly", "namespace"]); expect(f.trace).toEqual(["mode"]);
    });
    it.each(["vitest", "podman", "not-nested"])("%s skips mount observation", scenario => {
        const f = mountFixture(); f.state.mode = "off"; f.state.marker = scenario === "not-nested" ? undefined : "docker";
        f.state.vitest = scenario === "vitest"; f.state.facts.runtime = scenario === "podman" ? "podman" : "docker";
        expect(f.app.bindMountArgs("/caller/path", "/target")).toEqual(["-v", "/caller/path:/target"]); expect(f.trace).not.toContain("mounts");
    });
    it("uses longest boundary-matching destination and first equal-length winner", () => {
        const f = mountFixture(); f.state.marker = "docker"; f.state.mode = "off";
        f.state.mounts = [{ source: "/wrong-boundary", destination: "/project-other" }, { source: "/short", destination: "/project" }, { source: "/first", destination: "/project/nested" }, { source: "/second", destination: "/project/nested" }];
        expect(f.app.bindMountArgs("/project/nested/file", "/target")).toEqual(["-v", "/first/file:/target"]);
        expect(f.trace).toEqual(["marker", "vitest", "runtime", "mounts", "capture-join", "join", "mode"]);
    });
    it("does not translate a sibling that only shares the mount destination prefix", () => {
        const f = mountFixture(); f.state.marker = "docker"; f.state.mode = "off";
        f.state.mounts = [{ source: "/outer/project", destination: "/project" }];
        expect(f.app.bindMountArgs("/project-other/file", "/target")).toEqual(["-v", "/project-other/file:/target"]);
        expect(f.trace).toEqual(["marker", "vitest", "runtime", "mounts", "mode"]);
    });
    it("normalizes Desktop Windows source and skips join at exact root", () => {
        const f = mountFixture(); f.state.marker = "docker"; f.state.mode = "off";
        f.state.mounts = [{ source: "C:\\Users\\fixture", destination: "/project" }];
        expect(f.app.bindMountArgs("/project", "/target")).toEqual(["-v", "/run/desktop/mnt/host/c/Users/fixture:/target"]); expect(f.trace).not.toContain("capture-join");
    });
    it("propagates raw iterator failure without later observations", () => {
        const f = mountFixture(); const failure = { stage: "mount iterator" }; f.state.marker = "docker";
        f.state.mounts[Symbol.iterator] = () => { throw failure; };
        let caught: unknown; try { f.app.bindMountArgs("/project", "/target"); } catch (error) { caught = error; }
        expect(caught).toBe(failure); expect(f.trace).not.toContain("mode");
    });
    it.each([
        ["docker", false, "docker-native", undefined, [], false],
        ["podman", false, "podman-rootless", "disabled", ["--cgroups=disabled", "--userns=keep-id:uid=1000,gid=1000"], false],
        ["podman", false, "podman-rootful", "enabled", [], false],
        ["podman", false, "podman-rootful", undefined, ["--cgroups=disabled"], true],
        ["podman", true, "podman-machine", undefined, ["--userns=keep-id:uid=1000,gid=1000"], false],
    ] as const)("ordered facts/cgroups/marker for %s/%s/%s/%s", (runtime, remote, flavor, cgroups, expected, observesMarker) => {
        const f = mountFixture(); Object.assign(f.state.facts, { runtime, remote, flavor }); f.state.cgroups = cgroups; f.state.marker = "docker";
        expect(f.app.runtimeExtraRunArgs()).toEqual(expected); expect(f.trace).toEqual(observesMarker ? ["facts", "cgroups", "marker"] : ["facts", "cgroups"]);
    });
});

describe("complete container launch operation", () => {
    it("selects socket with fresh observations for both independent call sites", () => {
        const f = launchFixture(); f.setFacts({ runtime: "podman", flavor: "podman-rootless", socketPath: "/podman.sock", remote: false });
        expect(f.app.resolveHostSocketPath()).toBe("/var/run/docker.sock"); f.present.add("/podman.sock");
        expect(f.app.resolveHostSocketPath()).toBe("/podman.sock");
        expect(f.trace).toEqual(["facts", "capture-exists", "exists:/podman.sock", "facts", "capture-exists", "exists:/podman.sock"]);
    });
    it("resolves source then captures bind before the second facts read", () => {
        const f = launchFixture(); let reads = 0;
        f.ports.readRuntimeInfo = () => { f.trace.push("facts:" + ++reads); return { runtime: "docker", flavor: "docker-native", socketPath: "/daemon/custom.sock", remote: true }; };
        f.app.buildRunArgs(f.options);
        const first = f.trace.indexOf("facts:1"); expect(f.trace.slice(first, first + 4)).toEqual(["facts:1", "capture-bind", "facts:2", "bind:/daemon/custom.sock:/var/run/docker.sock:daemon"]);
    });
    it("captures native bind before metadata replaces it and later captures see the replacement", () => {
        const f = launchFixture(); const original = f.ports.captureBindMountArgs;
        Object.defineProperty(f.options, "fullPath", { get() { f.ports.captureBindMountArgs = () => (source, destination) => ["-v", "changed:" + source + ":" + destination]; return "/source"; } });
        const args = f.app.buildRunArgs(f.options);
        expect(args).toContain("/source:/project/fixture"); expect(args).toContain("changed:/claude.json:/home/ccc/.claude.json"); f.ports.captureBindMountArgs = original;
    });
    it("captures join/exists/labels/entries before their argument getters", () => {
        const f = launchFixture(); f.options.deviceLabStateHostDir = "/devices"; f.options.identity = {};
        let owners = 0, clips = 0, identities = 0;
        Object.defineProperty(f.options, "deviceLabOwnerId", { get() { if (++owners === 2) f.ports.captureHostJoin = () => () => "wrong-join"; return "owner"; } });
        Object.defineProperty(f.options, "clipboardPortFile", { get() { if (++clips === 2) f.ports.captureExistsSync = () => () => false; return "/clipboard"; } });
        Object.defineProperty(f.options, "identity", { get() { if (++identities === 2) { f.ports.captureIdentityLabels = () => () => ({ wrong: "identity" }); f.ports.captureEntries = () => () => [["wrong", "entries"]]; } return {}; } });
        f.present.add("/clipboard"); const args = f.app.buildRunArgs(f.options);
        expect(args).toContain("/devices/owners/owner:/home/ccc/.ccc/devices/owners/owner"); expect(args).toContain("/clipboard:/run/ccc/clipboard.port:ro"); expect(args).toContain("identity.key=value"); expect(args.join(" ")).not.toContain("wrong");
    });
    it("keeps live mount iterators and captures each native call separately", () => {
        const f = launchFixture();
        f.options.credentialMounts[Symbol.iterator] = function* (): Generator<{ hostPath: string; containerPath: string }, undefined, unknown> { yield { hostPath: "/first", containerPath: "/first-target" }; f.ports.captureBindMountArgs = () => (source, destination) => ["-v", "late:" + source + ":" + destination]; yield { hostPath: "/second", containerPath: "/second-target" }; return undefined; };
        const args = f.app.buildRunArgs(f.options); expect(args).toContain("/first:/first-target"); expect(args).toContain("late:/second:/second-target");
    });
    it("propagates raw getter failures and skips later effects", () => {
        const f = launchFixture(), failure = Symbol("failure");
        Object.defineProperty(f.options, "fullPath", { get() { throw failure; } });
        let caught: unknown; try { f.app.buildRunArgs(f.options); } catch (error) { caught = error; }
        expect(caught).toBe(failure); expect(f.trace).toEqual(["capture-bind"]);
    });
    it("retains group zero and unsupported/false/absent branches", () => {
        const f = launchFixture(); f.options.labRunner = { status: "ready", stateVolumeName: "labs", stateContainerDir: "/labs", kvmDevicePath: "/dev/kvm", kvmGroupId: 0, networkMode: "user" };
        const ready = f.app.buildRunArgs(f.options); expect(ready).toContain("labs:/labs"); expect(ready).toContain("0");
        f.options.labRunner = { status: "unsupported", stateVolumeName: "labs", stateContainerDir: "/labs", networkMode: "user", unsupportedReason: "fixture" }; f.options.proxyEnabled = false; f.options.containerHostRemote = false;
        const unsupported = f.app.buildRunArgs(f.options); expect(unsupported).not.toContain("labs:/labs"); expect(unsupported).not.toContain("--device"); expect(unsupported).not.toContain("--privileged"); expect(unsupported).toContain("CCC_LAB_RUNNER_UNSUPPORTED_REASON=fixture"); expect(unsupported).not.toContain("CCC_PROXY_ENABLED=1"); expect(unsupported.at(-1)).toBe("image");
    });
});
