import { fileSymlinkOrSkip } from "./helpers/file-symlink-fixture.js";
import { deviceLabTestHomeEnvironment } from "./helpers/device-lab-test-environment.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyWindowsSandboxHelperStderr, windowsSandboxHelperLogEvidence, launchWindowsSandboxSession, runWindowsHelperBootstrapFallback, runWindowsHelperRequestOnce, windowsMinimizedStartProcessArgs, cleanupWindowsSandboxMinimizeWatchdogs, windowsHelperScript, windowsReadyMinimizeWatchdogArgs, windowsSandboxGuestProcessStatus, windowsSandboxMinimizeWatchdogArgs, windowsSandboxRuntimeDelta, windowsSandboxSessionIdsFromListOutput, windowsWsbConfigLaunchArgs } from "@ccc/device-lab/providers/backends/windows-sandbox.mjs";
import { installDefaultImplicitBroker } from "./helpers/device-lab-mcp-fixture.js";

const repoRoot = join(__dirname, "../..");
const TIMEOUT = 30000;

async function waitForLog(logPath: string, pattern: RegExp) {
    const deadline = Date.now() + 1000;
    while (Date.now() <= deadline) {
        const log = readFileSync(logPath, { encoding: "utf-8", flag: "a+" });
        if (pattern.test(log)) return log;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return readFileSync(logPath, { encoding: "utf-8", flag: "a+" });
}

async function waitForStableLog(logPath: string, stableMs = 75) {
    let previous = readFileSync(logPath, { encoding: "utf-8", flag: "a+" });
    let stableSince = Date.now();
    const deadline = Date.now() + 1000;
    while (Date.now() <= deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const current = readFileSync(logPath, { encoding: "utf-8", flag: "a+" });
        if (current !== previous) {
            previous = current;
            stableSince = Date.now();
            continue;
        }
        if (Date.now() - stableSince >= stableMs) return current;
    }
    return previous;
}

// Lifecycle fixtures intentionally do not run a guest helper; readiness is covered by
// device-lab-start-readiness and the real Sandbox E2E. Exercise explicit async start here.
describe("device-lab MCP with fake Windows Sandbox CLI", () => {
    it("creates recording archives without the optional PowerShell archive module", () => {
        const script = windowsHelperScript({
            guestInboxDir: "C:\\ccc\\scratch\\inbox",
            guestOutboxDir: "C:\\ccc\\scratch\\outbox",
            guestUploadsDir: "C:\\ccc\\scratch\\uploads",
            guestDownloadsDir: "C:\\ccc\\scratch\\downloads",
        });

        expect(script).toContain("[System.IO.Compression.ZipFile]::CreateFromDirectory");
        expect(script).toContain("type = $RequestType");
        expect(script).not.toContain("Compress-Archive");
    });

    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;
    let failStopPath: string;
    let failExistingLoginPath: string;

    function windowsStatePath() {
        const ownersRoot = join(homeDir, ".ccc", "devices", "owners");
        return join(ownersRoot, readdirSync(ownersRoot)[0], "windows", "devices.json");
    }

    function armWindowsReplacement(command: string, statePath: string, successor: Record<string, unknown>, successorLock?: Record<string, unknown>) {
        const aggregate = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> };
        const devices = aggregate.devices.map((device) => device.id === successor.id ? successor : device);
        writeFileSync(join(homeDir, "fake-windows-replace-command"), command);
        writeFileSync(join(homeDir, "fake-windows-replace-state-target"), statePath);
        writeFileSync(join(homeDir, "fake-windows-replace-state-source"), `${JSON.stringify({ devices }, null, 2)}\n`);
        if (successorLock) {
            const lockPath = join(homeDir, ".ccc", "devices", "host-locks", "windows-sandbox.json");
            writeFileSync(join(homeDir, "fake-windows-replace-lock-target"), lockPath);
            writeFileSync(join(homeDir, "fake-windows-replace-lock-source"), `${JSON.stringify(successorLock, null, 2)}\n`);
        }
    }

    function disarmWindowsReplacement() {
        for (const name of ["command", "state-target", "state-source", "lock-target", "lock-source", "done"]) {
            rmSync(join(homeDir, `fake-windows-replace-${name}`), { force: true });
        }
    }

    const responders = new Set<ReturnType<typeof setInterval>>();
    function trackResponder(callback: () => void, delay: number) {
        const timer = setInterval(callback, delay);
        responders.add(timer);
        return timer;
    }
    beforeEach(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-windows-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-windows-bin-"));
        logPath = join(homeDir, "fake-windows.log");
        failStopPath = join(homeDir, "fail-stop");
        failExistingLoginPath = join(homeDir, "fail-existing-login");

        const wsbPath = join(binDir, "wsb");
        writeFileSync(wsbPath, `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),home=process.env.HOME;
fs.appendFileSync(process.env.FAKE_WINDOWS_LOG,'wsb '+args.join(' ')+'\\n');
const marker=path.join(home,'fake-windows-replace-command');
if(fs.existsSync(marker)&&fs.readFileSync(marker,'utf8').trim()===args[0]){
 for(const kind of ['state','lock']){
  const target=path.join(home,'fake-windows-replace-'+kind+'-target');
  const source=path.join(home,'fake-windows-replace-'+kind+'-source');
  if(fs.existsSync(target)&&fs.existsSync(source))fs.copyFileSync(source,fs.readFileSync(target,'utf8').trim());
 }
 fs.writeFileSync(path.join(home,'fake-windows-replace-done'),'');
}
if(process.env.FAKE_WINDOWS_FAIL_EXISTING_LOGIN&&fs.existsSync(process.env.FAKE_WINDOWS_FAIL_EXISTING_LOGIN)&&args.some((arg,index)=>arg==='--run-as'&&args[index+1]==='ExistingLogin')){
 console.error('Windows Sandbox environment process could not be started. The logon session does not exist. (0x80070520)');process.exit(32);
}
if(args[0]==='stop'&&fs.existsSync(process.env.FAKE_WINDOWS_FAIL_STOP)){console.error('forced stop failure');process.exit(7);}
`);
        const preload = join(homeDir, "fake-wsb-launcher.cjs");
        // This suite models the wsb CLI transport, not native .wsb file association.
        // Keep that route deterministic on Windows; native launcher scripts have separate tests.
        writeFileSync(preload, `Object.defineProperty(process,'platform',{value:'linux'});
const cp=require('node:child_process');const fixture=${JSON.stringify(wsbPath)};
const sync=cp.spawnSync;
cp.spawnSync=function(command,args=[],options){
 const lookup=command==='where'?args[0]:command==='/bin/sh'&&args[0]==='-c'&&args[1]?.startsWith('command -v ')?args[1].slice(11):null;
 if(lookup!==null)return {status:lookup==='wsb'?0:1,stdout:lookup==='wsb'?fixture+'\\n':'',stderr:''};
 return command===fixture?sync(process.execPath,[fixture,...args],options):sync(command,args,options);
};
const spawn=cp.spawn;cp.spawn=function(command,args=[],options){return command===fixture?spawn(process.execPath,[fixture,...args],options):spawn(command,args,options)};
require('node:module').syncBuiltinESMExports();`);
        chmodSync(wsbPath, 0o755);

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                ...deviceLabTestHomeEnvironment(homeDir),
                PATH: binDir,
                NODE_ENV: "test",
                NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
                FAKE_WINDOWS_LOG: logPath,
                FAKE_WINDOWS_FAIL_STOP: failStopPath,
                FAKE_WINDOWS_FAIL_EXISTING_LOGIN: failExistingLoginPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-windows-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
        installDefaultImplicitBroker(client, false);
    }, TIMEOUT);

    afterEach(async () => {
        for (const responder of responders) clearInterval(responder);
        responders.clear();
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("extracts actual Windows Sandbox runtime ids from wsb list output", () => {
        expect(windowsSandboxSessionIdsFromListOutput(JSON.stringify({
            WindowsSandboxEnvironments: [{ Id: "F1756EF8-7226-4CA1-9A5E-484B21958B67" }],
        }))).toEqual(["f1756ef8-7226-4ca1-9a5e-484b21958b67"]);
    });

    it("detects newly-created Windows Sandbox runtime ids without adopting existing sessions", () => {
        expect(windowsSandboxRuntimeDelta([
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        ], [
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            "11111111-1111-4111-8111-111111111111",
        ])).toEqual(["33333333-3333-4333-8333-333333333333"]);
    });

    it("separates the guest process exit code from the wsb CLI exit code", () => {
        expect(windowsSandboxGuestProcessStatus({ status: 0, stdout: "The process completed (code: 0)." })).toBe(0);
        expect(windowsSandboxGuestProcessStatus({ status: 0, stdout: "garbled output (result: 1)." })).toBe(1);
        expect(windowsSandboxGuestProcessStatus({ status: 0, stdout: "Process completed with exit code 7" })).toBe(7);
        expect(windowsSandboxGuestProcessStatus({ status: 0, stdout: "no guest status" })).toBeNull();
    });

    it("keeps the packaged Windows helper asset synchronized with the backend generator", () => {
        const generated = windowsHelperScript({
            guestInboxDir: "C:\\ccc\\scratch\\inbox",
            guestOutboxDir: "C:\\ccc\\scratch\\outbox",
            guestUploadsDir: "C:\\ccc\\scratch\\uploads",
            guestDownloadsDir: "C:\\ccc\\scratch\\downloads",
        });
        const asset = readFileSync(join(repoRoot, "packages", "device-lab", "providers", "backends", "windows-helper.ps1"), "utf-8");
        expect(asset).toBe(generated);
    });

    it("builds a hidden start-bounded watchdog for a directly launched Sandbox connection", () => {
        const startedAfter = "2026-07-13T16:30:00.000Z";
        const cancelPath = "C:\\Users\\TestUser\\.ccc\\devices\\owners\\owner\\windows\\win\\downloads\\ccc-minimize-watchdog.cancel";
        const resultPath = "C:\\Users\\TestUser\\.ccc\\devices\\owners\\owner\\windows\\win\\downloads\\ccc-minimize-watchdog.result.txt";
        const args = windowsReadyMinimizeWatchdogArgs(startedAfter, cancelPath, 180000, [101, 202], resultPath);
        expect(args.slice(0, 5)).toEqual(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass"]);
        const encoded = args.at(-1);
        expect(typeof encoded).toBe("string");
        const script = Buffer.from(encoded as string, "base64").toString("utf16le");
        expect(script).toContain(`$StartedAfter = [DateTime]::Parse('${startedAfter}').ToUniversalTime()`);
        expect(script).toContain("$HasBaselineSnapshot = $true");
        expect(script).toContain("$BaselineHandles = @(101,202)");
        expect(script).toContain("-not ($BaselineHandles -contains $Handle)");
        expect(script).not.toContain("$ReadyMarkerPath");
        expect(script).toContain("ShowWindowAsync");
        expect(script).toContain("[IntPtr]$Handle, 6");
        expect(script).toContain("Windows Sandbox");
        expect(script).toContain("WindowsSandbox|wsb");
        expect(script).toContain(`$CancelPath = '${cancelPath}'`);
        expect(script).toContain(`$ResultPath = '${resultPath}'`);
        expect(script).toContain("Set-Content -LiteralPath $ResultPath -Value 'minimized'");
        expect(script).toContain("Set-Content -LiteralPath $ResultPath -Value 'not-minimized'");
        expect(script).toContain("$Continuous = $false");
        expect(script).toContain("-not $CancelPath -or -not (Test-Path -LiteralPath $CancelPath)");
        expect(script).toContain("AddMilliseconds(180000)");
    });

    it("builds a hidden .wsb config launcher for the real interactive start path", () => {
        const configPath = "C:\\Users\\TestUser\\.ccc\\devices\\owners\\owner\\windows\\win\\win.wsb";
        const args = windowsWsbConfigLaunchArgs(configPath);
        expect(args.slice(0, 5)).toEqual(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass"]);
        const encoded = args.at(-1);
        expect(typeof encoded).toBe("string");
        const script = Buffer.from(encoded as string, "base64").toString("utf16le");
        expect(script).toContain(`$ConfigPath = '${configPath}'`);
        expect(script).toContain("ShellExecute($ConfigPath, '', '', 'open', 7)");
        expect(script).not.toContain("-WindowStyle Normal");
        const visible = Buffer.from(windowsWsbConfigLaunchArgs(configPath, false).at(-1) as string, "base64").toString("utf16le");
        expect(visible).toContain("Start-Process -FilePath $ConfigPath -WindowStyle Normal");
        expect(visible).not.toContain("ShellExecute");
        expect(script).not.toContain("$ReadyMarkerPath");
        expect(script).not.toContain("ShowWindowAsync");
        expect(script).not.toContain("wsb start");
    });

    it("builds a cancellable one-shot minimize watchdog for late-raising Sandbox windows", () => {
        const cancelPath = "C:\\watchdog.cancel";
        const args = windowsSandboxMinimizeWatchdogArgs(12345, cancelPath);
        expect(args.slice(0, 5)).toEqual(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass"]);
        const encoded = args.at(-1);
        expect(typeof encoded).toBe("string");
        const script = Buffer.from(encoded as string, "base64").toString("utf16le");
        expect(script).toContain("$Continuous = $false");
        expect(script).toContain(`$CancelPath = '${cancelPath}'`);
        expect(script).toContain("AddMilliseconds(12345)");
        expect(script).toContain("ShowWindowAsync");
        expect(script).toContain("Start-Sleep -Milliseconds 250");
        expect(script).toContain("WindowsSandbox|wsb");
        expect(script).toContain("$HasBaselineSnapshot = $false");
        expect(script).toContain("$NewProcess = (-not $HasBaselineSnapshot) -and $_.StartTime.ToUniversalTime() -ge $StartedAfter");
    });

    it("cleans direct-backend minimize watchdogs with an owner-scoped cancellation marker", () => {
        const cancelled: string[] = [];
        const cleanup = cleanupWindowsSandboxMinimizeWatchdogs({
            id: "windows-test",
            minimizeWatchdogLaunch: { pid: 1234, processOwner: "device-lab-mcp" },
            helperSessionLaunch: { pid: 5678, minimizeWatchdogPid: 1234 },
        }, (cancelPath: string) => {
            cancelled.push(cancelPath);
            return { attempted: true, ok: true, cancelPath };
        });

        expect(cleanup.ok).toBe(true);
        expect(cleanup.changed).toBe(true);
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]).toContain("windows-test");
        expect(cancelled[0]).toContain("ccc-minimize-watchdog.cancel");
        expect(cleanup.device).toEqual(expect.objectContaining({
            minimizeWatchdogLaunch: null,
            helperSessionLaunch: expect.objectContaining({ pid: 5678, minimizeWatchdogPid: null }),
        }));
    });

    it("preserves watchdog metadata when direct-backend cleanup cannot terminate it", () => {
        const device = {
            id: "windows-test",
            minimizeWatchdogLaunch: { pid: 4321, processOwner: "device-lab-mcp" },
        };
        const cleanup = cleanupWindowsSandboxMinimizeWatchdogs(device, (cancelPath: string) => ({
            attempted: true,
            ok: false,
            cancelPath,
            error: "access denied",
        }));

        expect(cleanup).toEqual(expect.objectContaining({ ok: false, changed: false, device }));
    });

    it("writes owner-scoped Windows Sandbox config with helper bootstrap only on explicit start", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win Helper",
                networking: false,
                clipboard: false,
                vgpu: false,
                memoryMb: 2048,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; helper: { scratchDir: string; toolsDir: string; hostHelperScript: string; bootstrapReadyMarkerPath: string; bootstrapPhasePath: string } };
        };
        expect(created.device.deviceId).toBe("windows-win-helper");
        expect(created.device).toEqual(expect.objectContaining({ minimized: true }));
        expect(created.device.helper.scratchDir).toContain("windows-win-helper");
        writeFileSync(created.device.helper.bootstrapReadyMarkerPath, "stale previous boot");
        writeFileSync(created.device.helper.bootstrapPhasePath, "stale phase");
        writeFileSync(`${created.device.helper.bootstrapPhasePath}.tmp`, "stale temporary phase");

        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("wsb start");
        const inventory = await client.callTool({
            name: "devices",
            arguments: { view: "available", backend: "windows-sandbox" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ deviceId: string; helper: { scratchDir: string }; configPath: string }>;
            discovery: { available: boolean; wsb: string };
            hostSandboxes: { lazy: boolean; provider: string };
        };
        expect(inventoryPayload.discovery.available).toBe(true);
        expect(inventoryPayload.hostSandboxes).toEqual(expect.objectContaining({ lazy: true, provider: "wsb" }));
        expect(inventoryPayload.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({
                deviceId: "windows-win-helper",
                helper: expect.objectContaining({ scratchDir: expect.stringContaining("windows-win-helper") }),
                configPath: expect.stringContaining("windows-win-helper.wsb"),
            }),
        ]));
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("wsb start");

        const start = await client.callTool({
            name: "start",
            arguments: { waitForBoot: false, deviceId: "windows-win-helper" },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: {
                configPath: string;
                helper: {
                    hostHelperScript: string;
                    hostBootstrapScript: string;
                    hostBootstrapLauncherScript: string;
                    inboxDir: string;
                    outboxDir: string;
                    downloadsDir: string;
                };
            };
        };
        const config = readFileSync(started.device.configPath, "utf-8");
        expect(config).not.toContain("<SandboxFolder>C:\\ccc\\scratch</SandboxFolder>");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch\\inbox</SandboxFolder>");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch\\outbox</SandboxFolder>");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch\\uploads</SandboxFolder>");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch\\downloads</SandboxFolder>");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\tools</SandboxFolder>");
        expect(config.match(/<MappedFolder>/g)).toHaveLength(5);
        expect(config.match(/<ReadOnly>false<\/ReadOnly>/g)).toHaveLength(4);
        expect(config.match(/<ReadOnly>true<\/ReadOnly>/g)).toHaveLength(1);
        expect(config).toContain("<ReadOnly>true</ReadOnly>");
        expect(config).toContain("<LogonCommand>");
        expect(config).toContain("wscript.exe //B C:\\ccc\\tools\\ccc-guest-helper-bootstrap.vbs");
        expect(config).not.toContain("<Command>powershell.exe");
        const helperScript = readFileSync(started.device.helper.hostHelperScript, "utf-8");
        expect(helperScript).toContain("Get-ChildItem -Path $Inbox");
        expect(helperScript).toContain("ccc-guest-helper.ready.txt");
        expect(helperScript).toContain("ccc-guest-helper.heartbeat.txt");
        expect(helperScript).toContain("Write-CccHeartbeat");
        expect(helperScript).toContain("'exec'");
        expect(helperScript).toContain("Start-Job -ArgumentList $CommandText");
        expect(helperScript).toContain("Wait-Job -Job $Job -Timeout $TimeoutSec");
        expect(helperScript).toContain("Command timed out after $TimeoutSec seconds");
        expect(helperScript).toContain("function Write-CccJson");
        expect(helperScript).toContain("[System.Text.UTF8Encoding]::new($false)");
        expect(helperScript).toContain("$ResponseTempPath = $ResponsePath + '.tmp'");
        expect(helperScript).toContain("Write-CccJson -Path $ResponseTempPath -Value $Response");
        expect(helperScript).toContain("Move-Item -Force -Path $ResponseTempPath -Destination $ResponsePath");
        expect(helperScript).toContain("'screenshot'");
        expect(helperScript).toContain("'click'");
        expect(helperScript).toContain("'double_click'");
        expect(helperScript).toContain("'key'");
        expect(helperScript).toContain("'type'");
        expect(helperScript).toContain("'scroll'");
        expect(helperScript).toContain("'cursor_position'");
        expect(helperScript).toContain("'window_list'");
        expect(helperScript).toContain("'accessibility_snapshot'");
        expect(helperScript).toContain("UIAutomationClient");
        expect(helperScript).toContain("ControlViewWalker");
        expect(helperScript).toContain("ConvertTo-Json -Depth 32");
        expect(helperScript).toContain("'upload'");
        expect(helperScript).toContain("'download'");
        expect(existsSync(created.device.helper.bootstrapReadyMarkerPath)).toBe(false);
        expect(existsSync(created.device.helper.bootstrapPhasePath)).toBe(false);
        expect(existsSync(`${created.device.helper.bootstrapPhasePath}.tmp`)).toBe(false);
        const bootstrapScript = readFileSync(started.device.helper.hostBootstrapScript, "utf-8");
        expect(bootstrapScript).toContain("Copy-Item -Force -LiteralPath $ToolsHelper -Destination $ScratchHelper");
        expect(bootstrapScript).toContain("Start-Process -FilePath $PowerShellExe");
        expect(bootstrapScript).toContain("helper-pid");
        expect(bootstrapScript).toContain("$BootstrapStderrPath");
        expect(bootstrapScript).toContain("ccc-guest-helper-bootstrap.ready.txt");
        const bootstrapLauncherScript = readFileSync(started.device.helper.hostBootstrapLauncherScript, "utf-8");
        expect(bootstrapLauncherScript).toContain("WScript.Shell");
        expect(bootstrapLauncherScript).toContain("-WindowStyle Hidden");
        expect(bootstrapLauncherScript).toContain("ccc-guest-helper-bootstrap.ps1");
        const activeHelperScript = `${helperScript}\n# active Sandbox mapping`;
        writeFileSync(started.device.helper.hostHelperScript, activeHelperScript);
        const helperWorkspaceInodes = [
            started.device.helper.hostHelperScript,
            started.device.helper.hostBootstrapScript,
            started.device.helper.hostBootstrapLauncherScript,
        ].map((file) => lstatSync(file).ino);

        const log = await waitForLog(logPath, /wsb connect --id [0-9a-f-]{36}/);
        expect(log).toMatch(/wsb start --id [0-9a-f-]{36} --config/);
        expect(log).toMatch(/wsb connect --id [0-9a-f-]{36}/);
        expect(log).toContain("<Configuration>");

        let forceInactiveRecordStatus = false;
        let omitRecordStopArchive = false;
        let failRecordStop = false;
        const helperRequests: Array<Record<string, unknown>> = [];
        const responder = trackResponder(() => {
            let files: string[] = [];
            try {
                files = readdirSync(started.device.helper.inboxDir).filter((name) => name.endsWith(".json"));
            } catch {
                return;
            }
            for (const file of files) {
                const requestPath = join(started.device.helper.inboxDir, file);
                const request = JSON.parse(readFileSync(requestPath, "utf-8")) as {
                    id: string;
                    type: string;
                    command?: string;
                    remotePath?: string;
                    sessionId?: string;
                    timeLimitSec?: number;
                    x?: number;
                    y?: number;
                    button?: string;
                    key?: string;
                    keys?: string;
                    text?: string;
                    direction?: string;
                    amount?: number;
                    maxDepth?: number;
                    maxNodes?: number;
                };
                helperRequests.push(request as unknown as Record<string, unknown>);
                const response: Record<string, unknown> = { id: request.id, ok: true, type: request.type };
                if (request.type === "exec") {
                    response.stdout = `ran ${request.command}`;
                    response.stderr = "";
                    response.status = 0;
                    if (request.command === "mismatched-response") response.id = "foreign-request-id";
                    if (request.command === "oversized-response") response.padding = "x".repeat(2 * 1024 * 1024);
                }
                if (request.type === "screenshot") {
                    const imageName = `${request.id}.png`;
                    writeFileSync(join(started.device.helper.downloadsDir, imageName), "fakepng");
                    const externalImagePath = join(homeDir, `external-${imageName}`);
                    writeFileSync(externalImagePath, "host-secret-image");
                    response.imagePath = `C:\\ccc\\scratch\\downloads\\${imageName}`;
                    response.hostImagePath = externalImagePath;
                }
                if (request.type === "click") {
                    response.clicked = { x: request.x, y: request.y, button: request.button };
                }
                if (request.type === "double_click") {
                    response.doubleClicked = { x: request.x, y: request.y, button: request.button };
                }
                if (request.type === "key") {
                    response.key = { key: request.key, keys: request.keys };
                }
                if (request.type === "type") {
                    response.typed = { text: request.text, keys: request.keys };
                }
                if (request.type === "scroll") {
                    response.scrolled = { x: request.x, y: request.y, direction: request.direction, amount: request.amount };
                }
                if (request.type === "cursor_position") {
                    response.cursor = { x: 11, y: 22 };
                }
                if (request.type === "window_list") {
                    response.provider = "windows-process-main-window";
                    response.windows = [
                        { processId: 101, processName: "notepad", title: "notes.txt - Notepad", handle: "1234" },
                    ];
                }
                if (request.type === "accessibility_snapshot") {
                    response.accessibility = {
                        provider: "windows-uiautomation",
                        maxDepth: request.maxDepth,
                        maxNodes: request.maxNodes,
                        nodeCount: 2,
                        root: {
                            name: "Desktop",
                            controlType: "ControlType.Pane",
                            children: [
                                { name: "notes.txt - Notepad", controlType: "ControlType.Window", automationId: "", children: [] },
                            ],
                        },
                    };
                }
                if (request.type === "download") {
                    const remoteName = String(request.remotePath ?? "remote.txt").split(/[\\/]/).filter(Boolean).pop() ?? "remote.txt";
                    const downloadName = `${request.id}-${remoteName}`;
                    const downloadPath = join(started.device.helper.downloadsDir, downloadName);
                    writeFileSync(downloadPath, "downloaded");
                    if (remoteName === "oversized.bin") truncateSync(downloadPath, 2 * 1024 * 1024 * 1024 + 1);
                    const externalDownloadPath = join(homeDir, `external-${downloadName}`);
                    writeFileSync(externalDownloadPath, "host-secret-download");
                    response.downloadPath = `C:\\ccc\\scratch\\downloads\\${downloadName}`;
                    response.hostDownloadPath = externalDownloadPath;
                }
                if (request.type === "record_start") {
                    response.recording = {
                        sessionId: request.sessionId,
                        frameDir: `C:\\ccc\\scratch\\downloads\\${request.sessionId}-frames`,
                        timeLimitSec: request.timeLimitSec,
                        provider: "windows-helper-frame-archive",
                    };
                }
                if (request.type === "record_status") {
                    if (forceInactiveRecordStatus) {
                        const archiveName = `${request.sessionId}.zip`;
                        writeFileSync(join(started.device.helper.downloadsDir, archiveName), "boundedzip");
                        const externalArchivePath = join(homeDir, `external-status-${archiveName}`);
                        writeFileSync(externalArchivePath, "host-secret-status-archive");
                        response.recording = {
                            sessionId: request.sessionId,
                            active: false,
                            state: "Completed",
                            archivePath: `C:\\ccc\\scratch\\downloads\\${archiveName}`,
                            hostArchivePath: externalArchivePath,
                            provider: "windows-helper-frame-archive",
                        };
                    } else {
                        response.recording = {
                            sessionId: request.sessionId,
                            active: true,
                            state: "Running",
                            frameDir: `C:\\ccc\\scratch\\downloads\\${request.sessionId}-frames`,
                            provider: "windows-helper-frame-archive",
                        };
                    }
                }
                if (request.type === "record_stop") {
                    if (failRecordStop) {
                        response.ok = false;
                        response.error = "forced recording stop failure";
                    } else if (omitRecordStopArchive) {
                        response.recording = { sessionId: request.sessionId, active: false, provider: "windows-helper-frame-archive" };
                    } else {
                        const archiveName = `${request.id}.zip`;
                        writeFileSync(join(started.device.helper.downloadsDir, archiveName), "fakezip");
                        const externalArchivePath = join(homeDir, `external-stop-${archiveName}`);
                        writeFileSync(externalArchivePath, "host-secret-stop-archive");
                        response.recording = {
                            sessionId: request.id,
                            active: false,
                            archivePath: `C:\\ccc\\scratch\\downloads\\${archiveName}`,
                            hostArchivePath: externalArchivePath,
                            provider: "windows-helper-frame-archive",
                        };
                    }
                }
                writeFileSync(join(started.device.helper.outboxDir, `${request.id}.json`), JSON.stringify(response));
                rmSync(requestPath, { force: true });
            }
        }, 25);

        const exec = await client.callTool({
            name: "exec",
            arguments: { deviceId: "windows-win-helper", command: "whoami", timeoutMs: 1000 },
        });
        expect(exec.isError).not.toBe(true);
        expect(((exec.content as Array<{ text?: string }>)[0].text ?? "")).toContain("ran whoami");
        expect([
            started.device.helper.hostHelperScript,
            started.device.helper.hostBootstrapScript,
            started.device.helper.hostBootstrapLauncherScript,
        ].map((file) => lstatSync(file).ino)).toEqual(helperWorkspaceInodes);
        expect(readFileSync(started.device.helper.hostHelperScript, "utf-8")).toBe(activeHelperScript);
        const helperLaunchLog = await waitForLog(logPath, /wsb exec --id [0-9a-f-]{36}/);
        expect(helperLaunchLog).toMatch(/wsb connect --id [0-9a-f-]{36}/);
        expect(helperLaunchLog).toMatch(/wsb exec --id [0-9a-f-]{36} --command powershell\.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\\ccc\\tools\\ccc-guest-helper-bootstrap\.ps1 --run-as ExistingLogin/);

        const screenshot = await client.callTool({
            name: "screenshot",
            arguments: { deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(screenshot.isError).not.toBe(true);
        const screenshotContent = (screenshot.content as Array<{ type: string; data?: string }>)[0];
        expect(screenshotContent.type).toBe("image");
        expect(Buffer.from(screenshotContent.data || "", "base64").toString("utf8")).toBe("fakepng");

        const mismatchedResponse = await client.callTool({
            name: "exec",
            arguments: { deviceId: "windows-win-helper", command: "mismatched-response", timeoutMs: 2000 },
        });
        expect(mismatchedResponse.isError).toBe(true);
        expect((mismatchedResponse.content as Array<{ text?: string }>)[0].text).toContain("response id or type mismatch");

        const oversizedResponse = await client.callTool({
            name: "exec",
            arguments: { deviceId: "windows-win-helper", command: "oversized-response", timeoutMs: 2000 },
        });
        expect(oversizedResponse.isError).toBe(true);
        expect((oversizedResponse.content as Array<{ text?: string }>)[0].text).toContain("windows-helper-response-file-too-large");

        const click = await client.callTool({
            name: "click",
            arguments: { deviceId: "windows-win-helper", x: 25, y: 40, button: "right", timeoutMs: 1000 },
        });
        expect(click.isError).not.toBe(true);
        expect(JSON.parse(((click.content as Array<{ text?: string }>)[0].text ?? "{}")).clicked).toEqual({
            x: 25,
            y: 40,
            button: "right",
        });

        const doubleClick = await client.callTool({
            name: "click",
            arguments: { count: 2, deviceId: "windows-win-helper", x: 30, y: 50, timeoutMs: 1000 },
        });
        expect(doubleClick.isError).not.toBe(true);
        expect(JSON.parse(((doubleClick.content as Array<{ text?: string }>)[0].text ?? "{}")).doubleClicked).toEqual({
            x: 30,
            y: 50,
            button: "left",
        });

        const key = await client.callTool({
            name: "key",
            arguments: { deviceId: "windows-win-helper", key: "Control+A", timeoutMs: 1000 },
        });
        expect(key.isError).not.toBe(true);
        expect(JSON.parse(((key.content as Array<{ text?: string }>)[0].text ?? "{}")).key).toEqual({
            key: "Control+A",
            keys: "^a",
        });

        const type = await client.callTool({
            name: "type",
            arguments: { deviceId: "windows-win-helper", text: "hello from ccc", timeoutMs: 1000 },
        });
        expect(type.isError).not.toBe(true);
        expect(JSON.parse(((type.content as Array<{ text?: string }>)[0].text ?? "{}")).typed).toEqual({
            text: "hello from ccc",
            keys: "hello from ccc",
        });

        const literalType = await client.callTool({
            name: "type",
            arguments: { deviceId: "windows-win-helper", text: "a+b {ok} 50% [x] (y) ~ ^", timeoutMs: 1000 },
        });
        expect(literalType.isError).not.toBe(true);
        expect(JSON.parse(((literalType.content as Array<{ text?: string }>)[0].text ?? "{}")).typed).toEqual({
            text: "a+b {ok} 50% [x] (y) ~ ^",
            keys: "a{+}b {{}ok{}} 50{%} {[}x{]} {(}y{)} {~} {^}",
        });

        const scroll = await client.callTool({
            name: "scroll",
            arguments: { deviceId: "windows-win-helper", x: 10, y: 20, direction: "down", amount: 3, timeoutMs: 1000 },
        });
        expect(scroll.isError).not.toBe(true);
        expect(JSON.parse(((scroll.content as Array<{ text?: string }>)[0].text ?? "{}")).scrolled).toEqual({
            x: 10,
            y: 20,
            direction: "down",
            amount: 3,
        });

        const cursor = await client.callTool({
            name: "cursor_position",
            arguments: { deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(cursor.isError).not.toBe(true);
        expect(JSON.parse(((cursor.content as Array<{ text?: string }>)[0].text ?? "{}")).cursor).toEqual({ x: 11, y: 22 });

        const windows = await client.callTool({
            name: "window_list",
            arguments: { deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(windows.isError).not.toBe(true);
        expect(JSON.parse(((windows.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "windows-process-main-window",
            windows: [expect.objectContaining({ processName: "notepad", title: "notes.txt - Notepad" })],
        }));

        const accessibility = await client.callTool({
            name: "ui",
            arguments: { deviceId: "windows-win-helper", maxDepth: 99, maxNodes: 5000, timeoutMs: 1000 },
        });
        expect(accessibility.isError).not.toBe(true);
        const accessibilityPayload = JSON.parse(((accessibility.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            accessibility: { maxDepth: number; maxNodes: number; nodeCount: number; root: { name: string; children: Array<{ name: string }> } };
        };
        expect(accessibilityPayload.provider).toBe("windows-uiautomation");
        expect(accessibilityPayload.accessibility).toEqual(expect.objectContaining({
            maxDepth: 8,
            maxNodes: 1000,
            nodeCount: 2,
        }));
        expect(accessibilityPayload.accessibility.root.children[0].name).toBe("notes.txt - Notepad");

        const uploadSource = join(homeDir, "upload.txt");
        writeFileSync(uploadSource, "upload");
        const upload = await client.callTool({
            name: "upload",
            arguments: { deviceId: "windows-win-helper", localPath: uploadSource, remotePath: "C:\\Users\\WDAGUtilityAccount\\upload.txt", timeoutMs: 1000 },
        });
        expect(upload.isError).not.toBe(true);
        expect(JSON.parse(((upload.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "windows-helper",
            uploaded: expect.objectContaining({
                localPath: uploadSource,
                remotePath: "C:\\Users\\WDAGUtilityAccount\\upload.txt",
            }),
        }));
        expect(readdirSync(started.device.helper.uploadsDir)).toEqual([]);

        const downloadTarget = join(homeDir, "download.txt");
        const download = await client.callTool({
            name: "download",
            arguments: { deviceId: "windows-win-helper", remotePath: "C:\\Users\\WDAGUtilityAccount\\remote.txt", localPath: downloadTarget, timeoutMs: 1000 },
        });
        expect(download.isError).not.toBe(true);
        expect(JSON.parse(((download.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "windows-helper",
            downloaded: expect.objectContaining({
                remotePath: "C:\\Users\\WDAGUtilityAccount\\remote.txt",
                localPath: downloadTarget,
            }),
        }));
        expect(readFileSync(downloadTarget, "utf-8")).toBe("downloaded");

        const oversizedDownloadTarget = join(homeDir, "oversized-download.bin");
        writeFileSync(oversizedDownloadTarget, "preserved");
        const oversizedDownload = await client.callTool({
            name: "download",
            arguments: { deviceId: "windows-win-helper", remotePath: "C:\\Users\\WDAGUtilityAccount\\oversized.bin", localPath: oversizedDownloadTarget, timeoutMs: 1000 },
        });
        expect(oversizedDownload.isError).toBe(true);
        expect((oversizedDownload.content as Array<{ text?: string }>)[0].text).toContain("windows-helper-download-file-too-large");
        expect(readFileSync(oversizedDownloadTarget, "utf8")).toBe("preserved");

        const helperRequestCount = helperRequests.length;
        const rejectedHelperUpload = await client.callTool({
            name: "upload",
            arguments: { deviceId: "windows-win-helper", localPath: uploadSource, remotePath: "C:\\ccc\\scratch\\inbox\\evil.txt", timeoutMs: 1000 },
        });
        expect(rejectedHelperUpload.isError).toBe(true);
        expect((rejectedHelperUpload.content as Array<{ text?: string }>)[0].text).toContain("upload-remote-path-helper-path-rejected");
        const rejectedNamespaceUpload = await client.callTool({
            name: "upload",
            arguments: { deviceId: "windows-win-helper", localPath: uploadSource, remotePath: "\\\\?\\C:\\ccc\\scratch\\inbox\\evil.txt", timeoutMs: 1000 },
        });
        expect(rejectedNamespaceUpload.isError).toBe(true);
        expect((rejectedNamespaceUpload.content as Array<{ text?: string }>)[0].text).toContain("upload-remote-path-device-namespace-rejected");
        const rejectedTraversalDownload = await client.callTool({
            name: "download",
            arguments: { deviceId: "windows-win-helper", remotePath: "C:\\Users\\WDAGUtilityAccount\\..\\escape.txt", localPath: join(homeDir, "bad-download.txt"), timeoutMs: 1000 },
        });
        expect(rejectedTraversalDownload.isError).toBe(true);
        expect((rejectedTraversalDownload.content as Array<{ text?: string }>)[0].text).toContain("download-remote-path-traversal-rejected");
        expect(helperRequests).toHaveLength(helperRequestCount);

        const recordStart = await client.callTool({
            name: "record_video",
            arguments: { action: "start", deviceId: "windows-win-helper", localPath: join(homeDir, "windows-recording.zip"), timeLimitSec: 2, timeoutMs: 1000 },
        });
        expect(recordStart.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string; runtimeId: string; localPath: string };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "windows-helper-frame-archive",
            runtimeId: expect.any(String),
            localPath: join(homeDir, "windows-recording.zip"),
            timeLimitSec: 2,
        }));

        const duplicateRecordStart = await client.callTool({
            name: "record_video",
            arguments: { action: "start", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(duplicateRecordStart.isError).toBe(true);
        expect((duplicateRecordStart.content as Array<{ text?: string }>)[0].text).toContain("Windows Sandbox recording already active");

        const invalidRecordStop = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "windows-win-helper", localPath: join(homeDir, ".env"), timeoutMs: 1000 },
        });
        expect(invalidRecordStop.isError).toBe(true);
        expect((invalidRecordStop.content as Array<{ text?: string }>)[0].text).toContain("recording-local-path-secret-looking-file");

        const activeRecordStatus = await client.callTool({
            name: "record_video",
            arguments: { action: "status", deviceId: "windows-win-helper" },
        });
        expect(activeRecordStatus.isError).not.toBe(true);
        expect(JSON.parse(((activeRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: true,
            provider: "windows-helper-frame-archive",
        }));

        const recordStop = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(recordStop.isError).not.toBe(true);
        const recordStopPayload = JSON.parse(((recordStop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; localPath: string };
            device: { recording: unknown };
        };
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            localPath: join(homeDir, "windows-recording.zip"),
        }));
        expect(recordStopPayload.device.recording).toBeNull();
        expect(readFileSync(join(homeDir, "windows-recording.zip"), "utf-8")).toBe("fakezip");

        const stopWithoutRecording = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(stopWithoutRecording.isError).toBe(true);
        expect((stopWithoutRecording.content as Array<{ text?: string }>)[0].text).toContain("No Windows Sandbox recording active");

        const failedStopRecordingPath = join(homeDir, "failed-stop-windows-recording.zip");
        const failedStopRecordStart = await client.callTool({
            name: "record_video",
            arguments: { action: "start", deviceId: "windows-win-helper", localPath: failedStopRecordingPath, timeoutMs: 1000 },
        });
        expect(failedStopRecordStart.isError).not.toBe(true);
        failRecordStop = true;
        const failedRecordStop = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(failedRecordStop.isError).toBe(true);
        expect((failedRecordStop.content as Array<{ text?: string }>)[0].text).toContain("recording state preserved for retry");
        const statusAfterFailedRecordStop = await client.callTool({
            name: "record_video",
            arguments: { action: "status", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(JSON.parse(((statusAfterFailedRecordStop.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({ active: true }));
        failRecordStop = false;
        const retriedFailedRecordStop = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(retriedFailedRecordStop.isError).not.toBe(true);
        expect(readFileSync(failedStopRecordingPath, "utf8")).toBe("fakezip");

        const retryRecordingPath = join(homeDir, "retry-windows-recording.zip");
        const retryRecordStart = await client.callTool({
            name: "record_video",
            arguments: { action: "start", deviceId: "windows-win-helper", localPath: retryRecordingPath, timeoutMs: 1000 },
        });
        expect(retryRecordStart.isError).not.toBe(true);
        writeFileSync(retryRecordingPath, "preserved");
        omitRecordStopArchive = true;
        const missingArchiveStop = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(missingArchiveStop.isError).toBe(true);
        expect((missingArchiveStop.content as Array<{ text?: string }>)[0].text).toContain("recording state preserved for retry");
        expect(readFileSync(retryRecordingPath, "utf8")).toBe("preserved");
        omitRecordStopArchive = false;
        const retriedArchiveStop = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(retriedArchiveStop.isError).not.toBe(true);
        expect(readFileSync(retryRecordingPath, "utf8")).toBe("fakezip");

        const boundedRecordStart = await client.callTool({
            name: "record_video",
            arguments: { action: "start", deviceId: "windows-win-helper", localPath: join(homeDir, "bounded-windows-recording.zip"), timeLimitSec: 1, timeoutMs: 1000 },
        });
        expect(boundedRecordStart.isError).not.toBe(true);
        forceInactiveRecordStatus = true;
        const inactiveRecordStatus = await client.callTool({
            name: "record_video",
            arguments: { action: "status", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(inactiveRecordStatus.isError).not.toBe(true);
        expect(JSON.parse(((inactiveRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();
        expect(readFileSync(join(homeDir, "bounded-windows-recording.zip"), "utf-8")).toBe("boundedzip");
        const restartAfterInactiveStatus = await client.callTool({
            name: "record_video",
            arguments: { action: "start", deviceId: "windows-win-helper", localPath: join(homeDir, "restart-windows-recording.zip"), timeoutMs: 1000 },
        });
        expect(restartAfterInactiveStatus.isError).not.toBe(true);
        forceInactiveRecordStatus = false;
        const restartStop = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "windows-win-helper", timeoutMs: 1000 },
        });
        expect(restartStop.isError).not.toBe(true);
        clearInterval(responder);

        const stop = await client.callTool({
            name: "stop",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(stop.isError).not.toBe(true);

        expect(helperRequests).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "exec", command: "whoami" }),
            expect.objectContaining({ type: "screenshot" }),
            expect.objectContaining({ type: "click", x: 25, y: 40, button: "right" }),
            expect.objectContaining({ type: "double_click", x: 30, y: 50, button: "left" }),
            expect.objectContaining({ type: "key", key: "Control+A", keys: "^a" }),
            expect.objectContaining({ type: "type", text: "hello from ccc", keys: "hello from ccc" }),
            expect.objectContaining({ type: "type", text: "a+b {ok} 50% [x] (y) ~ ^", keys: "a{+}b {{}ok{}} 50{%} {[}x{]} {(}y{)} {~} {^}" }),
            expect.objectContaining({ type: "scroll", x: 10, y: 20, direction: "down", amount: 3 }),
            expect.objectContaining({ type: "cursor_position" }),
            expect.objectContaining({ type: "window_list" }),
            expect.objectContaining({ type: "accessibility_snapshot", maxDepth: 8, maxNodes: 1000 }),
            expect.objectContaining({
                type: "upload",
                uploadPath: expect.stringMatching(/^C:\\ccc\\scratch\\uploads\\[0-9a-f-]+-upload\.txt$/),
                remotePath: "C:\\Users\\WDAGUtilityAccount\\upload.txt",
            }),
            expect.objectContaining({
                type: "download",
                remotePath: "C:\\Users\\WDAGUtilityAccount\\remote.txt",
            }),
            expect.objectContaining({
                type: "record_start",
                sessionId: expect.stringMatching(/^recording-[0-9a-f-]+$/),
                intervalMs: 500,
                timeLimitSec: 2,
            }),
            expect.objectContaining({
                type: "record_status",
                sessionId: expect.stringMatching(/^recording-[0-9a-f-]+$/),
            }),
            expect.objectContaining({
                type: "record_stop",
                sessionId: expect.stringMatching(/^recording-[0-9a-f-]+$/),
            }),
        ]));
    });

    it("preserves a recording whose destination was replaced by a file link", { timeout: TIMEOUT }, async (testContext) => {
        const target = join(homeDir, "record-link-target.zip"), probe = join(homeDir, "record-link-probe.zip");
        writeFileSync(target, "do-not-overwrite");
        fileSymlinkOrSkip(testContext, target, probe);
        rmSync(probe);
        const deviceId = "windows-record-link";
        const create = await client.callTool({ name: "create_windows_sandbox", arguments: { name: "Record Link", deviceId } });
        expect(create.isError).not.toBe(true);
        const start = await client.callTool({ name: "start", arguments: { deviceId, waitForBoot: false } });
        expect(start.isError).not.toBe(true);
        const helper = JSON.parse((start.content as Array<{text: string}>)[0].text).device.helper as { inboxDir: string; outboxDir: string; downloadsDir: string };
        const destination = join(homeDir, "record-link.zip");
        const responder = trackResponder(() => {
            for (const file of readdirSync(helper.inboxDir).filter(name => name.endsWith(".json"))) {
                const requestPath = join(helper.inboxDir, file);
                const request = JSON.parse(readFileSync(requestPath, "utf8"));
                const recording: Record<string, unknown> = { sessionId: request.sessionId, provider: "windows-helper-frame-archive" };
                if (request.type === "record_start") {
                    recording.frameDir = `C:\\ccc\\scratch\\downloads\\${request.sessionId}-frames`;
                } else {
                    const archive = `${request.type === "record_status" ? request.sessionId : request.id}.zip`;
                    writeFileSync(join(helper.downloadsDir, archive), "fakezip");
                    Object.assign(recording, { active: false, state: "Completed", archivePath: `C:\\ccc\\scratch\\downloads\\${archive}` });
                }
                writeFileSync(join(helper.outboxDir, `${request.id}.json`), JSON.stringify({ id: request.id, type: request.type, ok: true, recording }));
                rmSync(requestPath, { force: true });
            }
        }, 25);
        try {
            const recording = await client.callTool({ name: "record_video", arguments: { action: "start", deviceId, localPath: destination, timeoutMs: 1000 } });
            expect(recording.isError).not.toBe(true);
            fileSymlinkOrSkip(testContext, target, destination);
            const status = await client.callTool({ name: "record_video", arguments: { action: "status", deviceId, timeoutMs: 1000 } });
            expect(status.isError).not.toBe(true);
            const payload = JSON.parse((status.content as Array<{text: string}>)[0].text);
            expect(payload.helper).toContain("recording-local-path-symlink-rejected");
            expect(payload.recording).toMatchObject({ active: true });
            expect(readFileSync(target, "utf8")).toBe("do-not-overwrite");
            rmSync(destination);
            const stop = await client.callTool({ name: "record_video", arguments: { action: "stop", deviceId, timeoutMs: 1000 } });
            expect(stop.isError).not.toBe(true);
            expect(readFileSync(destination, "utf8")).toBe("fakezip");
        } finally {
            clearInterval(responder);
            await client.callTool({ name: "stop", arguments: { deviceId } });
        }
    });

    it("cleans Windows Sandbox scratch on delete and preserves state when forced stop fails", { timeout: TIMEOUT }, async () => {
        const stoppedCreate = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win Delete Stopped",
                deviceId: "windows-delete-stopped",
            },
        });
        expect(stoppedCreate.isError).not.toBe(true);
        const stoppedCreated = JSON.parse(((stoppedCreate.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; helper: { scratchDir: string } };
        };
        expect(existsSync(stoppedCreated.device.helper.scratchDir)).toBe(true);

        const stoppedDelete = await client.callTool({
            name: "delete",
            arguments: { deviceId: "windows-delete-stopped", confirmDestructive: true },
        });
        expect(stoppedDelete.isError).not.toBe(true);
        expect(existsSync(stoppedCreated.device.helper.scratchDir)).toBe(false);

        const runningCreate = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win Delete Running",
                deviceId: "windows-delete-running",
            },
        });
        expect(runningCreate.isError).not.toBe(true);
        const runningCreated = JSON.parse(((runningCreate.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { scratchDir: string } };
        };
        const runningStart = await client.callTool({
            name: "start",
            arguments: { waitForBoot: false, deviceId: "windows-delete-running" },
        });
        expect(runningStart.isError).not.toBe(true);

        const logBeforeRefusal = await waitForStableLog(logPath);
        const runningDeleteRefused = await client.callTool({
            name: "delete",
            arguments: { deviceId: "windows-delete-running", confirmDestructive: true },
        });
        expect(runningDeleteRefused.isError).toBe(true);
        expect((runningDeleteRefused.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete windows-delete-running while status is running");
        expect(readFileSync(logPath, "utf-8")).toBe(logBeforeRefusal);
        expect(existsSync(runningCreated.device.helper.scratchDir)).toBe(true);
        const statusAfterRefusedDelete = await client.callTool({
            name: "status",
            arguments: { deviceId: "windows-delete-running" },
        });
        expect(statusAfterRefusedDelete.isError).not.toBe(true);
        expect(JSON.parse(((statusAfterRefusedDelete.content as Array<{ text?: string }>)[0].text ?? "{}")).device.status).toBe("running");

        const logBeforeForceDelete = readFileSync(logPath, "utf-8");
        const runningForceDelete = await client.callTool({
            name: "delete",
            arguments: { deviceId: "windows-delete-running", force: true, confirmDestructive: true },
        });
        expect(runningForceDelete.isError).not.toBe(true);
        const logAfterForceDelete = readFileSync(logPath, "utf-8");
        expect(logAfterForceDelete.slice(logBeforeForceDelete.length)).toMatch(/wsb stop --id [0-9a-f-]{36}/);
        expect(existsSync(runningCreated.device.helper.scratchDir)).toBe(false);
        const inventoryAfterDelete = await client.callTool({
            name: "devices",
            arguments: { view: "available", backend: "windows-sandbox" },
        });
        expect(inventoryAfterDelete.isError).not.toBe(true);
        const inventoryAfterDeletePayload = JSON.parse(((inventoryAfterDelete.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ deviceId: string }>;
        };
        expect(inventoryAfterDeletePayload.devices.some((device) => device.id === "windows-delete-running")).toBe(false);

        const failCreate = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win Delete Stop Failure",
                deviceId: "windows-delete-stop-failure",
            },
        });
        expect(failCreate.isError).not.toBe(true);
        const failCreated = JSON.parse(((failCreate.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { scratchDir: string } };
        };
        const failStart = await client.callTool({
            name: "start",
            arguments: { waitForBoot: false, deviceId: "windows-delete-stop-failure" },
        });
        expect(failStart.isError).not.toBe(true);

        writeFileSync(failStopPath, "fail");
        const failedForceDelete = await client.callTool({
            name: "delete",
            arguments: { deviceId: "windows-delete-stop-failure", force: true, confirmDestructive: true },
        });
        expect(failedForceDelete.isError).toBe(true);
        expect((failedForceDelete.content as Array<{ text?: string }>)[0].text).toContain("forced stop failure");
        expect(existsSync(failCreated.device.helper.scratchDir)).toBe(true);
        const statusAfterFailedDelete = await client.callTool({
            name: "status",
            arguments: { deviceId: "windows-delete-stop-failure" },
        });
        expect(statusAfterFailedDelete.isError).not.toBe(true);
        expect(JSON.parse(((statusAfterFailedDelete.content as Array<{ text?: string }>)[0].text ?? "{}")).device.status).toBe("running");

        rmSync(failStopPath, { force: true });
        const retryForceDelete = await client.callTool({
            name: "delete",
            arguments: { deviceId: "windows-delete-stop-failure", force: true, confirmDestructive: true },
        });
        expect(retryForceDelete.isError).not.toBe(true);
        expect(existsSync(failCreated.device.helper.scratchDir)).toBe(false);
    });

    it("reports an invalid Sandbox identity without exposing the device or helper paths", async () => {
        await client.callTool({ name: "create_windows_sandbox", arguments: { name: "No runtime", deviceId: "no-runtime" } });
        const probe = await client.callTool({ name: "cursor_position", arguments: { deviceId: "no-runtime", timeoutMs: 1000 } });
        const value = JSON.parse((probe.content as Array<{ text: string }>)[0].text);
        expect(probe.isError).toBe(true);
        expect(value).toEqual({ ok: false, error: "windows-sandbox-helper-failed", helperDiagnostic: { stage: "sandbox-id-invalid", readyMarkerPresent: false } });
        expect(JSON.stringify(value)).not.toContain(homeDir);
    });

    it("reports a rejected cursor response as a closed stage without guest exception text", async () => {
        const deviceId = "cursor-rejected";
        await client.callTool({ name: "create_windows_sandbox", arguments: { name: "Cursor rejected", deviceId } });
        const started = await client.callTool({ name: "start", arguments: { waitForBoot: false, deviceId } });
        const helper = JSON.parse((started.content as Array<{ text: string }>)[0].text).device.helper;
        writeFileSync(helper.readyMarkerPath, "ready");
        const responder = trackResponder(() => {
            for (const file of readdirSync(helper.inboxDir).filter(name => name.endsWith(".json"))) {
                const path = join(helper.inboxDir, file);
                const request = JSON.parse(readFileSync(path, "utf8"));
                writeFileSync(join(helper.outboxDir, file), JSON.stringify({ id: request.id, type: request.type, ok: false, error: "guest secret C:\\private\\file" }));
                rmSync(path, { force: true });
            }
        }, 10);
        try {
            const probe = await client.callTool({ name: "cursor_position", arguments: { deviceId, timeoutMs: 1000 } });
            const value = JSON.parse((probe.content as Array<{ text: string }>)[0].text);
            expect(probe.isError).toBe(true);
            expect(value).toEqual({ ok: false, error: "windows-sandbox-helper-response-rejected", helperDiagnostic: { stage: "response-rejected", readyMarkerPresent: true } });
            expect(JSON.stringify(value)).not.toMatch(/secret|private/);
        } finally {
            clearInterval(responder);
            await client.callTool({ name: "stop", arguments: { deviceId } });
        }
    });

    it("falls back to a one-shot helper request when the long-running helper does not answer", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win One Shot",
                deviceId: "windows-one-shot",
            },
        });
        expect(create.isError).not.toBe(true);

        let started = false;
        try {
            const start = await client.callTool({
                name: "start",
                arguments: { waitForBoot: false, deviceId: "windows-one-shot" },
            });
            expect(start.isError).not.toBe(true);
            const startedPayload = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                device: { helper: { inboxDir: string } };
            };
            started = true;

            const exec = await client.callTool({
                name: "exec",
                arguments: { deviceId: "windows-one-shot", command: "whoami", timeoutMs: 2000 },
            });
            expect(exec.isError).toBe(true);
            const text = (exec.content as Array<{ text?: string }>)[0].text ?? "";
            expect(text).toContain("Request exec fallback: attempted=true ok=true");
            expect(text).toContain("Inbox entries:");
            expect(text).toContain("Request file:");
            expect(text).toContain("Response file:");
            expect(text).toContain("Helper heartbeat:");

            const cursorProbe = await client.callTool({ name: "cursor_position", arguments: {
                deviceId: "windows-one-shot", timeoutMs: 2000,
            } });
            expect(cursorProbe.isError).toBe(true);
            const cursorFailure = JSON.parse((cursorProbe.content as Array<{ text: string }>)[0].text);
            expect(cursorFailure).toMatchObject({ error: "windows-sandbox-helper-timeout", helperDiagnostic: {
                stage: "response-timeout", logEvidence: { bootstrapStarted: false, bootstrapReady: false, helperHeartbeat: false, bootstrapStderr: "absent", helperStderr: "absent" }, readyMarkerPresent: expect.any(Boolean), bootstrapAttempted: expect.any(Boolean),
                bootstrapOk: expect.any(Boolean), requestAttempted: true, requestOk: true, responseParseFailed: false,
            } });
            expect(JSON.stringify(cursorFailure)).not.toContain(homeDir);
            expect(JSON.stringify(cursorFailure)).not.toMatch(/stdout|stderr|Inbox|command/);

            const log = await waitForLog(logPath, /-OnceRequestPath/);
            expect(log).toMatch(/wsb exec --id [0-9a-f-]{36} --command powershell\.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\\ccc\\scratch\\inbox\\[0-9a-f-]{36}\.json\.ps1/);
            expect(log).not.toContain("-WindowStyle Hidden -Command");
            expect(log).toContain("--run-as ExistingLogin");
            expect(readdirSync(startedPayload.device.helper.inboxDir).filter((name) => name.endsWith(".json") || name.endsWith(".json.ps1"))).toEqual([]);

            const uploadSource = join(homeDir, "one-shot-timeout-upload.txt");
            writeFileSync(uploadSource, "upload");
            const upload = await client.callTool({
                name: "upload",
                arguments: {
                    deviceId: "windows-one-shot",
                    localPath: uploadSource,
                    remotePath: "C:\\Users\\WDAGUtilityAccount\\late-upload.txt",
                    timeoutMs: 350,
                },
            });
            expect(upload.isError).toBe(true);
            expect(readdirSync(startedPayload.device.helper.inboxDir).filter((name) => name.endsWith(".json") || name.endsWith(".json.ps1"))).toEqual([]);
            const uploadsDir = join(dirname(startedPayload.device.helper.inboxDir), "uploads");
            expect(readdirSync(uploadsDir)).toEqual([]);

            const lateRequests: string[] = [];
            await new Promise((resolve) => setTimeout(resolve, 300));
            for (const name of readdirSync(startedPayload.device.helper.inboxDir)) {
                if (name.endsWith(".json")) lateRequests.push(name);
            }
            expect(lateRequests).toEqual([]);
        } finally {
            if (started) {
                await client.callTool({
                    name: "stop",
                    arguments: { deviceId: "windows-one-shot" },
                });
            }
            await client.callTool({
                name: "delete",
                arguments: { deviceId: "windows-one-shot", force: true, confirmDestructive: true },
            });
        }
    });

    it.each([undefined, { ok: false }])("recovers a missing or failed session launch while still requiring cursor readiness", { timeout: TIMEOUT }, async (helperSessionLaunch) => {
        const deviceId = "session-recovery";
        await client.callTool({ name: "create_windows_sandbox", arguments: { name: "Session recovery", deviceId } });
        await client.callTool({ name: "start", arguments: { waitForBoot: false, deviceId } });
        try {
            // start returns before its detached fixture child initializes. A quiet log
            // is not acknowledgement: observe that first connect before measuring recovery.
            const before = await waitForLog(logPath, /wsb connect --id [0-9a-f-]{36}/);
            expect((before.match(/wsb connect --id/g) || []).length).toBe(1);
            const statePath = windowsStatePath();
            const state = JSON.parse(readFileSync(statePath, "utf8"));
            state.devices.find((device: { id: string }) => device.id === deviceId).helperSessionLaunch = helperSessionLaunch;
            writeFileSync(statePath, JSON.stringify(state));
            const probe = await client.callTool({ name: "cursor_position", arguments: { deviceId, timeoutMs: 350 } });
            expect(probe.isError).toBe(true);
            const after = await waitForStableLog(logPath);
            expect((after.slice(before.length).match(/wsb connect --id/g) || []).length).toBe(1);
        } finally {
            await client.callTool({ name: "stop", arguments: { deviceId } });
        }
    });

    it("retries ExistingLogin without using invalid run-as modes when no Sandbox login session exists yet", { timeout: TIMEOUT }, async () => {
        writeFileSync(failExistingLoginPath, "fail");
        const logBefore = readFileSync(logPath, { encoding: "utf-8", flag: "a+" });
        const create = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win Existing Login Retry",
                deviceId: "windows-existing-login-retry",
            },
        });
        expect(create.isError).not.toBe(true);

        let started = false;
        try {
            const start = await client.callTool({
                name: "start",
                arguments: { waitForBoot: false, deviceId: "windows-existing-login-retry" },
            });
            expect(start.isError).not.toBe(true);
            started = true;

            const exec = await client.callTool({
                name: "exec",
                arguments: { deviceId: "windows-existing-login-retry", command: "whoami", timeoutMs: 350 },
            });
            expect(exec.isError).toBe(true);
            const text = (exec.content as Array<{ text?: string }>)[0].text ?? "";
            expect(text).toContain("Bootstrap exec attempts:");
            expect(text).not.toContain("visible connect fallback");
            expect(text).not.toContain("autoMinimizeAfterVisible");
            expect(text).toContain("runAs=ExistingLogin");

            expect(text).not.toContain("runAs=Default");
            expect(text).not.toContain("runAs=implicit");

            const log = readFileSync(logPath, "utf-8");
            const newLog = log.slice(logBefore.length);
            // Start already created the viewer; missing readiness and login failure must not reconnect.
            expect((newLog.match(/wsb connect --id/g) || []).length).toBe(1);
            expect((newLog.match(/--run-as ExistingLogin/g) || []).length).toBeGreaterThanOrEqual(1);
            expect(newLog).not.toContain("--run-as Default");
        } finally {
            rmSync(failExistingLoginPath, { force: true });
            if (started) {
                await client.callTool({
                    name: "stop",
                    arguments: { deviceId: "windows-existing-login-retry" },
                });
            }
            await client.callTool({
                name: "delete",
                arguments: { deviceId: "windows-existing-login-retry", force: true, confirmDestructive: true },
            });
        }
    });

    it("treats Windows Sandbox runtime as one host-wide instance", { timeout: TIMEOUT }, async () => {
        const firstCreate = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win Singleton One",
                deviceId: "windows-singleton-one",
            },
        });
        expect(firstCreate.isError).not.toBe(true);
        const secondCreate = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win Singleton Two",
                deviceId: "windows-singleton-two",
            },
        });
        expect(secondCreate.isError).not.toBe(true);

        const staleLockPath = join(homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(dirname(staleLockPath), { recursive: true });
        writeFileSync(staleLockPath, JSON.stringify({
            provider: "windows-sandbox",
            bootId: "previous-boot",
            ownerId: "foreign-owner",
            deviceId: "foreign-sandbox",
            sandboxId: "12345678-1234-4234-9234-1234567890ff",
        }));

        const firstStart = await client.callTool({
            name: "start",
            arguments: { waitForBoot: false, deviceId: "windows-singleton-one" },
        });
        expect(firstStart.isError).not.toBe(true);
        const firstLock = readFileSync(staleLockPath, "utf-8");
        const logBeforeDuplicateStart = readFileSync(logPath, { encoding: "utf-8", flag: "a+" });
        const duplicateFirstStart = await client.callTool({
            name: "start",
            arguments: { waitForBoot: false, deviceId: "windows-singleton-one" },
        });
        expect(duplicateFirstStart.isError).toBe(true);
        expect((duplicateFirstStart.content as Array<{ text?: string }>)[0].text).toContain("Refusing to start windows-singleton-one while status is running");
        expect(readFileSync(staleLockPath, "utf-8")).toBe(firstLock);
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).toBe(logBeforeDuplicateStart);

        const blockedSecondStart = await client.callTool({
            name: "start",
            arguments: { waitForBoot: false, deviceId: "windows-singleton-two" },
        });
        expect(blockedSecondStart.isError).toBe(true);
        expect((blockedSecondStart.content as Array<{ text?: string }>)[0].text).toContain("Windows Sandbox is already claimed on this host");

        const lockedInventory = await client.callTool({
            name: "devices",
            arguments: { view: "available", backend: "windows-sandbox" },
        });
        expect(lockedInventory.isError).not.toBe(true);
        const lockedPayload = JSON.parse(((lockedInventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            hostSandboxes: { singleton: boolean; lock: { deviceId: string } };
        };
        expect(lockedPayload.hostSandboxes.singleton).toBe(true);
        expect(lockedPayload.hostSandboxes.lock.deviceId).toBe("windows-singleton-one");

        const firstStop = await client.callTool({
            name: "stop",
            arguments: { deviceId: "windows-singleton-one" },
        });
        expect(firstStop.isError).not.toBe(true);

        const secondStart = await client.callTool({
            name: "start",
            arguments: { waitForBoot: false, deviceId: "windows-singleton-two" },
        });
        expect(secondStart.isError).not.toBe(true);

        const secondStop = await client.callTool({
            name: "stop",
            arguments: { deviceId: "windows-singleton-two" },
        });
        expect(secondStop.isError).not.toBe(true);
    });

    it.each(["start", "stop", "delete"])("preserves successor state and singleton ownership during superseded Windows Sandbox %s", { timeout: TIMEOUT }, async (operation) => {
        const inventory = await client.callTool({ name: "devices", arguments: { view: "available", backend: "windows-sandbox" } });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const deviceId = `windows-generation-${operation}-${Date.now()}`;
        const create = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {  name: `Windows ${operation} generation`, deviceId },
        });
        expect(create.isError).not.toBe(true);
        if (operation !== "start") {
            const start = await client.callTool({ name: "start", arguments: { waitForBoot: false, deviceId } });
            expect(start.isError).not.toBe(true);
        }

        const statePath = windowsStatePath();
        const aggregate = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> };
        const current = aggregate.devices.find((device) => device.id === deviceId);
        expect(current).toBeDefined();
        const successorClaimId = `successor-singleton-${operation}-${Date.now()}`;
        const successor = {
            ...current,
            status: operation === "start" ? "stopped" : "running",
            lifecycle: { runtimeId: `successor-lifecycle-${operation}`, operation: "successor", claimedAt: "2026-07-15T00:00:00.000Z" },
            ...(operation === "start" ? { singletonClaimId: null } : { singletonClaimId: successorClaimId }),
            successorMarker: `${operation}-preserve-exactly`,
            updatedAt: `successor-${operation}`,
        };
        let successorLock: Record<string, unknown> | undefined;
        if (operation !== "start") {
            const lockPath = join(homeDir, ".ccc", "devices", "host-locks", "windows-sandbox.json");
            const currentLock = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
            successorLock = {
                ...currentLock,
                provider: "windows-sandbox",
                ownerId,
                deviceId,
                sandboxId: current?.sandboxId,
                claimId: successorClaimId,
                updatedAt: "2026-07-15T00:00:00.000Z",
            };
        }
        armWindowsReplacement(operation === "start" ? "start" : "stop", statePath, successor, successorLock);

        const result = await client.callTool({
            name: operation === "start" ? "start" : operation === "stop" ? "stop" : "delete",
            arguments: operation === "delete"
                ? { deviceId, force: true, confirmDestructive: true }
                : { deviceId },
        });
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text?: string }>)[0].text).toContain("owner-device-state-conflict");
        expect(existsSync(join(homeDir, "fake-windows-replace-done"))).toBe(true);
        const after = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> };
        expect(after.devices.find((device) => device.id === deviceId)).toEqual(successor);
        if (successorLock) {
            const lockPath = join(homeDir, ".ccc", "devices", "host-locks", "windows-sandbox.json");
            expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual(successorLock);
        }

        disarmWindowsReplacement();
        if (operation !== "start") {
            const stop = await client.callTool({ name: "stop", arguments: { deviceId } });
            expect(stop.isError).not.toBe(true);
        }
        const cleanup = await client.callTool({
            name: "delete",
            arguments: { deviceId, force: true, confirmDestructive: true },
        });
        expect(cleanup.isError).not.toBe(true);
    });

    it("reclaims a missing singleton generation but refuses a foreign one before stop effects", { timeout: TIMEOUT }, async () => {
        const deviceId = `windows-singleton-recovery-${Date.now()}`;
        const lockPath = join(homeDir, ".ccc", "devices", "host-locks", "windows-sandbox.json");
        const create = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {  name: "Windows singleton recovery", deviceId },
        });
        expect(create.isError).not.toBe(true);
        const start = await client.callTool({ name: "start", arguments: { waitForBoot: false, deviceId } });
        expect(start.isError).not.toBe(true);
        rmSync(lockPath, { force: true });

        const recoveredStop = await client.callTool({ name: "stop", arguments: { deviceId } });
        expect(recoveredStop.isError).not.toBe(true);
        expect(existsSync(lockPath)).toBe(false);

        const restart = await client.callTool({ name: "start", arguments: { waitForBoot: false, deviceId } });
        expect(restart.isError).not.toBe(true);
        const restarted = JSON.parse(((restart.content as Array<{ text?: string }>)[0].text ?? "{}")) as { device: { sandboxId: string } };
        writeFileSync(lockPath, `${JSON.stringify({
            provider: "windows-sandbox",
            ownerId: "foreign-owner",
            deviceId: "foreign-device",
            sandboxId: restarted.device.sandboxId,
            claimId: "foreign-claim",
        }, null, 2)}\n`);
        const before = readFileSync(logPath, { encoding: "utf-8", flag: "a+" });
        const blockedStop = await client.callTool({ name: "stop", arguments: { deviceId } });
        expect(blockedStop.isError).toBe(true);
        expect((blockedStop.content as Array<{ text?: string }>)[0].text).toContain("already claimed on this host by owner foreign-owner");
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" }).slice(before.length)).not.toContain("wsb stop");
        const status = await client.callTool({ name: "status", arguments: { deviceId } });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { device: { status: string } };
        expect(statusPayload.device.status).toBe("running");

        rmSync(lockPath, { force: true });
        const stop = await client.callTool({ name: "stop", arguments: { deviceId } });
        expect(stop.isError).not.toBe(true);
        const cleanup = await client.callTool({
            name: "delete",
            arguments: { deviceId, confirmDestructive: true },
        });
        expect(cleanup.isError).not.toBe(true);
    });

    it("reconciles an interrupted stopped record from its matching singleton generation", { timeout: TIMEOUT }, async () => {
        const deviceId = `windows-stopped-runtime-recovery-${Date.now()}`;
        const create = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {  name: "Windows stopped runtime recovery", deviceId },
        });
        expect(create.isError).not.toBe(true);
        const start = await client.callTool({ name: "start", arguments: { waitForBoot: false, deviceId } });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as { device: { sandboxId: string } };

        const statePath = windowsStatePath();
        const state = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> };
        state.devices = state.devices.map((device) => device.id === deviceId
            ? { ...device, status: "stopped", sandboxId: undefined, singletonClaimId: undefined }
            : device);
        writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

        const before = readFileSync(logPath, { encoding: "utf-8", flag: "a+" });
        const stop = await client.callTool({ name: "stop", arguments: { deviceId } });
        expect(stop.isError, (stop.content as Array<{ text?: string }>)[0]?.text).not.toBe(true);
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" }).slice(before.length)).toContain(`wsb stop --id ${started.device.sandboxId}`);
        expect(existsSync(join(homeDir, ".ccc", "devices", "host-locks", "windows-sandbox.json"))).toBe(false);

        const cleanup = await client.callTool({
            name: "delete",
            arguments: { deviceId, confirmDestructive: true },
        });
        expect(cleanup.isError).not.toBe(true);
    });

    it("rejects malformed Windows Sandbox ownership state without replacing it", { timeout: TIMEOUT }, async () => {
        const lockPath = join(homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
        const create = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win Malformed Lock",
                deviceId: "windows-malformed-lock",
            },
        });
        expect(create.isError).not.toBe(true);
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, "{not-json");
        const logBefore = readFileSync(logPath, { encoding: "utf-8", flag: "a+" });

        try {
            await expect(client.callTool({
                name: "start",
                arguments: { waitForBoot: false, deviceId: "windows-malformed-lock" },
            })).rejects.toThrow("windows-sandbox-lock-state-invalid");
            expect(readFileSync(lockPath, "utf8")).toBe("{not-json");
            expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" }).slice(logBefore.length)).not.toContain("wsb start");
        } finally {
            rmSync(lockPath, { force: true });
            await client.callTool({
                name: "delete",
                arguments: { deviceId: "windows-malformed-lock", force: true, confirmDestructive: true },
            });
        }
    });
});


