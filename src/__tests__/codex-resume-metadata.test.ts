import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResumeProcessRunner, type ResumeProcessOptions, type ResumeProcessResult, type ResumeProcessRunner } from "../codex-resume-process.js";
import { missingResumeMetadata } from "../codex-resume-diagnostics.js";
import { restoreResumeMetadata } from "../codex-resume-metadata.js";
import { runCodexResumeRecovery } from "../codex-resume-recovery-runtime.js";
import { canonicalWindowsPowerShellPath, hiddenWindowsPowerShellArgs } from "@ccc/device-lab/providers/state/windows-system-powershell.mjs";

const id = "01a0c2d2-c645-7ec0-82b4-ab99ece25683";
const otherId = "01a0c2d2-c645-7ec0-82b4-ab99ece25684";
const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function result(overrides: Partial<ResumeProcessResult> = {}): ResumeProcessResult {
    return { code: 0, signal: null, overflow: false, output: "", stderr: "", ...overrides };
}
function missing(thread = id) {
    return `Error: thread-store internal error: rollout migration failed: thread ${thread} is missing its SQLite metadata\n`;
}
function fixture() {
    const home = mkdtempSync(join(tmpdir(), "ccc-metadata-unit-"));
    roots.push(home);
    mkdirSync(join(home, "sessions"));
    const path = join(home, "sessions", `rollout-2026-09-29T00-00-00-${id}.jsonl`);
    writeFileSync(path, "synthetic history\n");
    return { home, rollout: { id, path } };
}
function response1(home: string) { return { id: 1, result: { codexHome: home } }; }
function response2(path: string, thread = id) {
    return { id: 2, result: { thread: { id: thread, path, historyMode: "paginated", preview: "sensitive-preview-marker", turns: [] } } };
}
function pump(options: ResumeProcessOptions | undefined, lines: unknown[], actions: Array<{ input?: string; closeInput?: boolean }>) {
    expect(options?.input?.trim().split("\n").map(line => JSON.parse(line).method)).toEqual(["initialize"]);
    expect(options?.timeoutMs).toBeGreaterThan(0);
    expect(options?.timeoutMs).toBeLessThanOrEqual(15000);
    expect(options?.onStdoutLine).toBeTypeOf("function");
    try {
        for (const line of lines) {
            const action = options?.onStdoutLine?.(typeof line === "string" ? line : JSON.stringify(line));
            if (action) actions.push(action);
        }
        return result({ output: lines.map(line => typeof line === "string" ? line : JSON.stringify(line)).join("\n") });
    } catch {
        return result({ code: 1 });
    }
}
function protocolRunner(lines: unknown[], completion: Partial<ResumeProcessResult> = {}) {
    const actions: Array<{ input?: string; closeInput?: boolean }> = [];
    const run = vi.fn<ResumeProcessRunner["run"]>().mockImplementation(async (args, options) => {
        if (args.includes("--help")) return result({ output: "Usage: codex app-server [OPTIONS]\n--stdio\n" });
        return { ...pump(options, lines, actions), ...completion };
    });
    const runner: ResumeProcessRunner = { run, interrupted: 0, dispose: vi.fn() };
    return { runner, run, actions };
}

describe("missing metadata trigger", () => {
    it("accepts only the exact target diagnostic with noninterrupted failure", () => {
        const failure = result({ code: 1, stderr: missing() });
        expect(missingResumeMetadata(failure, id)).toBe(true);
        for (const extra of [
            { code: 0 }, { code: 2 }, { signal: "SIGTERM" as const }, { overflow: true },
            { stderr: missing(otherId) }, { stderr: `Quoted ${missing()}` },
            { stderr: `${missing()}Error: later failure\n` }, { stderr: "database locked" },
        ]) expect(missingResumeMetadata({ ...failure, ...extra }, id)).toBe(false);
    });
});

