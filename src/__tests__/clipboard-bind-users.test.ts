import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clipboardPortMayHaveBindUsers } from "../clipboard-bind-users.js";
import { validateNativeRuntimeInvocation } from "../adapters/container-runtime-invocation.js";
import { beginRuntimeBindCreation, prepareRuntimeBindHome, recordRuntimeBindAuthority, withRuntimeBindGuard } from "../adapters/runtime-bind-authority.js";
import { NATIVE_RUNTIME_SELECTOR_KEYS } from "../ports/container-runtime-invocation.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import type { RuntimeBindGuard, RuntimeBindHomePreparation } from "../ports/runtime-bind-authority.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), current: undefined as NativeRuntimeInvocation | undefined, captureFails: false }));
vi.mock("../container-runtime.js", () => ({
    peekRuntimeInvocation: () => {
        if (mocks.captureFails) return undefined;
        return mocks.current;
    },
    // Keep native routing isolated in this owner; integration uses the real binder.
    bindNativeRuntimeInvocation: (invocation: NativeRuntimeInvocation) => ({ invocation,
        spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => mocks.spawn(invocation, args, options),
    }),
}));

let fixture: string, root: string, port: string, home: RuntimeBindHomePreparation;
const id = "a".repeat(64), otherId = "b".repeat(64);
const result = (stdout: string, status = 0) => ({ stdout, status });
function invocation(host = "unix:///fixture/current.sock") {
    return validateNativeRuntimeInvocation({ version: 1, runtime: "docker", executable: "/fixture/runtime/docker",
        transport: { kind: "docker", host, configDirectory: "/fixture/config",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
}
function inspect(source: string, running = true) {
    return JSON.stringify([{ Id: id, State: { Running: running }, Mounts: [{ Type: "bind", Source: source, Destination: "/run/ccc/clipboard.port" }] }]);
}
function mounts(source: string, running = true) {
    mocks.spawn.mockReturnValueOnce(result(id)).mockReturnValueOnce(result(inspect(source, running)));
}
function query(operation: (guard: RuntimeBindGuard) => boolean = guard => clipboardPortMayHaveBindUsers(port, guard)) {
    return withRuntimeBindGuard(home, operation);
}
beforeEach(() => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), "ccc-clipboard-users-")));
    chmodSync(fixture, 0o700);
    root = join(fixture, "home");
    home = prepareRuntimeBindHome(root);
    withRuntimeBindGuard(home, () => {});
    port = join(root, "clipboard.port");
    writeFileSync(port, "123:token", { mode: 0o600 });
    mocks.spawn.mockReset();
    mocks.current = invocation();
    mocks.captureFails = false;
});
afterEach(() => { vi.restoreAllMocks(); rmSync(fixture, { recursive: true, force: true }); });