describe("Sandbox background launch and helper deadlines", () => {
    const helper = { guestBootstrapScript: "C:\\ccc\\tools\\bootstrap.ps1", readyMarkerPath: "/nonexistent-sandbox-bootstrap-marker" };
    const device = { sandboxId: "11111111-1111-4111-8111-111111111111", minimized: true };
    it("requests nonactivating minimized connect and preserves waited exit status", () => {
        const generated = Buffer.from(windowsMinimizedStartProcessArgs("C:\\Program Files\\wsb.exe", ["connect", "--id", device.sandboxId], false).at(-1) as string, "base64").toString("utf16le");
        expect(generated).toContain("ShellExecute($Executable, $Arguments, '', 'open', 7)");
        expect(generated).toContain("$Executable = 'C:\\Program Files\\wsb.exe'");
        expect(generated).toContain(`connect --id ${device.sandboxId}`);
        expect(generated).not.toContain("Start-Process");
        const waited = Buffer.from(windowsMinimizedStartProcessArgs("wsb.exe", ["stop"], true).at(-1) as string, "base64").toString("utf16le");
        expect(waited).toContain("-Wait -PassThru");
        expect(waited).toContain("exit $Process.ExitCode");
    });
    it.each([0, 1])("observes the background COM launcher exit (%s) within the remaining budget", status => {
        const runLauncher = vi.fn(() => ({ status }));
        const spawnSession = vi.fn();
        const result = launchWindowsSandboxSession("wsb.exe", device.sandboxId, true, 250, { platform: "win32", runLauncher, spawnSession });
        expect(runLauncher).toHaveBeenCalledWith("powershell.exe", expect.any(Array), 250);
        expect(spawnSession).not.toHaveBeenCalled();
        expect(result.ok).toBe(status === 0);
        if (status !== 0) expect(result.error).toBe("session-connect-launcher-failed");
    });
    it("never launches a connection after its budget and keeps explicit foreground mode available", () => {
        const runLauncher = vi.fn();
        const unref = vi.fn();
        const spawnSession = vi.fn(() => ({ pid: 42, unref }));
        const hooks = { platform: "win32", runLauncher, spawnSession };
        expect(launchWindowsSandboxSession("wsb.exe", device.sandboxId, true, 0, hooks).ok).toBe(false);
        expect(runLauncher).not.toHaveBeenCalled();
        expect(spawnSession).not.toHaveBeenCalled();
        expect(launchWindowsSandboxSession("wsb.exe", device.sandboxId, false, 250, hooks).ok).toBe(true);
        expect(spawnSession).toHaveBeenCalledWith("wsb.exe", ["connect", "--id", device.sandboxId], expect.objectContaining({ windowsHide: false }));
        expect(unref).toHaveBeenCalledOnce();
    });
    it("spends at most 75 percent of a short bootstrap budget without a one-second retry floor", async () => {
        let clock = 0;
        const execute = vi.fn((_wsb, _id, _command, timeout) => {
            expect(timeout).toBe(225);
            clock += timeout;
            return { ok: false, result: { error: { code: "ETIMEDOUT" } }, attempts: [] };
        });
        const result = await runWindowsHelperBootstrapFallback(device, helper, "wsb", 300, { now: () => clock, execute, wait: async (ms: number) => { clock += ms; } });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ attempted: true, ok: false, failure: "timeout", deadlineExhausted: true });
        expect(clock).toBe(225);
    });
    it.each([0, -10])("never launches bootstrap after a consumed budget (%s)", async timeout => {
        const execute = vi.fn();
        const result = await runWindowsHelperBootstrapFallback(device, helper, "wsb", timeout, { now: () => 100, execute });
        expect(execute).not.toHaveBeenCalled();
        expect(result).toMatchObject({ attempted: false, ok: false, failure: "timeout", deadlineExhausted: true });
    });
    it.each([["0x80070520 private-host", "login-unavailable"], ["private failure", "command-failed"]])("classifies failed bootstrap without exposing native text", async (stderr, failure) => {
        let clock = 0;
        const execute = vi.fn(() => ({ ok: false, result: { status: 1, stderr }, attempts: [] }));
        const result = await runWindowsHelperBootstrapFallback(device, helper, "wsb", 300, { now: () => clock, execute, wait: async (ms: number) => { clock += ms; } });
        expect(result).toMatchObject({ failure, deadlineExhausted: true });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(clock).toBe(225);
    });
    it("does not accept late bootstrap success", async () => {
        let clock = 0;
        const result = await runWindowsHelperBootstrapFallback(device, helper, "wsb", 100, { now: () => clock,
            execute: () => { clock = 76; return { ok: true, result: { status: 0 }, attempts: [] }; } });
        expect(result).toMatchObject({ ok: false, failure: "timeout", deadlineExhausted: true });
    });
    it("keeps an on-time successful bootstrap distinct from actual helper readiness", async () => {
        const result = await runWindowsHelperBootstrapFallback(device, helper, "wsb", 100, { now: () => 0,
            execute: () => ({ ok: true, runAs: "ExistingLogin", result: { status: 0 }, attempts: [] }) });
        expect(result).toMatchObject({ ok: true, ready: false, runAs: "ExistingLogin" });
    });
    it("does not launch or create a one-shot script after its deadline", async () => {
        const execute = vi.fn();
        const result = await runWindowsHelperRequestOnce(device, {}, "wsb", "/unused/request", "/unused/response", 0, { now: () => 10, execute });
        expect(result).toMatchObject({ attempted: false, ok: false, deadlineExhausted: true });
        expect(execute).not.toHaveBeenCalled();
    });
});


