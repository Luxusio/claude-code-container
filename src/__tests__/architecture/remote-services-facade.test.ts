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

    it("keeps tool/ping/Mutagen raw probe and ignored-result commands distinct", () => {
        const ports = createNativeRemoteServicesPorts(); native.sync.mockReturnValue({ status: 1, error: Error("returned") });
        ports.observeTool("mutagen"); expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["version"], { encoding: "utf-8" });
        ports.observeHostReachability("host"); expect(native.sync).toHaveBeenLastCalledWith("ping", ["-c", "1", "-W", "1", "host"], { encoding: "utf-8" });
        ports.startSyncDaemon(); expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["daemon", "start"], { stdio: "ignore" });
        ports.pauseSync("sync"); expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "pause", "sync"], { stdio: "inherit" });
    });

    it("preserves actual async facade functions and all native asset public names", () => {
        for (const operation of [publicRemote.remoteExec, publicRemote.remoteSetup, publicRemote.remoteCheck, publicRemote.remoteTerminate]) expect(operation.constructor.name).toBe("AsyncFunction");
        for (const name of ["remoteLifecycleShell", "remoteSessionReservationShell", "remoteRefreshSessionShell", "remoteReleaseSessionShell", "remoteStopShell", "remoteClaudeDirScript", "remoteContainerStartScript"] as const) expect(publicRemote[name]).toBeTypeOf("function");
        expect(publicRemote.shellEscapeArg("a'b")).toBe("'a'\\''b'");
    });
});
