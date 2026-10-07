import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname } from "path";

const native = vi.hoisted(() => ({ spawn: vi.fn(), filesystem: vi.fn(), lstat: vi.fn() }));
vi.mock("child_process", async original => {
    const actual = await original<typeof import("node:child_process")>();
    const blocked = () => { throw new Error("Forbidden fixture process"); };
    return { ...actual, spawnSync: native.spawn, spawn: blocked, exec: blocked,
        execFile: blocked, execSync: blocked, execFileSync: blocked, fork: blocked };
});
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    const blocked = () => { native.filesystem(); throw new Error("Forbidden fixture filesystem effect"); };
    return { ...actual,
        ...Object.fromEntries(Object.entries(actual).filter(([, value]) => typeof value === "function").map(([name]) => [name, blocked])),
        promises: Object.fromEntries(Object.keys(actual.promises).map(name => [name, blocked])),
        lstatSync: native.lstat,
        readFileSync: (selected: unknown) => {
            if (selected instanceof URL && selected.href === new URL("../../../packages/device-lab/package.json", import.meta.url).href) {
                return JSON.stringify({ version: "0.0.0-fixture" });
            }
            return blocked();
        },
    };
});
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(),
    homedir: () => process.platform === "win32" ? "C:\\ccc-codex-config-fake\\home" : "/ccc-codex-config-fake/home",
    tmpdir: () => process.platform === "win32" ? "C:\\ccc-codex-config-fake\\temp" : "/ccc-codex-config-fake/temp",
}));
const docker = await import("../../docker.js");
const runtime = await import("../../container-runtime.js");
const utils = await import("../../utils.js");
const acl = await import("../../codex-config-acl.js");
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
const target = "pinned target;$(ignored)";
const guard = 'dir=/home/ccc/.codex; [ ! -L "$dir" ] && [ -d "$dir" ]';
const directoryProbe = `${guard} && [ -r "$dir" ] && [ -w "$dir" ] && [ -x "$dir" ]`;
const configProbe = `${guard} && file="$dir/config.toml" && [ ! -L "$file" ] && { [ ! -e "$file" ] || { [ -f "$file" ] && [ -r "$file" ] && [ -w "$file" ]; }; }`;
const wrap = (script: string) => `timeout -k 2s 10s sh -c '${script.replace(/'/g, `'"'"'`)}'`;
const call = (script: string, root = false, cli = "docker") => [cli,
    ["exec", ...(root ? ["--user", "root"] : []), target, "sh", "-c", wrap(script)],
    { encoding: "utf-8", timeout: 15_000 },
];
const uidCall = (cli = "docker") => [cli, ["exec", target, "sh", "-c", "id -u"], { encoding: "utf-8", timeout: 15_000 }];
const repaired = [call(directoryProbe), uidCall(), call(acl.codexConfigDirectoryAclScript("2001"), true),
    call(directoryProbe), call(configProbe), call(acl.codexConfigFileAclScript("2001"), true), call(configProbe)];
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}
function queueRepair() {
    for (const status of [1, 0, 0, 0, 1, 0, 0]) native.spawn.mockReturnValueOnce({ status, stdout: "2001\n", stderr: "" });
}
beforeEach(() => {
    vi.resetAllMocks();
    runtime._setRuntimeInfoForTest({ runtime: "docker" });
    native.spawn.mockImplementation(() => { throw new Error("Unplanned fixture native command"); });
    native.lstat.mockImplementation((path: string) => ({ uid: 1001, nlink: 1,
        isDirectory: () => path.endsWith("codex"),
        isFile: () => path.endsWith("config.toml"),
    }));
    Object.defineProperty(process, "getuid", { configurable: true, value: () => 1001 });
});
afterEach(() => {
    expect(native.filesystem).not.toHaveBeenCalled();
    runtime._resetRuntimeCacheForTest(); vi.restoreAllMocks();
    if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    else Reflect.deleteProperty(process, "getuid");
});
function compilePublicContract() {
    const result: void = docker.prepareCodexConfigForContainer("target", "named");
    // @ts-expect-error Facade preserves its void declaration.
    const narrowed: undefined = docker.prepareCodexConfigForContainer("target");
    // @ts-expect-error Native preparation is synchronous.
    const promise: Promise<void> = docker.prepareCodexConfigForContainer("target");
    // @ts-expect-error Target remains required.
    docker.prepareCodexConfigForContainer();
    // @ts-expect-error Target must be a string.
    docker.prepareCodexConfigForContainer(1);
    void [result, narrowed, promise];
}
void compilePublicContract;