describe.skipIf(process.platform === "win32")("scoped native metadata protocol", () => {
    it("validates initialization before sending the one scoped read and closes on its response", async () => {
        const { home, rollout } = fixture();
        const { runner, run, actions } = protocolRunner([response1(home), { method: "notice", params: {} }, response2(rollout.path)]);
        expect(await restoreResumeMetadata("codex", ["-c", 'model="test"'], rollout, home, runner)).toEqual({ ok: true });
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1][0]).toEqual(["codex", "app-server", "-c", 'model="test"', "--stdio"]);
        const requests = actions.flatMap(action => action.input?.trim().split("\n").map(line => JSON.parse(line)) || []);
        expect(requests.map(request => request.method)).toEqual(["initialized", "thread/read"]);
        expect(requests[1]).toEqual(expect.objectContaining({ id: 2, params: { threadId: id, includeTurns: false } }));
        expect(actions.at(-1)?.closeInput).toBe(true);
    });

    it("rejects a different effective home before dispatching thread/read", async () => {
        const { home, rollout } = fixture();
        const wrong = fixture().home;
        const { runner, actions } = protocolRunner([response1(wrong)]);
        expect(await restoreResumeMetadata("codex", [], rollout, home, runner)).toEqual({ ok: false, stage: "metadata-home" });
        expect(actions.flatMap(action => action.input ? [action.input] : []).join("")).not.toContain("thread/read");
    });

    it.each(["wrong-id", "wrong-path", "rpc-error", "duplicate-init", "duplicate-read", "malformed", "conflicting-id", "fake-notification", "response-with-method", "missing-read"])(
        "rejects %s responses", async kind => {
            const { home, rollout } = fixture();
            const other = fixture();
            let lines: unknown[] = [response1(home), response2(rollout.path)];
            if (kind === "wrong-id") lines[1] = response2(rollout.path, otherId);
            if (kind === "wrong-path") lines[1] = response2(other.rollout.path);
            if (kind === "rpc-error") lines[1] = { id: 2, error: { code: -32601, message: "sensitive-preview-marker" } };
            if (kind === "duplicate-init") lines.splice(1, 0, response1(home));
            if (kind === "duplicate-read") lines.push(response2(rollout.path));
            if (kind === "malformed") lines[1] = "not json";
            if (kind === "conflicting-id") lines[1] = { id: 99, result: {} };
            if (kind === "fake-notification") lines[1] = { id: 2, method: "notice", params: {} };
            if (kind === "response-with-method") lines[1] = { ...response2(rollout.path), method: "notice" };
            if (kind === "missing-read") lines = [response1(home)];
            const { runner } = protocolRunner(lines);
            expect(await restoreResumeMetadata("codex", [], rollout, home, runner)).toEqual({ ok: false, stage: kind === "duplicate-read" ? "metadata-close" : "metadata-read" });
        },
    );

    it.each([{ code: 1 }, { overflow: true }, { signal: "SIGTERM" as const }])("requires clean bounded app-server exit: %j", async completion => {
        const { home, rollout } = fixture();
        const { runner } = protocolRunner([response1(home), response2(rollout.path)], completion);
        expect(await restoreResumeMetadata("codex", [], rollout, home, runner)).toEqual({ ok: false, stage: "metadata-close" });
    });

    it.each([
        { lines: [] },
        { lines: ["PRIVATE_RPC_MALFORMED"] },
        { lines: [{ id: 1, error: { code: -1, message: "PRIVATE_RPC_ERROR" } }] },
    ])("identifies initialization failure without retaining its response: %j", async ({ lines }) => {
        const { home, rollout } = fixture();
        const { runner, actions } = protocolRunner(lines);
        expect(await restoreResumeMetadata("codex", [], rollout, home, runner)).toEqual({ ok: false, stage: "metadata-initialize" });
        expect(actions.some(action => action.input?.includes("thread/read"))).toBe(false);
    });

    it("identifies unsupported metadata recovery before starting the server", async () => {
        const { home, rollout } = fixture();
        const { runner, run } = protocolRunner([]);
        run.mockResolvedValue(result({ output: "PRIVATE_UNSUPPORTED_HELP" }));
        expect(await restoreResumeMetadata("codex", [], rollout, home, runner)).toEqual({ ok: false, stage: "metadata-support" });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("identifies an unavailable local home before starting the server", async () => {
        const { home, rollout } = fixture();
        const { runner, run } = protocolRunner([]);
        expect(await restoreResumeMetadata("codex", [], rollout, join(home, "missing-home"), runner)).toEqual({ ok: false, stage: "metadata-home" });
        expect(run.mock.calls.some(call => !call[0].includes("--help"))).toBe(false);
    });

    it.each(["success", "failed-rpc", "failed-second-migration", "interrupted-help", "interrupted-rpc", "interrupted-second-migration"])("bounds the complete metadata fallback: %s", async mode => {
        const { home, rollout } = fixture();
        let interrupted = 0;
        let migrations = 0;
        let terminals = 0;
        const report = vi.fn();
        const run = vi.fn<ResumeProcessRunner["run"]>().mockImplementation(async (args, options) => {
            if (args[0] === "/usr/bin/script" && args.includes("--version")) return result({ output: "util-linux" });
            if (args[0] === "/usr/bin/script") {
                terminals++;
                return terminals === 1 ? result({ code: 1, output: `Error: Failed to resume session from ${rollout.path}: thread/resume failed during TUI bootstrap: thread/resume failed: list_turns is not supported yet (code -32601)` }) : result();
            }
            if (args.includes("migrate-rollouts")) {
                if (args.includes("--help")) return result({ output: "Usage: codex migrate-rollouts\n--apply --thread --json" });
                migrations++;
                if (migrations === 1) return result({ code: 1, stderr: missing() });
                if (mode === "interrupted-second-migration") interrupted = 143;
                return mode === "failed-second-migration" ? result({ code: 1, stderr: "PRIVATE_SECOND_MIGRATION" }) : result({ output: JSON.stringify({ outcomes: [{ thread_id: id, status: "already_paginated" }] }) });
            }
            if (args.includes("--help")) {
                if (mode === "interrupted-help") interrupted = 143;
                return result({ output: "Usage: codex app-server\n--stdio" });
            }
            if (mode === "interrupted-rpc") interrupted = 143;
            return pump(options, [response1(home), mode === "failed-rpc" ? { id: 2, error: { code: -1, message: "sensitive-preview-marker" } } : response2(rollout.path)], []);
        });
        const runner: ResumeProcessRunner = { run, get interrupted() { return interrupted; }, dispose: vi.fn() };
        const code = await runCodexResumeRecovery({ command: ["codex", "resume", "--last"], retry: ["codex", "resume"], config: [] }, runner, home, report);
        expect(code).toBe(mode === "success" ? 0 : mode.startsWith("interrupted") ? 143 : 1);
        expect(migrations).toBe(mode === "success" || mode === "failed-second-migration" || mode === "interrupted-second-migration" ? 2 : 1);
        expect(terminals).toBe(mode === "success" ? 2 : 1);
        expect(report.mock.calls.map(call => call[0]).join("")).not.toContain("sensitive-preview-marker");
        const diagnostic = report.mock.calls.map(call => call[0]).join("");
        expect(diagnostic).not.toContain("PRIVATE_SECOND_MIGRATION");
        if (mode === "failed-rpc") expect(diagnostic).toContain("[ccc] Could not restore this session's metadata (metadata-read).\n");
        if (mode === "failed-second-migration") expect(diagnostic).toContain("[ccc] Session migration failed after metadata recovery (migration-after-metadata).\n");
        if (mode.startsWith("interrupted") || mode === "success") expect(diagnostic).not.toMatch(/\((?:metadata-[a-z]+|migration(?:-after-metadata)?)\)/);
        expect(runner.dispose).toHaveBeenCalledTimes(1);
    });
});

