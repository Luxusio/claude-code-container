import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clipboardPortMayHaveBindUsers } from "../clipboard-bind-users.js";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("../container-runtime.js", () => ({ runtimeCli: () => "docker" }));
let root: string, port: string;
const id = "a".repeat(64);
const result = (stdout: string, status = 0) => ({ stdout, status });
function mounts(source: string, running = true) {
    mocks.spawn.mockReturnValueOnce(result(id)).mockReturnValueOnce(result(JSON.stringify([{ Id: id, State: { Running: running }, Mounts: [{ Type: "bind", Source: source, Destination: "/run/ccc/clipboard.port" }] }])));
}
beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-clipboard-users-")));
    port = join(root, "clipboard.port");
    writeFileSync(port, "123:token");
    mocks.spawn.mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("clipboard bind users", () => {
    it("includes running background containers without requiring session records or labels", () => {
        mounts(port);
        expect(clipboardPortMayHaveBindUsers(port)).toBe(true);
        expect(mocks.spawn.mock.calls[0][1]).toEqual(["ps", "-q", "--no-trunc"]);
    });
    it("detects ancestor bind mounts", () => { mounts(root); expect(clipboardPortMayHaveBindUsers(port)).toBe(true); });
    it("permits upgrade when no running containers exist", () => {
        mocks.spawn.mockReturnValue(result(""));
        expect(clipboardPortMayHaveBindUsers(port)).toBe(false);
    });
    it("permits a container observed stopped before inspection", () => {
        mounts(port, false); expect(clipboardPortMayHaveBindUsers(port)).toBe(false);
    });
    it("permits unrelated resolved mounts", () => {
        const unrelated = join(root, "unrelated"); mkdirSync(unrelated);
        mounts(unrelated); expect(clipboardPortMayHaveBindUsers(port)).toBe(false);
    });
    it("defers opaque or inaccessible runtime sources without guessing translations", () => {
        mounts("/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/opaque");
        expect(clipboardPortMayHaveBindUsers(port)).toBe(true);
    });
    it.each([result("", 1), result("bad-id"), { status: null, error: new Error("unavailable") }])("defers failed listing %j", value => {
        mocks.spawn.mockReturnValue(value); expect(clipboardPortMayHaveBindUsers(port)).toBe(true);
    });
    it.each(["[]", "invalid", JSON.stringify([{ Id: id, State: { Running: true } }]), JSON.stringify([{ Id: id, State: {}, Mounts: [] }])])("defers incomplete inspection %s", value => {
        mocks.spawn.mockReturnValueOnce(result(id)).mockReturnValueOnce(result(value));
        expect(clipboardPortMayHaveBindUsers(port)).toBe(true);
    });
});