describe("bounded Sandbox helper log evidence", () => {
    it.each([
        [null, "absent"], ["", "empty"], [" \r\n", "empty"], ["PSSecurityException C:\\secret", "script-policy"],
        ["UnauthorizedAccessException secret", "access-denied"], ["PathNotFound C:\\secret", "path-not-found"],
        ["ParserError: token=secret", "parse-error"], ["unrecognized localized error secret", "other-error"],
        ["x".repeat(4097), "oversized"], ["é".repeat(2049), "oversized"],
    ])("classifies fixed log tokens without retaining text", (text, expected) => {
        expect(classifyWindowsSandboxHelperStderr(text)).toBe(expected);
    });
    it("reads only fixed bounded logs and marker phases", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-helper-evidence-"));
        try {
            expect(windowsSandboxHelperLogEvidence(root)).toEqual({ bootstrapStarted: false, bootstrapReady: false, helperHeartbeat: false, bootstrapStderr: "absent", helperStderr: "absent" });
            writeFileSync(join(root, "ccc-guest-helper-bootstrap.stdout.txt"), "bootstrap-start 2026-10-04T00:00:00Z\nhelper-pid 123");
            writeFileSync(join(root, "ccc-guest-helper-bootstrap.ready.txt"), "2026-10-04T00:00:00Z");
            writeFileSync(join(root, "ccc-guest-helper.heartbeat.txt"), "\uFEFFheartbeat 2026-10-04T00:00:00Z\ninbox-files secret.json");
            writeFileSync(join(root, "ccc-guest-helper-bootstrap.stderr.txt"), "UnauthorizedAccessException secret");
            writeFileSync(join(root, "ccc-guest-helper.stderr.txt"), "x".repeat(4097));
            writeFileSync(join(root, "arbitrary-secret.txt"), "secret");
            const evidence = windowsSandboxHelperLogEvidence(root);
            expect(evidence).toEqual({ bootstrapStarted: true, bootstrapReady: true, helperHeartbeat: true, bootstrapStderr: "access-denied", helperStderr: "oversized" });
            expect(JSON.stringify(evidence)).not.toMatch(/secret|123|2026/);
            writeFileSync(join(root, "ccc-guest-helper-bootstrap.ready.txt"), " ");
            writeFileSync(join(root, "ccc-guest-helper.heartbeat.txt"), "heartbeat-error secret");
            expect(windowsSandboxHelperLogEvidence(root)).toMatchObject({ bootstrapReady: false, helperHeartbeat: false });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it("rejects linked logs and marker files without reading their targets", context => {
        const root = mkdtempSync(join(tmpdir(), "ccc-helper-evidence-"));
        try {
            const target = join(root, "secret-target");
            writeFileSync(target, "bootstrap-start secret");
            fileSymlinkOrSkip(context, target, join(root, "ccc-guest-helper-bootstrap.stdout.txt"));
            fileSymlinkOrSkip(context, target, join(root, "ccc-guest-helper-bootstrap.stderr.txt"));
            fileSymlinkOrSkip(context, target, join(root, "ccc-guest-helper-bootstrap.ready.txt"));
            expect(windowsSandboxHelperLogEvidence(root)).toMatchObject({ bootstrapStarted: false, bootstrapReady: false, bootstrapStderr: "unreadable" });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
