import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, repoRoot } from "./helpers/device-lab-mcp-fixture.js";

import { ownerId } from "@ccc/device-lab/providers/context.mjs";

const owner = ownerId({}, repoRoot);
function store(home: string, backend: string, ids: string[], ownerId = owner) {
    const file = join(home, ".ccc/devices/owners", ownerId, backend, "devices.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ devices: ids.map((id) => ({ id })) }));
    return file;
}
function text(result: any): string { return result.content[0].text; }
function json(result: any): any { return JSON.parse(text(result)); }

async function fixture() {
    const env: Record<string, string> = {};
    let trace = "";
    const context = await createDeviceLabMcpTestContext({ env, setupHome(home) {
        trace = join(home, "activity.jsonl");
        writeFileSync(trace, "");
        const preload = join(home, "trace.cjs");
        writeFileSync(preload, `const fs=require('fs'),cp=require('child_process');
const record=(kind,args)=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({kind,args})+'\\n');
// State locks observe only their own process identity through fixed native tools.
const ownIdentityScript = "$P = Get-CimInstance Win32_Process -Filter 'ProcessId = " + process.pid + "' -ErrorAction SilentlyContinue; $H = Get-Process -Id " + process.pid + " -ErrorAction SilentlyContinue; if ($P -and $H) { [pscustomobject]@{ startToken = $H.StartTime.ToUniversalTime().ToString('o'); commandLine = [string]$P.CommandLine } | ConvertTo-Json -Compress }";
const ownIdentityArgs = ['-WindowStyle','Hidden','-NoProfile','-NonInteractive','-Command',ownIdentityScript];
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']){const original=cp[key];cp[key]=function(...args){
const windowsIdentity = process.platform === 'win32' && ['execFile','spawn'].includes(key)
    && require('path').basename(String(args[0])).toLowerCase() === 'powershell.exe'
    && JSON.stringify(args[1]) === JSON.stringify(ownIdentityArgs);
const psArgs = args[1]?.[0] === '-ww' ? args[1].slice(1) : args[1];
const darwinIdentity = process.platform === 'darwin' && ['execFile','spawnSync'].includes(key)
    && args[0] === '/bin/ps' && Array.isArray(psArgs) && psArgs.length === 4
    && psArgs[0] === '-p' && psArgs[1] === String(process.pid) && psArgs[2] === '-o'
    && ['command=','lstart='].includes(psArgs[3]);
const ownIdentity = windowsIdentity || darwinIdentity;
record(ownIdentity ? 'own-process-identity' : key,args.slice(0,2));return original.apply(this,args)}}
globalThis.fetch=async()=>{record('fetch',[]);throw new Error('diagnostic fixture network unavailable')};
const open=fs.openSync;fs.openSync=function(file,...args){if(require('path').basename(String(file))==='devices.json')record('state',[String(file)]);return open.call(this,file,...args)};
require('module').syncBuiltinESMExports();`);
        env.NODE_OPTIONS = `--require=${JSON.stringify(join(home, "isolate-broker-auth.cjs"))} --require=${JSON.stringify(preload)}`;
    } });
    return { ...context, clear: () => writeFileSync(trace, ""), activity: () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

describe("public MCP terminal device diagnostics", () => {
    it("distinguishes missing, invalid and absent IDs, preserving compact/detail and flat inputs", async () => {
        const ctx = await fixture();
        try {
            for (const detail of [false, true]) {
                const missing = await ctx.client.callTool({ name: "ui", arguments: { detail } });
                expect(missing.isError).toBe(true);
                expect(json(missing)).toMatchObject({ ok: false, error: "missing-device-id", detail: expect.stringContaining("devices") });
                for (const deviceId of ["", "..", "../foreign", 7, null]) {
                    const result = await ctx.client.callTool({ name: "ui", arguments: { deviceId, detail } });
                    expect(result.isError).toBe(true);
                    expect(json(result).error).toBe("device-id-invalid");
                }
                const absent = await ctx.client.callTool({ name: "ui", arguments: { detail, deviceId: "absent-target" } });
                expect(absent.isError).toBe(true);
                expect(json(absent)).toMatchObject({ error: "device-not-found", deviceId: "absent-target", detail: expect.stringContaining("devices") });
            }
            expect(ctx.activity().filter((entry) => !["state", "own-process-identity"].includes(entry.kind)), JSON.stringify(ctx.activity())).toEqual([]);
        } finally { await cleanupDeviceLabMcpTestContext(ctx); }
    });

    it("recognizes owned desktop, display and local QEMU targets without provider discovery", async () => {
        const ctx = await fixture();
        try {
            store(ctx.homeDir, "windows-vm", ["desktop"]);
            store(ctx.homeDir, "macos", ["mac"]);
            const lab = join(ctx.homeDir, ".ccc/labs/owners", owner, "labs/local-qemu/lab.json");
            mkdirSync(dirname(lab), { recursive: true });
            writeFileSync(lab, JSON.stringify({ id: "local-qemu", runtimeState: "stopped" }));
            for (const [deviceId, backend] of [["desktop", "windows-vm"], ["mac", "macos-vm"], ["x11-current-display", "x11-current-display"], ["local-qemu", "linux-vm"]]) {
                ctx.clear();
                const result = await ctx.client.callTool({ name: "wait_for_text", arguments: { deviceId, text: "Ready", detail: false } });
                expect(result.isError, text(result)).toBe(true);
                expect(json(result)).toMatchObject({ error: "device-tool-unsupported", tool: "mobile_wait_for_text", deviceId, backend });
                expect(ctx.activity().filter((entry) => !["state", "own-process-identity"].includes(entry.kind)), JSON.stringify(ctx.activity())).toEqual([]);
            }
        } finally { await cleanupDeviceLabMcpTestContext(ctx); }
    });

    it("does not expose foreign-owner targets and does not guess ambiguous owned IDs", async () => {
        const ctx = await fixture();
        try {
            store(ctx.homeDir, "windows-vm", ["foreign"], "another-owner");
            store(ctx.homeDir, "windows-vm", ["duplicate"]);
            store(ctx.homeDir, "linux-vm", ["duplicate"]);
            const foreign = await ctx.client.callTool({ name: "ui", arguments: { deviceId: "foreign" } });
            expect(json(foreign).error).toBe("device-not-found");
            expect(text(foreign)).not.toContain("another-owner");
            const ambiguous = await ctx.client.callTool({ name: "ui", arguments: { deviceId: "duplicate" } });
            expect(ambiguous.isError).toBe(true);
            expect(json(ambiguous)).toMatchObject({ error: "ambiguous-device-backend", matches: expect.arrayContaining(["windows-vm", "linux-vm"]) });
            expect(ctx.activity().every((entry) => entry.kind === "own-process-identity" || entry.kind === "state" && !entry.args[0].includes("another-owner"))).toBe(true);
        } finally { await cleanupDeviceLabMcpTestContext(ctx); }
    });

    it("preserves malformed-state errors instead of reporting absence", async () => {
        const ctx = await fixture();
        try {
            const file = store(ctx.homeDir, "windows-vm", []);
            writeFileSync(file, "{broken");
            const failure = await ctx.client.callTool({ name: "ui", arguments: { deviceId: "missing" } });
            expect(failure.isError).toBe(true);
            expect(text(failure)).toContain("owner-devices-state-invalid");
            expect(text(failure)).not.toContain("device-not-found");
            expect(text(failure)).not.toContain("{broken");
        } finally { await cleanupDeviceLabMcpTestContext(ctx); }
    });

    it("preserves corrupt local QEMU metadata as a state error without leaking its contents", async () => {
        const ctx = await fixture();
        try {
            const lab = join(ctx.homeDir, ".ccc/labs/owners", owner, "labs/broken/lab.json");
            mkdirSync(dirname(lab), { recursive: true });
            writeFileSync(lab, "{private-corrupt-metadata");
            const failure = await ctx.client.callTool({ name: "ui", arguments: { deviceId: "missing" } });
            expect(failure.isError).toBe(true);
            expect(text(failure)).toContain("lab-state-invalid");
            expect(text(failure)).not.toContain("private-corrupt-metadata");
            expect(text(failure)).not.toContain("device-not-found");
        } finally { await cleanupDeviceLabMcpTestContext(ctx); }
    });

    it.each(["run_flow"])("stops %s at the terminal diagnostic in compact and detailed output", async (name) => {
        const ctx = await fixture();
        try {
            for (const detail of [false, true]) {
                const result = await ctx.client.callTool({ name, arguments: { detail, steps: [
                    { tool: "ui", arguments: { deviceId: "missing", implicitBroker: false } },
                    { tool: "key", arguments: { deviceId: "missing", implicitBroker: false } },
                ] } });
                expect(json(result)).toMatchObject({ ok: false, stoppedAt: 0, results: [{ index: 0, tool: "ui", isError: true }] });
                expect(json(result).results).toHaveLength(1);
                expect(text(result)).toContain("device-not-found");
            }
        } finally { await cleanupDeviceLabMcpTestContext(ctx); }
    });

    it("preserves preflight and destructive refusal before state lookup", async () => {
        const ctx = await fixture();
        try {
            writeFileSync(store(ctx.homeDir, "windows-vm", []), "{broken");
            for (const [name, args, message] of [
                ["key", { deviceId: "missing" }, "key requires exactly one of key or keyCode"],
                ["wait_for_text", { deviceId: "missing" }, "wait_for_text requires text"],
                ["uninstall_app", { deviceId: "missing", appId: "app" }, "destructive-action-confirmation-required"],
            ] as const) {
                ctx.clear();
                const result = await ctx.client.callTool({ name, arguments: args });
                expect(text(result)).toContain(message);
                expect(ctx.activity()).toEqual([]);
            }
        } finally { await cleanupDeviceLabMcpTestContext(ctx); }
    });

    it("does not add terminal owner-state reads to successful early dispatch or truly unknown tools", async () => {
        const ctx = await fixture();
        try {
            // Existing routing probes read mobile states even for unknown names. The
            // new classifier must not add scans of unrelated desktop state files.
            writeFileSync(store(ctx.homeDir, "windows-vm", []), "{broken");
            const unknown = await ctx.client.callTool({ name: "mobile_not_a_real_tool", arguments: {} });
            expect(json(unknown).error).toBe("Unknown tool: mobile_not_a_real_tool");
            expect(ctx.activity().filter((entry) => entry.kind === "state" && entry.args[0].includes("/windows-vm/"))).toEqual([]);
            ctx.clear();
            const result = await ctx.client.callTool({ name: "status", arguments: { deviceId: "x11-current-display" } });
            expect(result.isError, text(result)).not.toBe(true);
            expect(ctx.activity().filter((entry) => entry.kind === "state" && entry.args[0].includes("/windows-vm/"))).toEqual([]);
        } finally { await cleanupDeviceLabMcpTestContext(ctx); }
    });
});
