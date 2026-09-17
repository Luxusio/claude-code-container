import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessSync, chmodSync, chownSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const state = vi.hoisted(() => ({ home: "", spawn: vi.fn() }));
vi.mock("os", async (original) => ({
    ...await original<typeof import("os")>(),
    homedir: () => state.home,
}));
vi.mock("child_process", async (original) => ({
    ...await original<typeof import("child_process")>(),
    spawnSync: state.spawn,
}));
vi.mock("fs", async (original) => {
    const fs = await original<typeof import("fs")>();
    return { ...fs, accessSync: vi.fn(fs.accessSync), lstatSync: vi.fn(fs.lstatSync) };
});

const realFs = await vi.importActual<typeof import("fs")>("fs");
const realProcess = await vi.importActual<typeof import("child_process")>("child_process");
const access = vi.mocked(accessSync);
const lstat = vi.mocked(lstatSync);
const denied = () => Object.assign(new Error("permission denied"), { code: "EACCES" });
let configFile: string;
let configDir: string;
let restore: typeof import("../docker.js").restoreCodexConfigHostOwnership;
let prepare: typeof import("../docker.js").prepareCodexConfigForContainer;
let buildMcp: typeof import("../mcp-forward.js").buildMcpConfig;
let warning: ReturnType<typeof vi.spyOn>;
const userConfig = 'model = "test-model"\n[plugins."test@marketplace"]\nenabled = true\n';
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");

beforeEach(async () => {
    vi.resetModules();
    state.home = mkdtempSync(join(tmpdir(), "ccc-config-access-"));
    configDir = join(state.home, ".ccc", "codex");
    configFile = join(configDir, "config.toml");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, userConfig, { mode: 0o600 });
    if (typeof process.getuid !== "function") {
        Object.defineProperty(process, "getuid", { value: () => realFs.statSync(configDir).uid, configurable: true });
    }
    access.mockReset().mockImplementation(realFs.accessSync);
    lstat.mockReset().mockImplementation(realFs.lstatSync);
    state.spawn.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await import("../container-runtime.js");
    runtime._setRuntimeInfoForTest({ runtime: "docker", cli: "docker", flavor: "docker-desktop", remote: true, rootless: false });
    restore = (await import("../docker.js")).restoreCodexConfigHostOwnership;
    prepare = (await import("../docker.js")).prepareCodexConfigForContainer;
    buildMcp = (await import("../mcp-forward.js")).buildMcpConfig;
});

afterEach(() => {
    vi.restoreAllMocks();
    if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    else Reflect.deleteProperty(process, "getuid");
    rmSync(state.home, { recursive: true, force: true });
});

it("leaves accessible config and its permission bits untouched", () => {
    chmodSync(configFile, 0o640);
    const originalMode = realFs.statSync(configFile).mode;
    restore("ccc-test");
    expect(state.spawn).not.toHaveBeenCalled();
    expect(realFs.statSync(configFile).mode).toBe(originalMode);
    expect(readFileSync(configFile, "utf8")).toBe(userConfig);
});

it("does not repair a genuinely absent config", () => {
    rmSync(configFile);
    restore("ccc-test");
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
});

it.each(["EACCES", "EPERM"])("repairs %s with mapped reference ownership and verifies host access", (code) => {
    access.mockImplementationOnce(() => { throw Object.assign(denied(), { code }); });
    restore("ccc-test");
    expect(state.spawn).toHaveBeenCalledTimes(1);
    const args = state.spawn.mock.calls[0][1] as string[];
    expect(args.slice(0, 4)).toEqual(["exec", "--user", "root", "ccc-test"]);
    expect(args.at(-1)).toContain('owner=$(stat -c %u "$dir")');
    expect(args.at(-1)).toContain('chown --no-dereference "$owner" "$file"');
    expect(args.at(-1)).not.toContain("--reference=");
    expect(args.at(-1)).toContain('chmod u+rw "$file"');
    expect(args.at(-1)).not.toContain(" -R");
    expect(args.at(-1)).not.toContain("chmod 600");
    expect(access).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
});

