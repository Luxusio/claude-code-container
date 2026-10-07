import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hasLegacyHomeLayoutContainerMounts } from "../home-layout-container-guard.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), runtime: vi.fn(() => "docker"), home: "" }));
vi.mock("child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("../container-runtime.js", () => ({ runtimeCli: mocks.runtime }));
vi.mock("../home-layout.js", () => ({ cccHome: () => mocks.home, DEFAULT_PROFILE_MARKER: ".ccc-default-profile" }));
const id = "a".repeat(64);
let root: string;
const result = (stdout: string, status = 0) => ({ stdout, status });
function inspect(mounts: unknown, extra = {}) {
    mocks.spawn.mockReturnValueOnce(result(`${id}\n`)).mockReturnValueOnce(result(JSON.stringify([{ Id: id, Mounts: mounts, State: { Running: false }, ...extra }])));
}
function bind(source: string, destination = "/home/ccc/.codex") {
    return { Type: "bind", Source: source, Destination: destination };
}
beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-mount-guard-")));
    mocks.home = join(root, ".ccc");
    mkdirSync(join(mocks.home, "codex"), { recursive: true });
    mocks.spawn.mockReset();
    mocks.runtime.mockReset().mockReturnValue("docker");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("legacy layout container mount guard", () => {
    it("includes stopped containers with exact retained credential mounts", () => {
        inspect([bind(join(mocks.home, "codex"))]);
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
        expect(mocks.spawn.mock.calls[0][1]).toEqual(["ps", "-aq", "--no-trunc"]);
    });
    it.each(["ancestor", "descendant", "clipboard"])("retains %s overlaps", kind => {
        let source = mocks.home;
        if (kind === "descendant") source = join(mocks.home, "codex", "sessions");
        if (kind === "clipboard") {
            source = join(mocks.home, "clipboard.port");
            writeFileSync(source, "123:token");
        }
        inspect([bind(source, "/arbitrary")]);
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
    });
    it("allows unrelated resolved sources without prefix false positives", () => {
        const other = join(mocks.home, "codex-other");
        mkdirSync(other);
        inspect([bind(other), { Type: "volume", Source: "/var/lib/docker/volumes/cache", Destination: "/cache" }]);
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(false);
    });
    it("allows migration when the runtime proves there are no containers", () => {
        mocks.spawn.mockReturnValue(result(""));
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(false);
    });
    it("does not probe runtime if no legacy data is pending", () => {
        rmSync(join(mocks.home, "codex"), { recursive: true });
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(false);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it("retains an unmarked default profile which migration would rename", () => {
        const profile = join(mocks.home, "profiles", "default");
        mkdirSync(profile, { recursive: true });
        inspect([bind(profile)]);
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
    });
    it("defers opaque Docker Desktop credential source aliases", () => {
        inspect([bind("/run/desktop/mnt/host/wsl/opaque/codex")]);
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
    });
    it.skipIf(process.platform === "win32")("refuses symlink mount sources without following aliases", () => {
        const target = join(root, "unrelated");
        mkdirSync(target);
        const alias = join(root, "alias");
        symlinkSync(target, alias);
        inspect([bind(alias)]);
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
    });
    it.each([
        { status: 1, stdout: "" }, { status: 0, stdout: "not-an-id" }, { status: null, error: new Error("timeout") },
        { status: 0, stdout: `${id}\n${id}` },
    ])("defers when listing is unavailable or malformed: %j", listed => {
        mocks.spawn.mockReturnValue(listed);
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
    });
    it.each(["invalid-json", "{}", "[]", JSON.stringify([{ Id: id }]), JSON.stringify([{ Id: "b".repeat(64), Mounts: [] }])])("defers incomplete inspection %s", payload => {
        mocks.spawn.mockReturnValueOnce(result(id)).mockReturnValueOnce(result(payload));
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
    });
    it.each([null, {}, [{ Type: "bind", Destination: "/home/ccc/.codex" }], [{ Type: "unknown", Destination: "/x" }]])("defers malformed mount metadata %j", mounts => {
        inspect(mounts);
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
    });
    it("defers runtime detection and inspect failures", () => {
        mocks.runtime.mockImplementationOnce(() => { throw new Error("unavailable"); });
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
        mocks.spawn.mockReturnValueOnce(result(id)).mockReturnValueOnce(result("", 1));
        expect(hasLegacyHomeLayoutContainerMounts()).toBe(true);
    });
});
