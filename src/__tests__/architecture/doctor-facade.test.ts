import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
    calls: [] as unknown[][], denied: 0, daemon: true, running: true,
    version: "27\n", volumeStatus: 0, launcherStatus: 0, launcherText: "Claude\n",
    fallbackVersion: "fallback" as string | null, spawnError: null as Error | null,
}));
const record = (name: string, ...args: unknown[]) => { native.calls.push([name, ...args]); };
const deny = (name: string): never => { native.denied++; throw new Error(`DENIED ${name}`); };
vi.mock("child_process", () => ({ spawnSync: (command: string, args: string[], options: unknown) => {
    record("spawn", command, args, options);
    if (native.spawnError) throw native.spawnError;
    if (args[0] === "version") return { stdout: native.version, status: 9 };
    if (args[0] === "volume") return { status: native.volumeStatus };
    if (args[0] === "exec") return { status: native.launcherStatus, stdout: native.launcherText };
    return deny("unexpected subprocess");
} }));
vi.mock("fs", () => ({ existsSync: (path: string) => { record("exists", path); return false; },
    readdirSync: () => deny("unexpected readdir") }));
vi.mock("../../docker.js", () => ({
    getContainerName: (path: string) => { record("name", path); return "container"; },
    isDockerRunning: () => { record("daemon"); return native.daemon; },
    isImageExists: () => { record("image"); return true; },
    getImageLabel: (...args: unknown[]) => { record("label", ...args); return null; },
    isContainerRunning: (...args: unknown[]) => { record("running", ...args); return native.running; },
    isContainerExists: (...args: unknown[]) => { record("containerExists", ...args); return false; },
}));
vi.mock("../../utils.js", () => ({ getProjectId: (path: string) => { record("project", path); return "project"; }, CLI_VERSION: "1" }));
vi.mock("../../home-layout.js", () => ({ locksDir: () => { record("locksDir"); return "/locks"; } }));
vi.mock("../../session.js", () => ({ observeActiveSessionsForContainer: (...args: unknown[]) => { record("sessions", ...args); return []; },
    getActiveSessionsForContainer: () => deny("pruning"), removeSessionLock: () => deny("remove claim") }));
vi.mock("../../container-runtime.js", () => ({ getRuntimeInfo: () => { record("runtime"); return { runtime: "docker", version: native.fallbackVersion, flavor: "native" }; },
    runtimeCli: () => { record("cli"); return "docker"; } }));
vi.mock("../../container-identity.js", () => ({ resolveContainerIdentity: () => { record("identity"); return { uid: 1 }; },
    getIdentityMiseVolumeName: (identity: unknown) => { record("volumeName", identity); return "cache"; } }));
vi.mock("../../container-setup.js", () => ({ CLAUDE_BIN_PATH: "/bin/claude",
    buildClaudeLauncherReportCommand: (path: string) => { record("launcher", path); return "fixed report"; },
    sanitizeForTerminal: (text: string) => { record("sanitize", text);
        return text.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "?"); },
}));
const { runDoctor } = await import("../../doctor.js");
beforeEach(() => {
    native.calls = []; native.denied = 0; native.daemon = true; native.running = true;
    native.version = "27\n"; native.volumeStatus = 0; native.launcherStatus = 0;
    native.launcherText = "Claude\n"; native.fallbackVersion = "fallback"; native.spawnError = null;
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("trusted doctor facade", () => {
    it("uses fixed native commands with the launcher timeout and inherited cwd", () => {
        expect(runDoctor("/project")).toBe(true);
        expect(native.denied).toBe(0);
        expect(native.calls.filter(call => call[0] === "spawn")).toEqual([
            ["spawn", "docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf-8" }],
            ["spawn", "docker", ["volume", "inspect", "cache", "--format", "{{.Mountpoint}}"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }],
            ["spawn", "docker", ["exec", "container", "sh", "-c", "fixed report"], { encoding: "utf-8", timeout: 10000 }],
        ]);
        expect(native.calls.filter(call => call[0] === "running")).toHaveLength(2);
    });
    it.each([[" 27\n", "fallback", "27"], [" \n", "fallback", "fallback"], ["", null, "unknown"]] as const)(
        "renders useful nonzero-status version stdout or its fallback (%s)", (stdout, fallback, expected) => {
            native.version = stdout; native.fallbackVersion = fallback;
            expect(runDoctor("/project")).toBe(true);
            expect(console.log).toHaveBeenCalledWith(`  ✓ Runtime: Docker running (v${expected}, native)`);
        });
    it.each([[0, " ready \n", "  ✓ Claude: ready"], [2, " unmanaged \n", "  ! Claude: unmanaged"],
        [0, " \n", "  ! Claude: Not installed in container"], [2, "", "  ! Claude: Not installed in container"],
        [1, "ignored", "  ! Claude: Not installed in container"]])(
        "interprets launcher status %s and stdout %s", (status, stdout, row) => {
            native.launcherStatus = status as number; native.launcherText = stdout as string;
            expect(runDoctor("/project")).toBe(true);
            expect(console.log).toHaveBeenCalledWith(row);
        });
    it("prints ordered checks and a successful summary", () => {
        expect(runDoctor("/project")).toBe(true);
        expect(vi.mocked(console.log).mock.calls.map(call => call[0])).toEqual([
            "\n=== CCC Doctor ===\n", "  ✓ Runtime: Docker running (v27, native)",
            "  ✓ Image: Built locally (dev)", "  ✓ Container: Running (container)",
            "  ✓ Mise cache: Volume 'cache' exists", "  ✓ Sessions: No active sessions",
            "  ✓ Claude: Claude", "", "Summary: All checks passed", "",
        ]);
    });
    it("returns false for an absent daemon without downstream native probes", () => {
        native.daemon = false;
        expect(runDoctor("/project")).toBe(false);
        expect(native.calls.some(call => call[0] === "spawn" || call[0] === "image" || call[0] === "sessions")).toBe(false);
        expect(console.log).toHaveBeenCalledWith("Summary: 1 error(s), 0 warning(s)");
    });
    it("propagates unexpected subprocess exceptions", () => {
        native.spawnError = new Error("native failure");
        expect(() => runDoctor("/project")).toThrow(native.spawnError);
    });
    it("sanitizes terminal control and bidi bytes at publication", () => {
        native.launcherStatus = 2; native.launcherText = "unmanaged\u001b[2K\u200fX";
        expect(runDoctor("/project")).toBe(true);
        expect(console.log).toHaveBeenCalledWith("  ! Claude: unmanaged?[2K?X");
        expect(console.log).toHaveBeenCalledWith("Summary: OK with 1 warning(s)");
    });
});
