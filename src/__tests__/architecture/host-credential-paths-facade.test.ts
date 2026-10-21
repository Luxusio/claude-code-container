import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
const native = vi.hoisted(() => ({ home: "", faultPath: "", error: {} }));
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => native.home }));
vi.mock("fs", async original => {
    const fs = await original<typeof import("node:fs")>();
    return { ...fs, mkdirSync: (path: Parameters<typeof fs.mkdirSync>[0], options: Parameters<typeof fs.mkdirSync>[1]) => {
        if (path === native.faultPath) throw native.error;
        return fs.mkdirSync(path, options);
    } };
});
let api: typeof import("../../docker.js");
let utils: typeof import("../../utils.js");
let root: string;
const claude = { hostDir: ".claude", containerDir: "/home/ccc/.claude" };
const codex = { hostDir: ".codex", containerDir: "/home/ccc/.codex" };
beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ccc-host-paths-")); native.home = root; native.faultPath = "";
    vi.stubEnv("container", "");
    // Initialize private homedir BEFORE importing utils' top-level DATA_DIR and Docker.
    api = await import("../../docker.js"); utils = await import("../../utils.js");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("actual native host credential facade", () => {
    it("retains fresh, default, named and helper path results", () => {
        expect(api.resolveCredentialHostPath(claude)).toBe(join(root, ".ccc", "profiles", "default", "claude"));
        expect(api.resolveCredentialHostPath(codex, "work")).toBe(join(root, ".ccc", "profiles", "work", "codex"));
        const spy = vi.spyOn(utils, "getClaudeDir").mockReturnValue("live-helper");
        expect(api.resolveCredentialHostPath(claude, "default")).toBe("live-helper"); expect(spy).toHaveBeenCalledWith("default");
    });
    it("observes fixture legacy entries and marker policy per entry", () => {
        mkdirSync(join(root, ".ccc", "claude"), { recursive: true });
        expect(api.resolveCredentialHostPath(codex)).toBe(join(root, ".ccc", "codex"));
        mkdirSync(join(root, ".ccc", "profiles", "default"), { recursive: true });
        writeFileSync(join(root, ".ccc", "profiles", "default", ".ccc-default-profile"), "fixture");
        expect(api.resolveCredentialHostPath(codex)).toBe(join(root, ".ccc", "profiles", "default", "codex"));
        expect(api.resolveCredentialHostPath(claude)).toBe(join(root, ".ccc", "claude"));
    });
    it.each([undefined, "", "podman", "Docker", "docker "])("uses host paths for non-CCC marker %s with runner flags present", marker => {
        vi.stubEnv("container", marker); vi.stubEnv("VITEST", "1"); vi.stubEnv("VITEST_CREDENTIAL_CONTEXT", "");
        for (const profile of [undefined, "", "default", "work", " work ", " "]) {
            const name = profile && profile !== "default" ? profile : "default";
            const profileRoot = join(root, ".ccc", "profiles", name);
            expect(api.resolveCredentialHostPath(claude, profile)).toBe(join(profileRoot, "claude"));
            expect(api.resolveCredentialHostPath(codex, profile)).toBe(join(profileRoot, "codex"));
            expect(utils.getClaudeDir(profile)).toBe(join(profileRoot, "claude"));
            expect(utils.getClaudeJsonFile(profile)).toBe(join(profileRoot, "claude.json"));
            expect(utils.getCodexDir(profile)).toBe(join(profileRoot, "codex"));
            expect(utils.getCodexConfigFile(profile)).toBe(join(profileRoot, "codex", "config.toml"));
        }
    });
    it.each(["", "1", "0", "false"])("keeps literal container mounts with runner value %j", runnerValue => {
        vi.stubEnv("container", "docker"); vi.stubEnv("VITEST", runnerValue); vi.stubEnv("VITEST_CREDENTIAL_CONTEXT", runnerValue);
        const custom = { hostDir: ".custom", containerDir: "/mounted/custom" };
        for (const profile of [undefined, ""]) {
            for (const mount of [claude, codex, custom]) {
                expect(api.resolveCredentialHostPath(mount, profile)).toBe(mount.containerDir);
            }
        }
        expect(process.env.VITEST).toBe(runnerValue);
        expect(process.env.VITEST_CREDENTIAL_CONTEXT).toBe(runnerValue);
    });
    it("uses mounted Codex paths for named profiles with runner flags present", () => {
        vi.stubEnv("container", "docker"); vi.stubEnv("VITEST", "1"); vi.stubEnv("VITEST_CREDENTIAL_CONTEXT", "");
        for (const profile of ["default", "work", " work ", " "]) {
            expect(api.resolveCredentialHostPath(codex, profile)).toBe(join(root, ".codex"));
            expect(utils.getCodexDir(profile)).toBe(join(root, ".codex"));
            expect(utils.getCodexConfigFile(profile)).toBe(join(root, ".codex", "config.toml"));
        }
    });
    it("normalizes Claude defaults while retaining named paths with runner flags present", () => {
        vi.stubEnv("container", "docker"); vi.stubEnv("VITEST", ""); vi.stubEnv("VITEST_CREDENTIAL_CONTEXT", "present");
        expect(api.resolveCredentialHostPath(claude, "default")).toBe(join(root, ".claude"));
        for (const profile of [undefined, "", "default"]) {
            expect(utils.getClaudeDir(profile)).toBe(join(root, ".claude"));
            expect(utils.getClaudeJsonFile(profile)).toBe(join(root, ".claude.json"));
        }
        for (const profile of ["work", " work ", " "]) {
            const profileRoot = join(root, ".ccc", "profiles", profile);
            expect(api.resolveCredentialHostPath(claude, profile)).toBe(join(profileRoot, "claude"));
            expect(utils.getClaudeDir(profile)).toBe(join(profileRoot, "claude"));
            expect(utils.getClaudeJsonFile(profile)).toBe(join(profileRoot, "claude.json"));
        }
    });
    it("uses host fallback for truthy profiles on custom container mounts", () => {
        const custom = { hostDir: "relative\\tool", containerDir: "/mounted/custom" };
        vi.stubEnv("container", "docker"); vi.stubEnv("VITEST", "1");
        for (const profile of ["default", "work", " "]) {
            expect(api.resolveCredentialHostPath(custom, profile)).toBe(join(root, custom.hostDir));
        }
    });
    it("observes live host/container changes on the same public facade with runner flags present", () => {
        vi.stubEnv("VITEST", "1"); vi.stubEnv("VITEST_CREDENTIAL_CONTEXT", "present");
        const hostCodex = join(root, ".ccc", "profiles", "default", "codex");
        expect(api.resolveCredentialHostPath(codex)).toBe(hostCodex);
        vi.stubEnv("container", "docker");
        expect(api.resolveCredentialHostPath(codex)).toBe(codex.containerDir);
        expect(api.resolveCredentialHostPath(codex, "work")).toBe(join(root, ".codex"));
        expect(api.resolveCredentialHostPath(claude, "default")).toBe(join(root, ".claude"));
        vi.stubEnv("container", "podman");
        expect(api.resolveCredentialHostPath(codex)).toBe(hostCodex);
        expect(api.resolveCredentialHostPath(codex, "work")).toBe(join(root, ".ccc", "profiles", "work", "codex"));
        expect(api.resolveCredentialHostPath(claude, "default")).toBe(join(root, ".ccc", "profiles", "default", "claude"));
    });
    it("uses current home and host join independently of POSIX package metadata", () => {
        const next = join(root, "next"); native.home = next;
        const other = { hostDir: "relative\\tool", containerDir: "other" };
        expect(api.ensureCredentialHostDir(other, "work")).toBe(join(next, other.hostDir));
        expect(existsSync(join(next, other.hostDir))).toBe(true);
        expect(posix.dirname(utils.CODEX_PACKAGES_CONTAINER_DIR)).toBe(codex.containerDir);
        expect(api.ensureCredentialHostDir(codex, "work")).toBe(join(next, ".ccc", "profiles", "work", "codex"));
        expect(existsSync(join(next, ".ccc", "profiles", "work", "codex", "packages"))).toBe(true);
    });
    it("creates private directories without resetting existing modes", () => {
        const path = api.ensureCredentialHostDir(codex, "work");
        if (process.platform !== "win32") {
            expect(statSync(path).mode & 0o777).toBe(0o700); expect(statSync(join(path, "packages")).mode & 0o777).toBe(0o700);
            chmodSync(path, 0o755); chmodSync(join(path, "packages"), 0o750);
            api.ensureCredentialHostDir(codex, "work");
            expect(statSync(path).mode & 0o777).toBe(0o755); expect(statSync(join(path, "packages")).mode & 0o777).toBe(0o750);
        }
    });
    it("delegates real root creation and preserves it on narrow nested native failure", () => {
        const path = join(root, ".ccc", "profiles", "work", "codex"); native.faultPath = join(path, "packages");
        let caught: unknown; try { api.ensureCredentialHostDir(codex, "work"); } catch (error) { caught = error; }
        expect(caught).toBe(native.error); expect(statSync(path).isDirectory()).toBe(true); expect(existsSync(native.faultPath)).toBe(false);
    });
});