describe("metadata stdio transport", () => {
    it("keeps stdin open for staged requests and frames split UTF-8 output", async () => {
        const runner = createResumeProcessRunner();
        const lines: string[] = [];
        const program = `
            const readline=require('node:readline');
            const lines=readline.createInterface({input:process.stdin});
            lines.on('line',line=>{
                if(line==='initialize') {
                    const output=Buffer.from(JSON.stringify({id:1,result:'한글'})+'\\n');
                    const cut=output.indexOf(Buffer.from('한'))+1;
                    process.stdout.write(output.subarray(0,cut));
                    setTimeout(()=>process.stdout.write(output.subarray(cut)),10);
                } else if(line==='read') process.stdout.write(JSON.stringify({id:2,result:'done'})+'\\n');
                else process.exitCode=8;
            });
        `;
        try {
            const result = await runner.run([process.execPath, "-e", program], {
                input: "initialize\n", timeoutMs: 2000,
                onStdoutLine(line) {
                    lines.push(line);
                    const response = JSON.parse(line);
                    return response.id === 1 ? { input: "read\n" } : { closeInput: true };
                },
            });
            expect(result.code).toBe(0);
            expect(result.overflow).toBe(false);
            expect(lines.map(line => JSON.parse(line))).toEqual([{ id: 1, result: "한글" }, { id: 2, result: "done" }]);
        } finally { runner.dispose(); }
    });

    it("contains callback exceptions and terminates the child", async () => {
        const runner = createResumeProcessRunner();
        try {
            const result = await runner.run([process.execPath, "-e", "process.stdout.write('bad-json\\n');setInterval(()=>{},1000)"], {
                input: "initialize\n", timeoutMs: 2000,
                onStdoutLine() { throw new Error("private protocol body"); },
            });
            expect(result.code).not.toBe(0);
        } finally { runner.dispose(); }
    });

    it("handles a child closing its input without an unhandled EPIPE", async () => {
        const runner = createResumeProcessRunner();
        const acknowledged = vi.fn();
        try {
            // On POSIX, close both Node's stream and its original descriptor.
            const program = `
                const fs=require('node:fs'), input=process.stdin, output=process.stdout;
                input.once('close',()=>{
                    try { fs.closeSync(0); } catch(error) { if(error.code!=='EBADF') throw error; }
                    output.write('STDIN_CLOSED\\n');
                });
                input.destroy();
                setInterval(()=>{},1000);
            `;
            let command = [process.execPath, "-e", program];
            if (process.platform === "win32") {
                // libuv deliberately leaves fd 0 open on Windows. Close the owned
                // native handle directly, without opening Console.In or duplicating it.
                const executable = canonicalWindowsPowerShellPath();
                if (!executable) throw new Error("Requires trusted system PowerShell for the native broken-pipe fixture");
                const windowsProgram = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$output = [Console]::Out
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MetadataInputFixture {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetHandleInformation(IntPtr handle, out uint flags);
}
'@
$handle = [MetadataInputFixture]::GetStdHandle(-10)
if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr]::new(-1)) { throw 'stdin handle unavailable' }
if (-not [MetadataInputFixture]::CloseHandle($handle)) { throw 'stdin handle close failed' }
$flags = [uint32]0
if ([MetadataInputFixture]::GetHandleInformation($handle, [ref]$flags) -or [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 6) {
    throw 'stdin handle remained open'
}
$output.WriteLine('STDIN_CLOSED')
$output.Flush()
while ($true) { [Threading.Thread]::Sleep(1000) }
`;
                command = [executable, ...hiddenWindowsPowerShellArgs(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
                    Buffer.from(windowsProgram, "utf16le").toString("base64")])];
            }
            const result = await runner.run(command, {
                timeoutMs: 2000,
                onStdoutLine(line) {
                    expect(line).toBe("STDIN_CLOSED");
                    acknowledged();
                    return { input: "x".repeat(1024) };
                },
            });
            expect(acknowledged).toHaveBeenCalledTimes(1);
            expect(result.code).not.toBe(0);
            expect(result.overflow).toBe(false);
        } finally { runner.dispose(); }
    });

    it("bounds unanswered requests and lines without delimiters", async () => {
        const runner = createResumeProcessRunner();
        try {
            const noResponse = await runner.run([process.execPath, "-e", "setInterval(()=>{},1000)"], {
                input: "initialize\n", timeoutMs: 30, onStdoutLine() {},
            });
            expect(noResponse.code).not.toBe(0);
            expect(noResponse.overflow).toBe(true);
            const calls = vi.fn();
            const large = await runner.run([process.execPath, "-e", "process.stdout.write('x'.repeat(80000));setInterval(()=>{},1000)"], {
                input: "initialize\n", timeoutMs: 2000, onStdoutLine: calls,
            });
            expect(large.overflow).toBe(true);
            expect(large.output.length).toBeLessThanOrEqual(65536);
            expect(calls).not.toHaveBeenCalled();
        } finally { runner.dispose(); }
    });
});
