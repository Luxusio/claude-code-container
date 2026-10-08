import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
    calls: [] as unknown[][], denied: 0, daemon: true, running: true,
    version: "27\n", volumeStatus: 0, launcherStatus: 0, launcherText: "Claude\n",
    replaceLogger: false, replacement: undefined as ((text: string) => void) | undefined,
}));
const record = (name: string, ...args: unknown[]) => { native.calls.push([name, ...args]); };
const deny = (name: string): never => { native.denied++; throw new Error(`DENIED ${name}`); };
vi.mock("child_process", () => ({ spawnSync: (command: string, args: string[], options: unknown) => {
    record("spawn", command, args, options);
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
vi.mock("../../container-runtime.js", () => ({ getRuntimeInfo: () => { record("runtime"); return { runtime: "docker", version: "fallback", flavor: "native" }; },
    runtimeCli: () => { record("cli"); return "docker"; } }));
vi.mock("../../container-identity.js", () => ({ resolveContainerIdentity: () => { record("identity"); return { uid: 1 }; },
    getIdentityMiseVolumeName: (identity: unknown) => { record("volumeName", identity); return "cache"; } }));
vi.mock("../../container-setup.js", () => ({ CLAUDE_BIN_PATH: "/bin/claude",
    buildClaudeLauncherReportCommand: (path: string) => { record("launcher", path); return "fixed report"; },
    sanitizeForTerminal: (text: string) => { record("sanitize", text);
        if (native.replaceLogger && native.replacement) console.log = native.replacement;
        return text.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "?"); },
}));
const { runDoctor } = await import("../../doctor.js");
beforeEach(() => {
    native.calls = []; native.denied = 0; native.daemon = true; native.running = true;
    native.version = "27\n"; native.volumeStatus = 0; native.launcherStatus = 0;
    native.launcherText = "Claude\n"; native.replaceLogger = false; native.replacement = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("trusted doctor facade", () => {
    it("binds fixed commands, raw observations and synchronous return", () => {
        expect(runDoctor("/project")).toBe(true);
        expect(native.denied).toBe(0);
        expect(native.calls.filter(call => call[0] === "spawn")).toEqual([
            ["spawn", "docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf-8" }],
            ["spawn", "docker", ["volume", "inspect", "cache", "--format", "{{.Mountpoint}}"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }],
            ["spawn", "docker", ["exec", "container", "sh", "-c", "fixed report"], { encoding: "utf-8", timeout: 10000 }],
        ]);
        expect(native.calls.filter(call => call[0] === "running")).toHaveLength(2);
    });
    it("does not sanitize after a row logger getter throws", () => {
        const descriptor = Object.getOwnPropertyDescriptor(console, "log")!;
        let reads = 0;
        const error = new Error("row getter");
        Object.defineProperty(console, "log", { configurable: true, get() {
            if (++reads === 2) throw error;
            return function (this: unknown) { expect(this).toBe(console); };
        } });
        try {
            expect(() => runDoctor("/project")).toThrow(error);
            expect(native.calls.some(call => call[0] === "sanitize")).toBe(false);
        } finally { Object.defineProperty(console, "log", descriptor); }
    });
    it("keeps the previously selected native logger when sanitizer replaces it", () => {
        const descriptor = Object.getOwnPropertyDescriptor(console, "log")!;
        const old: string[] = [], replacement: string[] = [];
        const selected = function (this: unknown, text: string) { expect(this).toBe(console); old.push(text); };
        Object.defineProperty(console, "log", { configurable: true, writable: true, value: selected });
        native.replaceLogger = true;
        native.replacement = function (this: unknown, text: string) { expect(this).toBe(console); replacement.push(text); };
        try {
            expect(runDoctor("/project")).toBe(true);
            expect(old).toEqual(["\n=== CCC Doctor ===\n", "  ✓ Runtime: Docker running (v27, native)"]);
            expect(replacement).toContain("  ✓ Image: Built locally (dev)");
        } finally { Object.defineProperty(console, "log", descriptor); }
    });
    it("looks up the logger separately at every original output site", () => {
        const descriptor = Object.getOwnPropertyDescriptor(console, "log")!;
        let reads = 0;
        const texts: string[] = [];
        Object.defineProperty(console, "log", { configurable: true, get() {
            reads++;
            return function (this: unknown, text: string) { expect(this).toBe(console); texts.push(text); };
        } });
        try { expect(runDoctor("/project")).toBe(true); expect(reads).toBe(10); expect(texts).toHaveLength(10); }
        finally { Object.defineProperty(console, "log", descriptor); }
    });
    it("sanitizes terminal control and bidi bytes at publication", () => {
        native.launcherStatus = 2; native.launcherText = "unmanaged\u001b[2K\u200fX";
        expect(runDoctor("/project")).toBe(true);
        expect(console.log).toHaveBeenCalledWith("  ! Claude: unmanaged?[2K?X");
    });
});