describe("clipboard bind users under complete retained runtime authority", () => {
    it("includes running background containers without requiring session records or labels", () => {
        mounts(port);
        expect(query()).toBe(true);
        expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(["ps", "-aq", "--no-trunc"]);
    });
    it("includes stopped containers retaining the port bind", () => { mounts(port, false); expect(query()).toBe(true); });
    it("detects ancestor bind mounts", () => { mounts(root); expect(query()).toBe(true); });
    it("permits upgrade only when complete history and current runtime both prove no containers", () => {
        mocks.spawn.mockReturnValue(result(""));
        expect(query()).toBe(false);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });
    it("permits unrelated resolved mounts without lexical prefix false positives", () => {
        const unrelated = join(root, "clipboard.port-other"); mkdirSync(unrelated);
        mounts(unrelated); expect(query()).toBe(false);
    });
    it("does not turn an unqualified or expired guard into absence permission", () => {
        mocks.spawn.mockReturnValue(result(""));
        expect(clipboardPortMayHaveBindUsers(port)).toBe(true);
        let expired!: RuntimeBindGuard;
        withRuntimeBindGuard(home, guard => { expired = guard; });
        expect(clipboardPortMayHaveBindUsers(port, expired)).toBe(true);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it("inspects retained A even when the selected runtime B is empty", () => {
        const retained = invocation("unix:///fixture/retained-a.sock");
        withRuntimeBindGuard(home, guard => recordRuntimeBindAuthority(guard, retained));
        mocks.spawn.mockImplementation((captured: NativeRuntimeInvocation, args: readonly string[]) => {
            if (captured.transport.kind !== "docker" || captured.transport.host !== "unix:///fixture/retained-a.sock") return result("");
            return result(args[0] === "ps" ? id : inspect(port, false));
        });
        expect(query()).toBe(true);
        expect(mocks.spawn.mock.calls.some(([captured, args]) => captured.transport.host === "unix:///fixture/retained-a.sock" && args[0] === "inspect")).toBe(true);
    });
    it("treats unavailable retained authority as unknown rather than discarding it", () => {
        withRuntimeBindGuard(home, guard => recordRuntimeBindAuthority(guard, invocation("unix:///fixture/unavailable-a.sock")));
        mocks.spawn.mockImplementation((captured: NativeRuntimeInvocation) => captured.transport.kind === "docker"
            && captured.transport.host === "unix:///fixture/unavailable-a.sock" ? result("", 1) : result(""));
        expect(query()).toBe(true);
    });
    it("requires every retained authority to be empty for a positive clear", () => {
        withRuntimeBindGuard(home, guard => recordRuntimeBindAuthority(guard, invocation("unix:///fixture/a.sock")));
        mocks.spawn.mockReturnValue(result(""));
        expect(query()).toBe(false);
        expect(new Set(mocks.spawn.mock.calls.map(([captured]) => captured.transport.host))).toEqual(new Set([
            "unix:///fixture/a.sock", "unix:///fixture/current.sock",
        ]));
    });
    it.each(["pending", "incomplete"] as const)("does not scan past %s history to infer absence", state => {
        withRuntimeBindGuard(home, guard => {
            if (state === "pending") beginRuntimeBindCreation(guard, invocation());
            else writeFileSync(join(root, "runtime-bind-authority", "receiving-host-incomplete"), "", { flag: "wx", mode: 0o600 });
        });
        mocks.spawn.mockReturnValue(result(""));
        expect(query()).toBe(true);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it("rechecks history identity after native inventory instead of trusting an earlier complete snapshot", () => {
        const history = join(root, "runtime-bind-authority", "history.json");
        const bytes = readFileSync(history);
        mocks.spawn.mockImplementation(() => {
            renameSync(history, `${history}.old`);
            writeFileSync(history, bytes, { flag: "wx", mode: 0o600 });
            return result("");
        });
        expect(query()).toBe(true);
    });
    it("rechecks the home root identity after native inventory", () => {
        mocks.spawn.mockImplementation(() => {
            renameSync(root, join(fixture, "old-home"));
            mkdirSync(root, { mode: 0o700 });
            writeFileSync(port, "successor", { mode: 0o600 });
            return result("");
        });
        let blocked = false;
        try { query(guard => { blocked = clipboardPortMayHaveBindUsers(port, guard); return blocked; }); }
        catch { /* Displacing the root may also prevent release of its exact claim. */ }
        expect(blocked).toBe(true);
        expect(readFileSync(port, "utf8")).toBe("successor");
    });
    it("defers opaque or inaccessible runtime sources without guessing translations", () => {
        mounts("/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/opaque");
        expect(query()).toBe(true);
    });
    it.each([result("", 1), result("bad-id"), result(`${id}\n${id}`), { status: null, error: new Error("unavailable") }])("defers failed listing %j", value => {
        mocks.spawn.mockReturnValue(value); expect(query()).toBe(true);
    });
    it("does not interpret an over-budget native listing as an empty inventory", () => {
        mocks.spawn.mockReturnValue(result(" ".repeat(4 * 1024 * 1024 + 1)));
        expect(query()).toBe(true);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });
    it.each([
        "[]", "invalid", JSON.stringify([{ Id: id, State: { Running: true } }]),
        JSON.stringify([{ Id: id, State: {}, Mounts: [] }]),
        JSON.stringify([{ Id: otherId, State: { Running: false }, Mounts: [] }]),
        JSON.stringify([{ Id: id, State: { Running: false }, Mounts: [] }, { Id: otherId, State: { Running: false }, Mounts: [] }]),
    ])("defers incomplete or nonexact inspection %s", value => {
        mocks.spawn.mockReturnValueOnce(result(id)).mockReturnValueOnce(result(value));
        expect(query()).toBe(true);
    });
    it("defers a missing captured current runtime even with complete empty retained history", () => {
        mocks.captureFails = true; expect(query()).toBe(true); expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it("spends one total deadline across retained authorities instead of resetting each native timeout", () => {
        withRuntimeBindGuard(home, guard => recordRuntimeBindAuthority(guard, invocation("unix:///fixture/a.sock")));
        let elapsed = 100;
        const timeouts: number[] = [];
        withRuntimeBindGuard(home, guard => {
            vi.spyOn(performance, "now").mockImplementation(() => elapsed);
            mocks.spawn.mockImplementation((_captured: NativeRuntimeInvocation, _args: readonly string[], options: { timeout: number }) => {
                timeouts.push(options.timeout);
                elapsed += 6000;
                return result("");
            });
            expect(clipboardPortMayHaveBindUsers(port, guard)).toBe(true);
        });
        expect(timeouts).toHaveLength(2);
        expect(timeouts[0]).toBeGreaterThan(0);
        expect(timeouts[0]).toBeLessThanOrEqual(10_000);
        expect(timeouts[1]).toBeLessThanOrEqual(4000);
    });
    it("does not dispatch inspect once listing has exhausted the total deadline", () => {
        let elapsed = 100;
        withRuntimeBindGuard(home, guard => {
            vi.spyOn(performance, "now").mockImplementation(() => elapsed);
            mocks.spawn.mockImplementation(() => { elapsed += 10_001; return result(id); });
            expect(clipboardPortMayHaveBindUsers(port, guard)).toBe(true);
        });
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(mocks.spawn.mock.calls[0]?.[1][0]).toBe("ps");
    });
});
