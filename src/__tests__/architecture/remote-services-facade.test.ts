import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ spawn: vi.fn(), sync: vi.fn(), exists: vi.fn(), read: vi.fn(), legacy: vi.fn(() => "/legacy"), trace: [] as unknown[][] }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: native.spawn, spawnSync: native.sync }));
vi.mock("fs", async original => { const actual = await original<typeof import("node:fs")>(); return { ...actual, existsSync: native.exists, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => String(args[0]).endsWith("package.json") ? actual.readFileSync(...args) : native.read(...args) }; });
vi.mock("../../home-layout.js", async original => ({ ...await original<typeof import("../../home-layout.js")>(), legacyRemoteConfigDir: native.legacy }));
import { createNativeRemoteServicesPorts } from "../../adapters/remote-services.js";
import * as publicRemote from "../../remote.js";

beforeEach(() => { vi.clearAllMocks(); native.trace = []; });
afterEach(() => { vi.restoreAllMocks(); });
describe("cohesive remote native bindings", () => {
    it("retains raw results, target/body evaluation order and exact SSH options", () => {
        const ports = createNativeRemoteServicesPorts(); const raw = { status: 0, stdout: "raw" }; native.sync.mockReturnValue(raw);
        const config = { get user() { native.trace.push(["user"]); return "user"; }, get host() { native.trace.push(["host"]); return "host"; }, remotePath: "" };
        const body = () => { native.trace.push(["body"]); return "body"; };
        expect(ports.runReservation(config, body)).toBe(raw); expect(native.trace).toEqual([["user"], ["host"], ["body"]]);
        expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", "body"], { encoding: "utf-8", timeout: 60000 });
        ports.runRefresh(config, body); expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", "body"], { encoding: "utf-8", timeout: 10000 });
        ports.runRelease(config, body); expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", "body"], { encoding: "utf-8", timeout: 10000 });
        ports.runStop(config, body); expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", "body"], { encoding: "utf-8", timeout: 60000 });
    });
    it("captures display callee before message getters and retains console receiver", () => {
        const descriptor = Object.getOwnPropertyDescriptor(console, "log")!; const trace: unknown[] = [];
        try {
            Object.defineProperty(console, "log", { configurable: true, get() { trace.push("capture"); return function (this: unknown, message: string) { trace.push(this === console, message); }; } });
            const payload = { get value() { trace.push("argument"); return "value"; } };
            createNativeRemoteServicesPorts().captureLog()(`key=${payload.value}`);
        } finally { Object.defineProperty(console, "log", descriptor); }
        expect(trace).toEqual(["capture", "argument", true, "key=value"]);
    });
    it("keeps tool/ping/Mutagen raw probe and ignored-result commands distinct", () => {
        const ports = createNativeRemoteServicesPorts(); native.sync.mockReturnValue({ status: 1, error: Error("returned") });
        ports.observeTool("mutagen"); expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["version"], { encoding: "utf-8" });
        ports.observeHostReachability("host"); expect(native.sync).toHaveBeenLastCalledWith("ping", ["-c", "1", "-W", "1", "host"], { encoding: "utf-8" });
        ports.startSyncDaemon(); expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["daemon", "start"], { stdio: "ignore" });
        ports.pauseSync("sync"); expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "pause", "sync"], { stdio: "inherit" });
    });
    it("binds legacy path once and retains existing read encoding", () => {
        const reader = createNativeRemoteServicesPorts().captureLegacyConfigReader("hash"); native.exists.mockReturnValue(true); native.read.mockReturnValue("{}");
        expect(reader.exists()).toBe(true); expect(reader.readText()).toBe("{}"); expect(native.legacy).toHaveBeenCalledTimes(1); expect(native.exists).toHaveBeenCalledWith("/legacy/hash.json"); expect(native.read).toHaveBeenCalledWith("/legacy/hash.json", "utf-8");
    });
    it("preserves actual async facade functions and all native asset public names", () => {
        for (const operation of [publicRemote.remoteExec, publicRemote.remoteSetup, publicRemote.remoteCheck, publicRemote.remoteTerminate]) expect(operation.constructor.name).toBe("AsyncFunction");
        for (const name of ["remoteLifecycleShell", "remoteSessionReservationShell", "remoteRefreshSessionShell", "remoteReleaseSessionShell", "remoteStopShell", "remoteClaudeDirScript", "remoteContainerStartScript"] as const) expect(publicRemote[name]).toBeTypeOf("function");
        expect(publicRemote.shellEscapeArg("a'b")).toBe("'a'\\''b'");
    });
});
