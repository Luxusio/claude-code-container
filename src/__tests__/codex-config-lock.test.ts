import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const state = vi.hoisted(() => ({ home: "", calls: [] as Array<{ file: string; options: unknown }> }));
vi.mock("os", async original => ({ ...await original<typeof import("os")>(), homedir: () => state.home }));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", async original => {
    const actual = await original<typeof import("@ccc/device-lab/device-lab-shared-state.js")>();
    return { ...actual, withSharedMutationLock: (file: string, operation: () => unknown, options: object) => {
        state.calls.push({ file, options });
        // Use the real lock implementation but bound contended fixture waits.
        return actual.withSharedMutationLock(file, operation, { ...options, waitMs: 0 });
    } };
});
import { withCodexConfigLock } from "../codex-config-lock.js";
beforeEach(() => {
    vi.stubEnv("container", "");
    state.home = mkdtempSync(join(tmpdir(), "ccc-profile-lock-"));
    state.calls.length = 0;
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(state.home, { recursive: true, force: true }); });

it("holds a real private host lock through mutation and releases after failure", () => {
    expect(() => withCodexConfigLock(() => {
        expect(existsSync(state.calls[0].file)).toBe(true);
        expect(state.calls[0].options).toEqual({ waitMs: 300000, reclaimStale: false });
        throw new Error("mutation failed");
    })).toThrow("mutation failed");
    expect(existsSync(state.calls[0].file)).toBe(false);
    expect(state.calls[0].file).toBe(join(state.home, ".ccc", "codex-config.lock"));
});

it("serializes the default alias while allowing a distinct named profile", () => {
    withCodexConfigLock(() => {
        expect(() => withCodexConfigLock(() => { throw new Error("must not run"); }, "default")).toThrow(/Timed out acquiring/);
        expect(withCodexConfigLock(() => "work", "work")).toBe("work");
    });
    expect(state.calls[0].file).toBe(state.calls[1].file);
    expect(state.calls[2].file).not.toBe(state.calls[0].file);
});

it("uses the resolved locks directory for named profiles while the home layout is unmigrated", () => {
    mkdirSync(join(state.home, ".ccc", "locks"), { recursive: true, mode: 0o700 });
    withCodexConfigLock(() => {}, "work");
    expect(state.calls[0].file).toContain(join(".ccc", "locks"));
    expect(readdirSync(join(state.home, ".ccc", "locks"))).toEqual([]);
});

it("does not rename or remove malformed preexisting lock records", () => {
    withCodexConfigLock(() => {});
    const file = state.calls[0].file;
    writeFileSync(file, "malformed", { mode: 0o600 });
    const operation = vi.fn();
    expect(() => withCodexConfigLock(operation)).toThrow(/Timed out acquiring/);
    expect(operation).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe("malformed");
});

it("refuses config writes in containers before using a different lock namespace", () => {
    vi.stubEnv("container", "docker");
    const operation = vi.fn();
    expect(() => withCodexConfigLock(operation, "work")).toThrow(/host configuration lock is unavailable/);
    expect(operation).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
});

it("respects the prior default-profile lock even with a migrated home layout", () => {
    const legacy = join(state.home, ".ccc", "codex-config.lock");
    mkdirSync(join(state.home, ".ccc", "run", "locks"), { recursive: true, mode: 0o700 });
    writeFileSync(legacy, "prior invocation", { mode: 0o600 });
    const operation = vi.fn();
    expect(() => withCodexConfigLock(operation)).toThrow(/Timed out acquiring/);
    expect(() => withCodexConfigLock(operation, "default")).toThrow(/Timed out acquiring/);
    expect(operation).not.toHaveBeenCalled();
    expect(withCodexConfigLock(() => "independent", "work")).toBe("independent");
    expect(readFileSync(legacy, "utf8")).toBe("prior invocation");
});

it("refuses a symlinked default lock parent without writing through it", () => {
    const outside = join(state.home, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(state.home, ".ccc"), process.platform === "win32" ? "junction" : "dir");
    expect(() => withCodexConfigLock(() => "unsafe")).toThrow(/Unsafe/);
    expect(readdirSync(outside)).toEqual([]);
});