it("does not treat other filesystem errors as an ownership problem", () => {
    access.mockImplementationOnce(() => { throw Object.assign(new Error("I/O failure"), { code: "EIO" }); });
    restore("ccc-test");
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("I/O failure"));
});

it("warns and skips repair when host identity is unavailable", () => {
    access.mockImplementationOnce(() => { throw denied(); });
    // Model Windows, where the API itself is absent, not a throwing UID lookup.
    const original = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try { restore("ccc-test"); } finally {
        Object.defineProperty(process, "getuid", { value: original, configurable: true });
    }
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("identity is unavailable"));
});

it("uses the same mapped directory reference for rootless Podman", async () => {
    const runtime = await import("../container-runtime.js");
    runtime._setRuntimeInfoForTest({ runtime: "podman", flavor: "podman-rootless", rootless: true });
    access.mockImplementationOnce(() => { throw denied(); });
    restore("ccc-test");
    expect(state.spawn).toHaveBeenCalledWith("podman", expect.any(Array), expect.any(Object));
    const script = state.spawn.mock.calls[0][1].at(-1) as string;
    expect(script).toContain('owner=$(stat -c %u "$dir")');
    expect(script).not.toMatch(/chown \d+:\d+/);
    expect(warning).not.toHaveBeenCalled();
});

it("does not use a foreign-owned parent as the ownership reference", () => {
    access.mockImplementationOnce(() => { throw denied(); });
    const parent = realFs.lstatSync(configDir);
    lstat.mockReturnValueOnce(Object.assign(parent, { uid: (process.getuid?.() ?? 0) + 1 }));
    restore("ccc-test");
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("owned by the host user"));
});

it("warns when parent metadata is inaccessible without attempting recursive repair", () => {
    access.mockImplementationOnce(() => { throw denied(); });
    lstat.mockImplementationOnce(() => { throw denied(); });
    expect(() => restore("ccc-test")).not.toThrow();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
});

it.each([
    { status: 1, stdout: "", stderr: "denied" },
    { status: null, error: new Error("runtime unavailable") },
])("warns when runtime repair fails and preserves the file", (result) => {
    access.mockImplementationOnce(() => { throw denied(); });
    state.spawn.mockReturnValue(result);
    expect(() => restore("ccc-test")).not.toThrow();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("container ownership repair failed"));
    expect(readFileSync(configFile, "utf8")).toBe(userConfig);
});

it("does not claim success when the host still lacks access", () => {
    access.mockImplementation(() => { throw denied(); });
    expect(() => restore("ccc-test")).not.toThrow();
    expect(access).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
});

