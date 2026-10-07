import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixture = vi.hoisted(() => ({ home: "", spawn: vi.fn() }));
vi.mock("os", async original => ({ ...await original<typeof import("os")>(), homedir: () => fixture.home }));
vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>(), spawnSync: fixture.spawn }));
vi.mock("../utils.js", async original => ({
    ...await original<typeof import("../utils.js")>(),
    get DATA_DIR() { return join(fixture.home, ".ccc"); },
}));
import { main } from "../index.js";
import { _resetRuntimeCacheForTest } from "../container-runtime.js";
const argv = process.argv;
const id = "a".repeat(64);

beforeEach(() => {
    fixture.home = realpathSync(mkdtempSync(join(tmpdir(), "ccc-runtime-layout-")));
    mkdirSync(join(fixture.home, ".ccc", "codex"), { recursive: true, mode: 0o700 });
    writeFileSync(join(fixture.home, ".ccc", "codex", "sentinel"), "retained-state");
    _resetRuntimeCacheForTest();
    vi.stubEnv("CCC_RUNTIME", "docker");
    vi.stubEnv("container", "");
    // Stop dispatch after the migration boundary without starting any tool.
    vi.stubEnv("CCC_PROFILE", "invalid/profile");
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("end dispatch fixture"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.spawn.mockReset().mockImplementation((runtime: string, args: string[]) => {
        if (args[0] === "--version") return { status: 0, stdout: `${runtime} version 5.0.0` };
        if (args[0] === "info") return { status: 0, stdout: "false" };
        if (args[0] === "ps") return { status: 0, stdout: runtime === "podman" ? `${id}\n` : "" };
        if (runtime === "podman" && args[0] === "inspect") return { status: 0, stdout: JSON.stringify([{
            Id: id, State: { Running: false }, Mounts: [{ Type: "bind", Source: join(fixture.home, ".ccc", "codex"), Destination: "/home/ccc/.codex" }],
        }]) };
        throw new Error(`Unexpected fixture runtime command ${runtime} ${args.join(" ")}`);
    });
});
afterEach(() => {
    process.argv = argv; _resetRuntimeCacheForTest(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(fixture.home, { recursive: true, force: true });
});

it("uses an explicit runtime's stopped-container inventory before moving legacy state", async () => {
    process.argv = [process.execPath, "ccc", "--runtime", "podman", "codex"];
    await expect(main()).rejects.toThrow("end dispatch fixture");
    expect(readFileSync(join(fixture.home, ".ccc", "codex", "sentinel"), "utf8")).toBe("retained-state");
    expect(existsSync(join(fixture.home, ".ccc", "profiles", "default", "codex"))).toBe(false);
    expect(fixture.spawn.mock.calls.filter(([, args]) => args[0] === "ps" || args[0] === "inspect")).toEqual([
        ["podman", ["ps", "-aq", "--no-trunc"], expect.any(Object)],
        ["podman", ["inspect", id], expect.any(Object)],
    ]);
});

it("allows migration when the selected default runtime has no retained containers", async () => {
    process.argv = [process.execPath, "ccc", "codex"];
    await expect(main()).rejects.toThrow("end dispatch fixture");
    expect(existsSync(join(fixture.home, ".ccc", "codex"))).toBe(false);
    expect(readFileSync(join(fixture.home, ".ccc", "profiles", "default", "codex", "sentinel"), "utf8")).toBe("retained-state");
    expect(fixture.spawn.mock.calls.map(([runtime]) => runtime)).toEqual(["docker"]);
});

it.each([{ flags: ["--runtime"] }, { flags: ["--runtime", "invalid"] }])("rejects invalid runtime arguments before layout mutation: %j", async ({ flags }) => {
    process.argv = [process.execPath, "ccc", ...flags];
    await expect(main()).rejects.toThrow("end dispatch fixture");
    expect(readFileSync(join(fixture.home, ".ccc", "codex", "sentinel"), "utf8")).toBe("retained-state");
    expect(fixture.spawn).not.toHaveBeenCalled();
});

it("keeps version informational even with runtime flags and legacy state", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [process.execPath, "ccc", "--runtime", "podman", "--version"];
    await main();
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.home, ".ccc", "codex", "sentinel"))).toBe(true);
});
