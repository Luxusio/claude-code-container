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
    for (const key of Object.keys(process.env)) if (key === "container" || key === "VITEST" || key.startsWith("VITEST_")) vi.stubEnv(key, undefined);
    // Initialize private homedir BEFORE importing utils' top-level DATA_DIR and Docker.
    api = await import("../../docker.js"); utils = await import("../../utils.js");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("actual native host credential facade", () => {
    it("retains public arity and fresh/default/named/helper results", () => {
        expect(api.resolveCredentialHostPath.length).toBe(2); expect(api.ensureCredentialHostDir.length).toBe(2);
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
    it("keeps application single VITEST and retained helper any-VITEST policies live", () => {
        vi.stubEnv("container", "docker"); vi.stubEnv("VITEST_WORKER_ID", "fixture");
        expect(api.resolveCredentialHostPath(codex)).toBe(codex.containerDir);
        expect(api.resolveCredentialHostPath(codex, "work")).toBe(join(root, ".ccc", "profiles", "work", "codex"));
        vi.stubEnv("VITEST_WORKER_ID", undefined);
        expect(api.resolveCredentialHostPath(codex, "work")).toBe(join(root, ".codex"));
        expect(api.resolveCredentialHostPath(claude, "work")).toBe(join(root, ".ccc", "profiles", "work", "claude"));
        vi.stubEnv("VITEST", "1");
        expect(api.resolveCredentialHostPath(codex)).toBe(join(root, ".ccc", "profiles", "default", "codex"));
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
