import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncOptions } from "node:child_process";
import * as runtimeFacade from "../container-runtime.js";
import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "./helpers/native-runtime-fixture.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), stat: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: native.spawn }));
vi.mock("child_process", () => ({ spawnSync: native.spawn }));
vi.mock("node:fs", () => ({ lstatSync: native.stat }));
vi.mock("fs", () => ({ lstatSync: native.stat }));
vi.mock("node:path", async original => {
    const actual = await original<typeof import("node:path")>();
    return { ...actual, resolve: actual.win32.resolve, dirname: actual.win32.dirname };
});
vi.mock("@ccc/device-lab/windows-system-powershell.js", () => ({
    canonicalWindowsPowerShellPath: () => "trusted-powershell.exe",
    hiddenWindowsPowerShellArgs: (args: string[]) => args,
}));
import { prepareWindowsCredentialAccess, repairWindowsCodexPrivateState } from "../adapters/windows-credential-access.js";

const directory = "/home/ccc/.claude";
const target = "pinned-container";
const result = (status = 0, stdout = "") => ({ status, stdout, stderr: "" });
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const nativeCall = (call: unknown[]) => normalizeNativeRuntimeCall(call) as [string, string[], SpawnSyncOptions];
const nativeCalls = () => native.spawn.mock.calls.map(nativeCall);
const inFixtureScope = (operation: () => void) => runtimeFacade.runWithNativeRuntimeInvocation(runtimeFacade.getRuntimeInvocation(), operation);
const prepare = () => inFixtureScope(() => prepareWindowsCredentialAccess("docker", target, directory));
const repair = () => inFixtureScope(() => repairWindowsCodexPrivateState("docker", target));