describe.skipIf(process.platform === "win32")("Unix file types", () => {
    it.each(["config", "parent"])("does not follow a %s symlink", (target) => {
        const outside = join(state.home, "outside");
        if (target === "config") {
            writeFileSync(outside, "untouched");
            rmSync(configFile);
            symlinkSync(outside, configFile);
        } else {
            rmSync(configDir, { recursive: true });
            mkdirSync(outside);
            writeFileSync(join(outside, "config.toml"), "untouched");
            symlinkSync(outside, configDir);
        }
        access.mockImplementationOnce(() => { throw denied(); });
        restore("ccc-test");
        expect(state.spawn).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalled();
    });

    it("refuses a directory in place of the config file", () => {
        rmSync(configFile);
        mkdirSync(configFile);
        access.mockImplementationOnce(() => { throw denied(); });
        restore("ccc-test");
        expect(state.spawn).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalled();
    });

    it("rechecks file type inside the runtime before changing metadata", () => {
        const outside = join(state.home, "outside");
        writeFileSync(outside, "untouched", { mode: 0o400 });
        access.mockImplementationOnce(() => { throw denied(); });
        state.spawn.mockImplementation((_cli, args: string[]) => {
            rmSync(configFile);
            symlinkSync(outside, configFile);
            return realProcess.spawnSync("sh", ["-c", args.at(-1)!.replace("/home/ccc/.codex", configDir)], { encoding: "utf8" });
        });
        restore("ccc-test");
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("container ownership repair failed"));
        expect(realFs.statSync(outside).mode & 0o777).toBe(0o400);
        expect(readFileSync(outside, "utf8")).toBe("untouched");
    });
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("real host EACCES regression", () => {
    it("recovers before real MCP generation without losing user/plugin config", () => {
        // A distinct supplementary group proves repair preserves group identity,
        // not just the mode bits (chown --reference would replace this group).
        const alternateGroup = process.getgroups?.().find((gid) => gid !== realFs.statSync(configDir).gid);
        if (alternateGroup !== undefined) chownSync(configFile, process.getuid!(), alternateGroup);
        const originalGroup = realFs.statSync(configFile).gid;
        chmodSync(configFile, 0o040);
        expect(() => readFileSync(configFile, "utf8")).toThrow(expect.objectContaining({ code: "EACCES" }));
        expect(() => buildMcp()).toThrow(/Unable to read Codex config.*EACCES/);
        state.spawn.mockImplementation((_cli, args: string[]) => {
            let script = args.at(-1)!.replace("/home/ccc/.codex", configDir);
            // The simulated Linux container uses host utilities in this fixture.
            if (process.platform === "darwin") {
                script = script.replace("stat -c %u", "stat -f %u")
                    .replace("chown --no-dereference", "chown -h");
            }
            return realProcess.spawnSync("sh", ["-c", script], { encoding: "utf8" });
        });
        restore("ccc-test");
        expect(warning).not.toHaveBeenCalled();
        expect(() => realFs.accessSync(configFile, constants.R_OK | constants.W_OK)).not.toThrow();
        expect(realFs.statSync(configFile).mode & 0o777).toBe(0o640);
        expect(realFs.statSync(configFile).gid).toBe(originalGroup);
        buildMcp();
        const merged = readFileSync(configFile, "utf8");
        expect(merged).toContain(userConfig.trim());
        expect(merged).toContain("# ccc-managed-mcp begin");
        buildMcp();
        expect(readFileSync(configFile, "utf8")).toBe(merged);
        restore("ccc-test");
        expect(state.spawn).toHaveBeenCalledTimes(1);
    });

    it("keeps unresolved access failure fatal at MCP generation, without overwriting config", () => {
        chmodSync(configFile, 0);
        state.spawn.mockReturnValue({ status: 1, stdout: "", stderr: "denied" });
        expect(() => restore("ccc-test")).not.toThrow();
        expect(warning).toHaveBeenCalled();
        expect(() => buildMcp()).toThrow(/Unable to read Codex config.*EACCES/);
        chmodSync(configFile, 0o600);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });
});

describe("container credential preparation", () => {
    const scripts = () => state.spawn.mock.calls.map(([, args]) => (args as string[]).at(-1)!);
    const result = (status = 0, stdout = "", stderr = "") => ({ status, stdout, stderr });
    const isDirectoryProbe = (script: string) => script.includes('[ -x "$dir" ]');
    const isConfigProbe = (script: string) => script.includes('[ ! -e "$file" ]');
    const isGrant = (script: string) => script.includes("acl=$(getfacl");
    const simulate = (overrides: (script: string) => ReturnType<typeof result> | undefined = () => undefined) => {
        let checkedDirectory = false;
        state.spawn.mockImplementation((_cli, args: string[]) => {
            const script = args.at(-1)!;
            const override = overrides(script);
            if (override) return override;
            if (script === "id -u") return result(0, "2001\n");
            if (isDirectoryProbe(script) && !checkedDirectory) {
                checkedDirectory = true;
                return result(1);
            }
            return result();
        });
    };

    it("leaves healthy directory/config metadata alone and probes the directory first", () => {
        prepare("ccc-test");
        expect(state.spawn).toHaveBeenCalledTimes(2);
        expect(isDirectoryProbe(scripts()[0])).toBe(true);
        expect(isConfigProbe(scripts()[1])).toBe(true);
        expect(lstat).not.toHaveBeenCalled();
        expect(state.spawn.mock.calls.every(([, args]) => !args.includes("--user"))).toBe(true);
    });

    it("grants the actual container user parent access even when config is absent", () => {
        rmSync(configFile);
        chmodSync(configDir, 0o700);
        simulate();
        prepare("ccc-test");
        const grant = scripts().find(isGrant)!;
        expect(grant).toContain('setfacl -m "u:2001:rwx" -- "$dir"');
        expect(grant).not.toMatch(/setfacl[^;]*(-R|-d|--default)|chown|chmod/);
        expect(scripts().filter(isDirectoryProbe)).toHaveLength(2);
        expect(scripts().findIndex(isConfigProbe)).toBeGreaterThan(scripts().findIndex(isGrant));
        expect(scripts().some((script) => script.includes("apt-get"))).toBe(false);
        expect(realFs.statSync(configDir).uid).toBe(process.getuid!());
    });

    it("provisions missing ACL tools with bounded time only for a needed directory repair", () => {
        simulate((script) => script.includes("command -v getfacl") ? result(1) : undefined);
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
        prepare("ccc-test");
        const install = state.spawn.mock.calls.find(([, args]) => args.at(-1).includes("apt-get"))!;
        expect(install[1]).toContain("root");
        expect(install[1].at(-1)).toContain("timeout 90 sh -c");
        expect(install[1].at(-1)).toContain("install -y --no-install-recommends acl");
        expect(install[2].timeout).toBe(100000);
        expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Installing ACL tools"));
    });

    it.each(["installation", "grant", "verification"])("reports a directory %s failure before config handoff", (failure) => {
        simulate((script) => {
            if (failure === "installation" && script.includes("command -v getfacl")) return result(1);
            if ((failure === "installation" && script.includes("apt-get"))
                || (failure === "grant" && isGrant(script))
                || (failure === "verification" && isDirectoryProbe(script))) {
                return result(1, "", "permission policy denied");
            }
            return undefined;
        });
        vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => prepare("ccc-test")).toThrow(/failed \(permission policy denied\)/);
        expect(scripts().some(isConfigProbe)).toBe(false);
    });

    it("does not mistake a timed-out probe for a permission denial", () => {
        state.spawn.mockReturnValue({ status: null, error: new Error("spawn ETIMEDOUT") });
        expect(() => prepare("ccc-test")).toThrow(/directory access check failed.*ETIMEDOUT/);
        expect(state.spawn).toHaveBeenCalledOnce();
        expect(lstat).not.toHaveBeenCalled();
    });

    it("rejects a foreign-owned parent before any privileged command", () => {
        simulate();
        lstat.mockReturnValueOnce(Object.assign(realFs.lstatSync(configDir), { uid: process.getuid!() + 1 }));
        expect(() => prepare("ccc-test")).toThrow(/owned by the host user/);
        expect(state.spawn).toHaveBeenCalledOnce();
    });

    it("rejects unavailable host identity before repair", () => {
        simulate();
        Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
        expect(() => prepare("ccc-test")).toThrow(/host user identity is unavailable/);
        expect(state.spawn).toHaveBeenCalledOnce();
    });

    it("rejects malformed runtime UID without interpolating it into a privileged command", () => {
        simulate((script) => script === "id -u" ? result(0, "2001; touch /tmp/unsafe") : undefined);
        expect(() => prepare("ccc-test")).toThrow(/invalid container user identity/);
        expect(scripts().some(isGrant)).toBe(false);
        expect(state.spawn.mock.calls.every(([, args]) => !args.includes("--user"))).toBe(true);
    });

    it("hands off only the config owner, preserving GID and existing mode bits", () => {
        let configChecks = 0;
        simulate((script) => {
            if (isDirectoryProbe(script)) return result();
            if (isConfigProbe(script)) return result(configChecks++ === 0 ? 1 : 0);
            return undefined;
        });
        prepare("ccc-test");
        const handoff = scripts().find((script) => script.includes("chown"))!;
        expect(handoff).toContain('chown --no-dereference "2001" "$file" && chmod u+rw "$file"');
        expect(handoff).toContain('[ ! -L "$file" ]');
        expect(handoff).not.toContain("chmod 600");
        expect(scripts().some(isGrant)).toBe(false);
        expect(configChecks).toBe(2);
    });

    it.each(["handoff", "verification"])("fails explicitly when config %s fails", (failure) => {
        simulate((script) => {
            if (isDirectoryProbe(script)) return result();
            if (isConfigProbe(script)) return result(1, "", "config still denied");
            if (failure === "handoff" && script.includes("chown")) return result(1, "", "config still denied");
            return undefined;
        });
        expect(() => prepare("ccc-test")).toThrow(new RegExp(`config ${failure === "handoff" ? "ownership handoff" : "access verification"} failed.*config still denied`));
    });

    describe.skipIf(process.platform === "win32")("native guarded repair scripts", () => {
        it.each(["parent", "config"])("rejects a %s symlink with a denied parent before any repair", (target) => {
            const outside = join(state.home, "outside");
            if (target === "parent") {
                rmSync(configDir, { recursive: true });
                mkdirSync(outside, { mode: 0o700 });
                symlinkSync(outside, configDir);
            } else {
                writeFileSync(outside, "untouched", { mode: 0o400 });
                rmSync(configFile);
                symlinkSync(outside, configFile);
                chmodSync(configDir, 0o700);
            }
            simulate();
            expect(() => prepare("ccc-test")).toThrow(/non-symlink/);
            expect(state.spawn).toHaveBeenCalledOnce();
        });

        it("installs missing ACL utilities after the real sh availability probe", () => {
            const emptyPath = join(state.home, "empty-path");
            mkdirSync(emptyPath);
            simulate((script) => script.includes("command -v getfacl")
                ? realProcess.spawnSync("/bin/sh", ["-c", script], {
                    encoding: "utf8", env: { ...process.env, PATH: emptyPath },
                }) : undefined);
            vi.spyOn(console, "error").mockImplementation(() => {});

            expect(() => prepare("ccc-test")).not.toThrow();
            expect(scripts().some((script) => script.includes("install -y --no-install-recommends acl"))).toBe(true);
        });

        it.each([
            "user:3000:rwx\nmask::---\n",
            "group:3000:rwx\nmask::r--\n",
            "mask::rwx\n",
            "default:user::rwx\ndefault:group::---\ndefault:other::---\n",
        ])("rejects complex ACL entries without running setfacl: %s", (extraAcl) => {
            const bin = join(state.home, "bin");
            mkdirSync(bin);
            const marker = join(state.home, "setfacl-called");
            // Only getfacl's output is simulated. Run the production guard shell
            // with real file types and verify it never invokes the mutator.
            writeFileSync(join(bin, "getfacl"), `#!/bin/sh\nprintf '%s\\n' 'user::rwx\ngroup::r-x\nother::r-x\n${extraAcl}'\n`, { mode: 0o755 });
            writeFileSync(join(bin, "setfacl"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
            simulate((script) => isGrant(script) ? realProcess.spawnSync("sh", ["-c", script.replace("/home/ccc/.codex", configDir)], {
                encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            }) : undefined);
            expect(() => prepare("ccc-test")).toThrow(/existing named, masked or default ACL requires manual inspection/);
            expect(realFs.existsSync(marker)).toBe(false);
            expect(realFs.statSync(configDir).mode & 0o777).toBe(0o755);
            expect(readFileSync(configFile, "utf8")).toBe(userConfig);
        });

        it("rechecks config type in the runtime before changing the target", () => {
            const outside = join(state.home, "outside");
            writeFileSync(outside, "untouched", { mode: 0o400 });
            simulate((script) => {
                if (isDirectoryProbe(script)) return result();
                if (isConfigProbe(script)) return result(1);
                if (script.includes("chown")) {
                    rmSync(configFile);
                    symlinkSync(outside, configFile);
                    return realProcess.spawnSync("sh", ["-c", script.replace("/home/ccc/.codex", configDir)], { encoding: "utf8" });
                }
                return undefined;
            });
            expect(() => prepare("ccc-test")).toThrow(/config ownership handoff failed/);
            expect(realFs.statSync(outside).mode & 0o777).toBe(0o400);
            expect(readFileSync(outside, "utf8")).toBe("untouched");
        });
    });
});
