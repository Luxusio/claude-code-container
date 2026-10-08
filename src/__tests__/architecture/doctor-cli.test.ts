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
vi.mock("fs", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs")>();
    const indexFixture = new URL("../../index.ts", import.meta.url).href;
    // Export no ambient filesystem capability: every original export is a
    // counted denial unless explicitly replaced by an exact fixture below.
    const fenced = Object.fromEntries(Object.keys(actual).map(name => [name,
        () => deny(`filesystem:${name}`)]));
    return {
        ...fenced,
        existsSync: (path: string) => {
            if (path !== "/locks") return deny("unexpected exists path");
            record("exists", path); return false;
        },
        readdirSync: () => deny("unexpected readdir"),
        readFileSync: (path: unknown, encoding: unknown) => {
            if (!(path instanceof URL) || path.href !== indexFixture || encoding !== "utf8") {
                return deny("unexpected source read");
            }
            return actual.readFileSync(path, "utf8");
        },
    };
});
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

// Read the actual source-owned branch; only the dynamic module loader and exit effect
// are substituted. Main's separately owned prelude and real shipped CLI are root gates.
import { readFileSync } from "node:fs";
const indexSource = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
const start = indexSource.indexOf('        case "doctor": {');
const end = indexSource.indexOf('        case "devices":', start);
const doctorBranch = indexSource.slice(start, end);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
) => (loader: (specifier: string) => Promise<{ runDoctor: typeof runDoctor }>, cwd: string,
    process: { exit: (code: number) => never }) => Promise<void>;

async function invokeRoute() {
    expect(doctorBranch).toContain('await import("./doctor.js")');
    expect(doctorBranch).toContain("runDoctor(cwd)");
    const loaded: string[] = [];
    let code: number | undefined;
    const sentinel = new Error("mock exit");
    const route = new AsyncFunction("loadDoctor", "cwd", "process",
        `switch ("doctor") { ${doctorBranch.replace('import("./doctor.js")', 'loadDoctor("./doctor.js")')} }`);
    try {
        await route(async specifier => { loaded.push(specifier); return { runDoctor }; }, "/project", {
            exit: value => { code = value; throw sentinel; },
        });
    } catch (error) { if (error !== sentinel) throw error; }
    return { code, loaded };
}

describe("source CLI doctor binding with full native facade", () => {
    it("counts and denies filesystem reads outside the exact source fixture", () => {
        expect(() => readFileSync("/forbidden", "utf8")).toThrow("DENIED unexpected source read");
        expect(native.denied).toBe(1);
    });
    it.each([true, false])("uses actual boolean exit mapping with daemon %s", async daemon => {
        native.daemon = daemon;
        expect(await invokeRoute()).toEqual({ code: daemon ? 0 : 1, loaded: ["./doctor.js"] });
        expect(native.denied).toBe(0);
        expect(native.calls.some(call => call[0] === "spawn")).toBe(daemon);
    });
    it("propagates a facade raw getter failure before exit", async () => {
        Object.defineProperty(native, "version", { configurable: true, get() { throw new Error("raw version"); } });
        try { await expect(invokeRoute()).rejects.toThrow("raw version"); }
        finally { Object.defineProperty(native, "version", { configurable: true, writable: true, value: "27\n" }); }
    });
});