// Windows control flow and path semantics are modeled; every native leaf stays mocked.
describe("Windows credential access repair with modeled Windows bindings", () => {
    beforeEach(() => {
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        preloadNativeRuntimeFixture(runtimeFacade, { runtime: "docker", dockerDesktop: true });
        native.spawn.mockReset();
        native.stat.mockReset().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false });
        native.spawn.mockImplementation((...rawCall) => {
            const [command, args] = nativeCall(rawCall);
            if (command === "trusted-powershell.exe") return result();
            if (args.includes("ccc-credential-probe")) return result(1);
            if (args[0] === "inspect") return result(0, JSON.stringify([{ Destination: directory, Source: "C:\\Users\\fixture\\.claude", Type: "bind", RW: true }]));
            if (args.at(-1) === "id -u; id -G") return result(0, "1000\n1000 1001\n");
            return result();
        });
    });
    afterEach(() => {
        try { nativeCalls(); }
        finally {
            Object.defineProperty(process, "platform", platform);
            runtimeFacade._resetRuntimeCacheForTest();
            vi.restoreAllMocks();
        }
    });

    it("returns immediately when the default user can access credentials", () => {
        native.spawn.mockReturnValue(result());
        prepare();
        expect(native.spawn).toHaveBeenCalledTimes(1);
        expect(native.stat).not.toHaveBeenCalled();
    });

    it("checks Windows ownership before granting permissions to the default exec user", () => {
        prepare();
        const calls = nativeCalls();
        const owner = calls.findIndex(([command]) => command === "trusted-powershell.exe");
        const grant = calls.findIndex(([, args]) => args.includes("/usr/bin/python3"));
        expect(owner).toBeGreaterThan(0);
        expect(grant).toBeGreaterThan(owner);
        expect(calls[owner][2].env?.CCC_CREDENTIAL_ACCESS_SOURCE).toBe("C:\\Users\\fixture\\.claude");
        expect(calls[grant][1].slice(-3)).toEqual(["1000", directory, "1000 1001"]);
        expect(calls[grant][2].input).toContain("os.O_NOFOLLOW");
        expect(calls[grant][2].input).not.toContain("os.chown");
    });

    it.each(["foreign Windows owner", "linked source", "readonly bind", "unknown container user"])("refuses repair for %s", fault => {
        const original = native.spawn.getMockImplementation()!;
        native.spawn.mockImplementation((command: string, rawArgs: string[], options: unknown) => {
            const [, args] = nativeCall([command, rawArgs, options]);
            if (fault === "foreign Windows owner" && command === "trusted-powershell.exe") return result(1);
            if (fault === "readonly bind" && args[0] === "inspect") return result(0, JSON.stringify([{ Destination: directory, Source: "C:\\Users\\fixture\\.claude", Type: "bind", RW: false }]));
            if (fault === "unknown container user" && args.at(-1) === "id -u; id -G") return result(0, "invalid\n1000\n");
            return original(command, rawArgs, options);
        });
        if (fault === "linked source") native.stat.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => true });
        expect(prepare).toThrow();
        expect(nativeCalls().some(([, args]) => args.includes("/usr/bin/python3"))).toBe(false);
    });

    it("propagates grant failure instead of reporting repaired access", () => {
        const original = native.spawn.getMockImplementation()!;
        native.spawn.mockImplementation((command: string, args: string[], options: unknown) => nativeCall([command, args, options])[1].includes("/usr/bin/python3") ? result(1) : original(command, args, options));
        expect(prepare).toThrow("access grant failed");
        expect(nativeCalls().some(([, args]) => args.includes("ccc-credential-verify"))).toBe(false);
    });

    it.each(["same user", "other user", "inspection failure", "linked private directory"])("qualifies private state repair against %s", fault => {
        native.spawn.mockImplementation((...rawCall) => {
            const [command, args] = nativeCall(rawCall);
            if (command === "trusted-powershell.exe") return result();
            if (args.includes("-c") && args[2] === "python3") return result(1);
            if (args[0] === "inspect" && args.includes("{{json .Mounts}}")) return result(0, JSON.stringify([{ Destination: "/home/ccc/.codex", Source: "C:\\Users\\fixture\\.codex", Type: "bind", RW: true }]));
            if (args.at(-1) === "id -u; id -g") return result(0, "1000\n1000\n");
            if (args[0] === "ps") return result(0, "active-container\n");
            if (args[0] === "inspect") return fault === "inspection failure" ? result(1) : result(0, JSON.stringify([{ Id: "active-container", Mounts: [{ Type: "bind", Source: "/run/desktop/mnt/host/c/Users/fixture/.codex", Destination: "/home/ccc/.codex" }] }]));
            if (args[1] === "active-container") return result(0, fault === "other user" ? "1001\n" : "1000\n");
            return result();
        });
        if (fault === "linked private directory") native.stat.mockImplementation((path: string) => ({ isDirectory: () => true, isSymbolicLink: () => path.endsWith("app-server-control") }));
        if (fault === "same user") {
            expect(repair).not.toThrow();
            const activeUser = nativeCalls().findIndex(([, args]) => args[1] === "active-container");
            const repairIndex = nativeCalls().findIndex(([, args]) => args.includes("-i"));
            expect(repairIndex).toBeGreaterThan(activeUser);
            expect(nativeCalls()[repairIndex][1].slice(-2)).toEqual(["1000", "1000"]);
        } else {
            expect(repair).toThrow();
            expect(nativeCalls().some(([, args]) => args.includes("-i"))).toBe(false);
        }
    });

    it.each(["live peer", "disconnected link", "other running server", "unknown link"])("handles the control socket with a %s", state => {
        native.spawn.mockImplementation((...rawCall) => {
            const [command, args] = nativeCall(rawCall);
            if (command === "trusted-powershell.exe") return result();
            if (args.at(-1) === "probe") return result(state === "live peer" ? 0 : state === "unknown link" ? 1 : 10);
            if (args.at(-1) === "repair") return result();
            if (args[0] === "inspect" && args.includes("{{json .Mounts}}")) return result(0, JSON.stringify([{ Destination: "/home/ccc/.codex", Source: "C:\\Users\\fixture\\.codex", Type: "bind", RW: true }]));
            if (args[0] === "ps") return result(0, "other-container\n");
            if (args[0] === "inspect") return result(0, JSON.stringify([{ Id: "other-container", Mounts: [{ Type: "bind", Source: "/run/desktop/mnt/host/c/Users/fixture/.codex" }] }]));
            if (args.includes("other-container")) return result(state === "other running server" ? 10 : 0);
            return result();
        });
        if (state === "other running server" || state === "unknown link") {
            expect(repair).toThrow();
        } else {
            expect(repair).not.toThrow();
        }
        expect(nativeCalls().some(([, args]) => args.at(-1) === "repair")).toBe(state === "disconnected link");
        if (state === "live peer") expect(native.stat).not.toHaveBeenCalled();
    });
});