describe("Codex preparation actual profile-aware public facade", () => {
    it.each(["docker", "podman"] as const)("probes the directory before config without host mutation on %s", cli => {
        runtime._setRuntimeInfoForTest({ runtime: cli });
        native.spawn.mockReturnValue({ status: 0 });
        expect(docker.prepareCodexConfigForContainer(target)).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual([call(directoryProbe, false, cli), call(configProbe, false, cli)]);
        // Default-profile resolution may inspect layout provenance but never the config inode.
        expect(native.lstat.mock.calls.some(([path]) => path.endsWith("config.toml"))).toBe(false);
    });
    it.each([undefined, "named"])("validates profile %s host identity and reuses mapped UID for both typed ACL grants", profile => {
        const config = utils.getCodexConfigFile(profile);
        native.lstat.mockClear();
        queueRepair();
        expect(docker.prepareCodexConfigForContainer(target, profile)).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual(repaired);
        const validations = native.lstat.mock.calls.slice(-4);
        expect(validations).toEqual([[dirname(config)], [config], [dirname(config)], [config]]);
        expect(native.lstat.mock.calls.filter(([path]) => path.endsWith("config.toml"))).toEqual([[config], [config]]);
        expect(docker.CODEX_CONFIG_PREPARE_TIMEOUT_MS).toBe(15_000);
        expect(repaired[2]![1]).not.toContain("chown");
    });
    it("selects latest runtime for every native effect", () => {
        const clis = ["docker", "podman", "docker", "podman", "docker", "podman", "docker"] as const;
        [1, 0, 0, 0, 1, 0, 0].forEach((status, i) => native.spawn.mockImplementationOnce(() => {
            runtime._setRuntimeInfoForTest({ runtime: clis[(i + 1) % clis.length]! });
            return { status, stdout: "2001\n", stderr: "" };
        }));
        docker.prepareCodexConfigForContainer(target);
        expect(native.spawn.mock.calls).toEqual(repaired.map((args, i) => [clis[i], ...args.slice(1)]));
    });
    it.each([0, 2, 3, 4, 5, 6])("refuses failure classes at native phase %s without later effects", phase => {
        for (const observation of [{ status: null, error: { code: "ETIMEDOUT", message: "bounded" } },
            { status: 124 }, { status: 137 }, { status: null }, { status: -1 }, { status: 42 },
            { status: 0, error: { code: "ENOENT", message: "missing" } }]) {
            native.spawn.mockReset(); native.lstat.mockClear();
            [1, 0, 0, 0, 1, 0, 0].forEach((status, i) => native.spawn.mockReturnValueOnce(i === phase
                ? { stdout: "", stderr: "", ...observation } : { status, stdout: "2001", stderr: "" }));
            expect(() => docker.prepareCodexConfigForContainer(target)).toThrow("Unable to prepare Codex credentials");
            expect(native.spawn.mock.calls).toEqual(repaired.slice(0, phase + 1));
        }
    });
    it.each(["dispatch", "status", "error"])("preserves native %s exception identity without continuation", field => {
        for (const phase of [0, 1, 2, 3, 4, 5, 6]) for (const failure of [new Error(field), { field }]) {
            native.spawn.mockReset();
            [1, 0, 0, 0, 1, 0, 0].forEach((status, i) => native.spawn.mockImplementationOnce(() => {
                if (i !== phase) return { status, stdout: "2001", stderr: "" };
                if (field === "dispatch") throw failure;
                return { stdout: "2001", stderr: "",
                    get status() { if (field === "status") throw failure; return status; },
                    get error() { if (field === "error") throw failure; return undefined; } };
            }));
            expect(thrown(() => docker.prepareCodexConfigForContainer(target))).toBe(failure);
            expect(native.spawn.mock.calls).toEqual(repaired.slice(0, phase + 1));
        }
    });
    it("passes raw successful observations through both policies without reading unrelated fields", () => {
        const observed: string[] = [];
        for (const phase of ["directory", "config"]) native.spawn.mockImplementationOnce(() => {
            const result = { get error() { observed.push(`${phase}:error`); return undefined; },
                get status() { observed.push(`${phase}:status`); return 0; } };
            for (const field of ["stdout", "stderr", "signal", "output", "pid", "then"]) Object.defineProperty(result, field,
                { get() { throw new Error(`unobserved ${field}`); } });
            return result;
        });
        docker.prepareCodexConfigForContainer(target);
        expect(observed).toEqual(["directory:error", "directory:status", "directory:status", "config:error", "config:status", "config:status"]);
    });
    it.each(["directory", "owner", "file", "links"])("refuses unsafe host %s before root ACL mutation", invalid => {
        native.spawn.mockReturnValueOnce({ status: 1 });
        native.lstat.mockImplementation((_path: string) => ({ uid: invalid === "owner" ? 2 : 1001,
            nlink: invalid === "links" ? 2 : 1,
            isDirectory: () => invalid !== "directory", isFile: () => invalid !== "file" }));
        expect(() => docker.prepareCodexConfigForContainer(target)).toThrow("Unable to prepare Codex credentials");
        expect(native.spawn.mock.calls).toEqual([call(directoryProbe)]);
    });
    it("refuses absent host user identity before inspecting or mutating host credentials", () => {
        Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
        native.spawn.mockReturnValueOnce({ status: 1 });
        expect(() => docker.prepareCodexConfigForContainer(target, "named")).toThrow("host user identity is unavailable");
        expect(native.lstat).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls).toEqual([call(directoryProbe)]);
    });
    it("preserves host metadata failure identity before UID discovery or root effects", () => {
        const failure = { metadata: true };
        native.lstat.mockImplementation(() => { throw failure; });
        native.spawn.mockReturnValueOnce({ status: 1 });
        expect(thrown(() => docker.prepareCodexConfigForContainer(target, "named"))).toBe(failure);
        expect(native.spawn.mock.calls).toEqual([call(directoryProbe)]);
    });
    it("allows absent config during directory repair but refuses absent config repair", () => {
        native.lstat.mockImplementation(path => {
            if (path.endsWith("config.toml")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
            return { uid: 1001, isDirectory: () => true };
        });
        native.spawn.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0, stdout: "2001" })
            .mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });
        expect(() => docker.prepareCodexConfigForContainer(target)).toThrow("absent");
        expect(native.spawn.mock.calls).toEqual(repaired.slice(0, 5));
    });
    it.each(["", "-1", "2001x", "4294967295"])("refuses invalid mapped identity %s without root mutation", uid => {
        native.spawn.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0, stdout: uid });
        expect(() => docker.prepareCodexConfigForContainer(target)).toThrow("invalid container user identity");
        expect(native.spawn.mock.calls).toEqual(repaired.slice(0, 2));
    });
    it("preserves metadata method receivers and getter order with the live process UID receiver", () => {
        const seen: string[] = [];
        native.lstat.mockImplementation((path: string) => {
            const parent = { get uid() { seen.push("uid"); return 1001; },
                isDirectory() { expect(this).toBe(parent); seen.push("isDirectory"); return true; } };
            const file = { get nlink() { seen.push("nlink"); return 1; },
                isFile() { expect(this).toBe(file); seen.push("isFile"); return true; } };
            return path.endsWith("config.toml") ? file : parent;
        });
        Object.defineProperty(process, "getuid", { configurable: true, value: function(this: unknown) {
            expect(this).toBe(process); seen.push("getuid"); return 1001;
        } });
        queueRepair(); docker.prepareCodexConfigForContainer(target, "named");
        expect(seen).toEqual(["isDirectory", "uid", "getuid", "isFile", "nlink", "isDirectory", "uid", "getuid", "isFile", "nlink"]);
        expect(native.spawn.mock.calls).toEqual(repaired);
    });
    it("discovers a fresh mapped UID on the next invocation", () => {
        queueRepair(); docker.prepareCodexConfigForContainer(target, "named");
        [1, 0, 0, 0, 1, 0, 0].forEach(status => native.spawn.mockReturnValueOnce({ status, stdout: "3001", stderr: "" }));
        docker.prepareCodexConfigForContainer(target, "named");
        const second = [call(directoryProbe), uidCall(), call(acl.codexConfigDirectoryAclScript("3001"), true),
            call(directoryProbe), call(configProbe), call(acl.codexConfigFileAclScript("3001"), true), call(configProbe)];
        expect(native.spawn.mock.calls).toEqual([...repaired, ...second]);
    });
    it("keeps nested facade UID caches independent while resuming the outer repair", () => {
        native.spawn.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0, stdout: "2001" })
            .mockImplementationOnce(() => {
                docker.prepareCodexConfigForContainer(target, "named"); return { status: 0 };
            });
        [1, 0, 0, 0, 1, 0, 0].forEach(status => native.spawn.mockReturnValueOnce({ status, stdout: "3001", stderr: "" }));
        [0, 1, 0, 0].forEach(status => native.spawn.mockReturnValueOnce({ status }));
        docker.prepareCodexConfigForContainer(target, "named");
        const nested = [call(directoryProbe), uidCall(), call(acl.codexConfigDirectoryAclScript("3001"), true),
            call(directoryProbe), call(configProbe), call(acl.codexConfigFileAclScript("3001"), true), call(configProbe)];
        expect(native.spawn.mock.calls).toEqual([...repaired.slice(0, 3), ...nested, ...repaired.slice(3)]);
    });
    it("preserves native preclassification before changing observations reach the leaf", () => {
        const reads: string[] = []; let count = 0;
        native.spawn.mockReturnValueOnce({ get error() { reads.push("error"); return undefined; },
            get status() { reads.push("status"); return ++count === 1 ? 0 : 124; }, stderr: "" });
        expect(() => docker.prepareCodexConfigForContainer(target, "named")).toThrow("access probe timed out");
        expect(reads).toEqual(["error", "status", "status", "error", "status"]);
        expect(native.spawn.mock.calls).toEqual([call(directoryProbe)]);
    });
    it("keeps calls independent after a failed repair", () => {
        native.spawn.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0, stdout: "2001" }).mockReturnValueOnce({ status: 42 });
        expect(() => docker.prepareCodexConfigForContainer(target)).toThrow("directory ACL grant failed");
        native.spawn.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 });
        expect(docker.prepareCodexConfigForContainer(target)).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual([...repaired.slice(0, 3), call(directoryProbe), call(configProbe)]);
    });
});
