import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ScriptTarget, transpileModule } from "typescript";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function fixture() {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const start = source.indexOf("let preparationStatus:");
    const end = source.indexOf("if (process.env.DEBUG)", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const js = transpileModule(source.slice(start, end) + "\nreturn resultStatus;", {
        compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const events: string[] = [];
    const command = ["codex", "resume", "fixture-session"];
    const preparation = vi.fn(() => ({ ok: true, command }));
    const confirm = vi.fn(async () => { events.push("confirm"); });
    const enable = vi.fn((permission: boolean) => { expect(permission).toBe(true); events.push("enable"); });
    const run = vi.fn(async () => { events.push("run"); return 37; });
    const restore = vi.fn((container: string, profile: string) => {
        expect([container, profile]).toEqual(["fixture-container", "work"]);
        events.push("restore");
    });
    const lock = vi.fn((operation: () => void, profile: string) => {
        expect(profile).toBe("work"); events.push("lock"); return operation();
    });
    const dispose = vi.fn(() => { events.push("dispose"); });
    const cleanup = vi.fn(() => { events.push("cleanup"); });
    const warn = vi.fn();
    const execute = new AsyncFunction("commandTool", "options", "prepareCodexLaunch", "runtimeCli", "execArgs",
        "containerName", "resolvedCmd", "process", "console", "CLAUDE_BIN_PATH", "cmd", "runContainerCommand",
        "restoreCodexConfigHostOwnership", "writeOwnedEnvFile", "envEntries", "buildCodexResumeRecoveryCommand",
        "confirmSessionOwnership", "setSessionCleanupEnabled", "withCodexConfigLock", "profile", "cleanupSession", js);
    return { events, preparation, confirm, enable, run, restore, lock, dispose, cleanup, warn,
        execute: () => execute({ name: "codex" }, { interactive: true }, preparation, () => "docker", ["exec"],
            "fixture-container", command, { stdin: { isTTY: false }, stdout: { isTTY: false } },
            { error: vi.fn(), warn }, "unused", command, run, restore,
            () => ({ path: "/generated/nonsecret-env", dispose }), [["FIXTURE", "nonsecret"]],
            (args: string[]) => args, confirm, enable, lock, "work", cleanup) };
}

describe("integrated CLI launch owns command, ACL restoration and env lifetime", () => {
    it("confirms the grant before awaiting the command and restores under its resolved profile lock", async () => {
        const f = fixture();
        expect(await f.execute()).toBe(37);
        expect(f.events).toEqual(["confirm", "enable", "confirm", "run", "lock", "restore", "dispose", "cleanup"]);
        expect(f.run).toHaveBeenCalledExactlyOnceWith("docker", ["exec", "--env-file", "/generated/nonsecret-env",
            "fixture-container", "codex", "resume", "fixture-session"], true);
    });

    it.each(["restore", "lock", "cleanup"] as const)("%s failure cannot replace a completed command status or skip disposal", async stage => {
        const f = fixture();
        f[stage].mockImplementation(() => { throw new Error(`fixture ${stage} unavailable`); });
        expect(await f.execute()).toBe(37);
        expect(f.dispose).toHaveBeenCalledExactlyOnceWith();
        expect(f.cleanup).toHaveBeenCalledExactlyOnceWith();
        expect(f.warn).toHaveBeenCalledOnce();
    });

    it("preparation rejection keeps its status and never grants failed join shutdown permission", async () => {
        const f = fixture();
        f.preparation.mockReturnValue({ ok: false, command: ["codex"], status: 7, error: "fixture preparation failure" } as unknown as ReturnType<typeof f.preparation>);
        f.restore.mockImplementation(() => { throw new Error("fixture restore failure"); });
        f.cleanup.mockImplementation(() => { throw new Error("fixture cleanup failure"); });
        expect(await f.execute()).toBe(7);
        expect(f.enable).not.toHaveBeenCalled();
        expect(f.run).not.toHaveBeenCalled();
        expect(f.confirm).toHaveBeenCalledOnce();
        expect(f.dispose).toHaveBeenCalledExactlyOnceWith();
        expect(f.cleanup).toHaveBeenCalledExactlyOnceWith();
    });

    it.each(["run", "confirm"] as const)("original %s rejection survives simultaneous restoration, cleanup and diagnostic failures", async stage => {
        const f = fixture();
        const cause = { generated: `fixture ${stage} failure` };
        f[stage].mockImplementation(async () => { throw cause; });
        f.restore.mockImplementation(() => { throw new Error("fixture restoration failure"); });
        f.cleanup.mockImplementation(() => { throw new Error("fixture cleanup failure"); });
        f.warn.mockImplementation(() => { throw new Error("fixture diagnostic failure"); });
        await expect(f.execute()).rejects.toBe(cause);
        expect(f.dispose).toHaveBeenCalledExactlyOnceWith();
        expect(f.cleanup).toHaveBeenCalledExactlyOnceWith();
        expect(f.lock).toHaveBeenCalledOnce();
        if (stage === "confirm") expect(f.enable).not.toHaveBeenCalled();
    });

    it("a rejected grant confirmation never launches while cleanup still disposes its resource", async () => {
        const f = fixture();
        const cause = new Error("fixture authorization ACK lost");
        f.confirm.mockResolvedValueOnce(undefined).mockRejectedValueOnce(cause);
        await expect(f.execute()).rejects.toBe(cause);
        expect(f.enable).toHaveBeenCalledExactlyOnceWith(true);
        expect(f.run).not.toHaveBeenCalled();
        expect(f.dispose).toHaveBeenCalledExactlyOnceWith();
        expect(f.cleanup).toHaveBeenCalledExactlyOnceWith();
    });
});
