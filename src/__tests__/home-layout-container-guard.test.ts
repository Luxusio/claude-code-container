import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hasLegacyHomeLayoutContainerMounts } from "../home-layout-container-guard.js";
import { prepareRuntimeBindHome, withRuntimeBindGuard } from "../adapters/runtime-bind-authority.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import type { RuntimeBindHomePreparation } from "../ports/runtime-bind-authority.js";
import { fileSymlinkOrSkip } from "./helpers/file-symlink-fixture.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), capture: vi.fn(), home: "" }));
vi.mock("../container-runtime.js", async () => {
    const { validateNativeRuntimeInvocation } = await import("../adapters/container-runtime-invocation.js");
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../ports/container-runtime-invocation.js");
    const invocation = validateNativeRuntimeInvocation({
        version: 1, runtime: "docker", executable: "/fixture/runtime/docker",
        transport: { kind: "docker", host: "unix:///fixture/engine.sock", configDirectory: "/fixture/config",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    return {
        peekRuntimeInvocation: () => { mocks.capture(); return invocation; },
        bindNativeRuntimeInvocation: (captured: NativeRuntimeInvocation) => ({ invocation: captured,
            spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => mocks.spawn(captured, args, options),
        }),
    };
});
vi.mock("../home-layout.js", () => ({ cccHome: () => mocks.home, DEFAULT_PROFILE_MARKER: ".ccc-default-profile" }));
const id = "a".repeat(64), otherId = "b".repeat(64);
let root: string, home: RuntimeBindHomePreparation;
const result = (stdout: string, status = 0) => ({ stdout, status });
function inspect(mounts: unknown, extra = {}) {
    mocks.spawn.mockReturnValueOnce(result(`${id}\n`)).mockReturnValueOnce(result(JSON.stringify([{ Id: id, Mounts: mounts, State: { Running: false }, ...extra }])));
}
function bind(source: string, destination = "/home/ccc/.codex") {
    return { Type: "bind", Source: source, Destination: destination };
}
const query = () => withRuntimeBindGuard(home, guard => hasLegacyHomeLayoutContainerMounts(guard));
beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-mount-guard-")));
    chmodSync(root, 0o700);
    mocks.home = join(root, ".ccc");
    home = prepareRuntimeBindHome(mocks.home);
    withRuntimeBindGuard(home, () => {});
    mkdirSync(join(mocks.home, "codex"), { mode: 0o700 });
    mocks.spawn.mockReset();
    mocks.capture.mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("legacy layout container mount guard with qualified complete history", () => {
    it("includes stopped containers with exact retained credential mounts", () => {
        inspect([bind(join(mocks.home, "codex"))]);
        expect(query()).toBe(true);
        expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(["ps", "-aq", "--no-trunc"]);
    });
    it.each(["ancestor", "descendant", "clipboard"])("retains %s overlaps", kind => {
        let source = mocks.home;
        if (kind === "descendant") {
            source = join(mocks.home, "codex", "sessions");
            mkdirSync(source);
        }
        if (kind === "clipboard") {
            source = join(mocks.home, "clipboard.port");
            writeFileSync(source, "123:token", { mode: 0o600 });
        }
        inspect([bind(source, "/arbitrary")]);
        expect(query()).toBe(true);
    });
    it("allows unrelated resolved sources without prefix false positives", () => {
        const other = join(mocks.home, "codex-other");
        mkdirSync(other);
        inspect([bind(other), { Type: "volume", Source: "/var/lib/docker/volumes/cache", Destination: "/cache" }]);
        expect(query()).toBe(false);
    });
    it("allows migration when complete authority inventory proves there are no containers", () => {
        mocks.spawn.mockReturnValue(result(""));
        expect(query()).toBe(false);
    });
    it("does not probe runtime if no legacy data is pending", () => {
        rmSync(join(mocks.home, "codex"), { recursive: true });
        expect(query()).toBe(false);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it("refuses unqualified absence permission even when the selected engine is empty", () => {
        mocks.spawn.mockReturnValue(result(""));
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it("derives migration scope from the qualified root rather than a mutable home selector", () => {
        withRuntimeBindGuard(home, guard => {
            const protectedHome = mocks.home;
            mocks.home = join(root, "unrelated-home");
            mkdirSync(mocks.home);
            inspect([bind(join(protectedHome, "codex"))]);
            expect(hasLegacyHomeLayoutContainerMounts(guard)).toBe(true);
        });
    });
    it("retains an unmarked default profile which migration would rename", () => {
        const profile = join(mocks.home, "profiles", "default");
        mkdirSync(profile, { recursive: true });
        inspect([bind(profile)]);
        expect(query()).toBe(true);
    });
    it("defers opaque Docker Desktop credential source aliases", () => {
        inspect([bind("/run/desktop/mnt/host/wsl/opaque/codex")]);
        expect(query()).toBe(true);
    });
    it("refuses symlink mount sources without following aliases", context => {
        const target = join(root, "unrelated");
        mkdirSync(target);
        const alias = join(root, "alias");
        fileSymlinkOrSkip(context, target, alias);
        inspect([bind(alias)]);
        expect(query()).toBe(true);
    });
    it.each([
        { status: 1, stdout: "" }, { status: 0, stdout: "not-an-id" }, { status: null, error: new Error("timeout") },
        { status: 0, stdout: `${id}\n${id}` },
    ])("defers when listing is unavailable or malformed: %j", listed => {
        mocks.spawn.mockReturnValue(listed);
        expect(query()).toBe(true);
    });
    it.each([
        "invalid-json", "{}", "[]", JSON.stringify([{ Id: id }]),
        JSON.stringify([{ Id: otherId, State: { Running: false }, Mounts: [] }]),
        JSON.stringify([{ Id: id, State: { Running: false }, Mounts: [] }, { Id: otherId, State: { Running: false }, Mounts: [] }]),
    ])("defers incomplete or nonexact inspection %s", payload => {
        mocks.spawn.mockReturnValueOnce(result(id)).mockReturnValueOnce(result(payload));
        expect(query()).toBe(true);
    });
    it.each([null, {}, [{ Type: "bind", Destination: "/home/ccc/.codex" }], [{ Type: "unknown", Destination: "/x" }]])("defers malformed mount metadata %j", mounts => {
        inspect(mounts);
        expect(query()).toBe(true);
    });
    it("rejects repeated inspection IDs even when the array length matches", () => {
        mocks.spawn.mockReturnValueOnce(result(`${id}\n${otherId}`)).mockReturnValueOnce(result(JSON.stringify([
            { Id: id, State: { Running: false }, Mounts: [] }, { Id: id, State: { Running: false }, Mounts: [] },
        ])));
        expect(query()).toBe(true);
    });
    it("requires valid stopped/running state even for containers without mounts", () => {
        inspect([], { State: { Running: "false" } });
        expect(query()).toBe(true);
    });
    it("defers runtime detection and inspect failures", () => {
        mocks.capture.mockImplementationOnce(() => { throw new Error("unavailable"); });
        expect(query()).toBe(true);
        mocks.spawn.mockReturnValueOnce(result(id)).mockReturnValueOnce(result("", 1));
        expect(query()).toBe(true);
    });
});
