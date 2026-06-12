import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");
const TIMEOUT = 30000;

describe("device-lab MCP with fake Windows Sandbox CLI", () => {
    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;
    let failStopPath: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-windows-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-windows-bin-"));
        logPath = join(homeDir, "fake-windows.log");
        failStopPath = join(homeDir, "fail-stop");

        const wsbPath = join(binDir, "wsb");
        writeFileSync(wsbPath, `#!/bin/sh
echo "wsb $*" >> "$FAKE_WINDOWS_LOG"
if [ "$1" = "stop" ] && [ -f "$FAKE_WINDOWS_FAIL_STOP" ]; then
  echo "forced stop failure" >&2
  exit 7
fi
exit 0
`);
        chmodSync(wsbPath, 0o755);

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_WINDOWS_LOG: logPath,
                FAKE_WINDOWS_FAIL_STOP: failStopPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-windows-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("writes owner-scoped Windows Sandbox config with helper bootstrap only on explicit start", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Helper",
                networking: false,
                clipboard: false,
                vgpu: false,
                memoryMb: 2048,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; helper: { scratchDir: string; toolsDir: string; hostHelperScript: string } };
        };
        expect(created.device.id).toBe("windows-win-helper");
        expect(created.device.helper.scratchDir).toContain("windows-win-helper");

        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("wsb start");
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "windows-sandbox" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; helper: { scratchDir: string }; configPath: string }>;
            discovery: { available: boolean; wsb: string };
            hostSandboxes: { lazy: boolean; provider: string };
        };
        expect(inventoryPayload.discovery.available).toBe(true);
        expect(inventoryPayload.hostSandboxes).toEqual(expect.objectContaining({ lazy: true, provider: "wsb" }));
        expect(inventoryPayload.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "windows-win-helper",
                helper: expect.objectContaining({ scratchDir: expect.stringContaining("windows-win-helper") }),
                configPath: expect.stringContaining("windows-win-helper.wsb"),
            }),
        ]));
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("wsb start");

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: {
                configPath: string;
                helper: {
                    hostHelperScript: string;
                    inboxDir: string;
                    outboxDir: string;
                    downloadsDir: string;
                };
            };
        };
        const config = readFileSync(started.device.configPath, "utf-8");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch</SandboxFolder>");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\tools</SandboxFolder>");
        expect(config).toContain("<ReadOnly>true</ReadOnly>");
        expect(config).toContain("<LogonCommand>");
        expect(config).toContain("ccc-guest-helper.ps1");
        const helperScript = readFileSync(started.device.helper.hostHelperScript, "utf-8");
        expect(helperScript).toContain("Get-ChildItem -Path $Inbox");
        expect(helperScript).toContain("'exec'");
        expect(helperScript).toContain("'screenshot'");
        expect(helperScript).toContain("'click'");
        expect(helperScript).toContain("'double_click'");
        expect(helperScript).toContain("'key'");
        expect(helperScript).toContain("'type'");
        expect(helperScript).toContain("'scroll'");
        expect(helperScript).toContain("'cursor_position'");
        expect(helperScript).toContain("'upload'");
        expect(helperScript).toContain("'download'");

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`wsb start ${started.device.configPath}`);

        let forceInactiveRecordStatus = false;
        const helperRequests: Array<Record<string, unknown>> = [];
        const responder = setInterval(() => {
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
                };
                helperRequests.push(request as unknown as Record<string, unknown>);
                const response: Record<string, unknown> = { id: request.id, ok: true, type: request.type };
                if (request.type === "exec") {
                    response.stdout = `ran ${request.command}`;
                    response.stderr = "";
                    response.status = 0;
                }
                if (request.type === "screenshot") {
                    writeFileSync(join(started.device.helper.downloadsDir, `${request.id}.png`), "fakepng");
                    response.imagePath = `C:\\ccc\\scratch\\downloads\\${request.id}.png`;
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
                if (request.type === "download") {
                    const remoteName = String(request.remotePath ?? "remote.txt").split(/[\\/]/).filter(Boolean).pop() ?? "remote.txt";
                    const downloadName = `${request.id}-${remoteName}`;
                    writeFileSync(join(started.device.helper.downloadsDir, downloadName), "downloaded");
                    response.downloadPath = `C:\\ccc\\scratch\\downloads\\${downloadName}`;
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
                        response.recording = {
                            sessionId: request.sessionId,
                            active: false,
                            state: "Completed",
                            archivePath: `C:\\ccc\\scratch\\downloads\\${archiveName}`,
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
                    const archiveName = `${request.id}.zip`;
                    writeFileSync(join(started.device.helper.downloadsDir, archiveName), "fakezip");
                    response.recording = {
                        sessionId: request.id,
                        active: false,
                        archivePath: `C:\\ccc\\scratch\\downloads\\${archiveName}`,
                        provider: "windows-helper-frame-archive",
                    };
                }
                writeFileSync(join(started.device.helper.outboxDir, `${request.id}.json`), JSON.stringify(response));
                rmSync(requestPath, { force: true });
            }
        }, 25);

        const exec = await client.callTool({
            name: "device_exec",
            arguments: { deviceId: "windows-win-helper", command: "whoami", helperTimeoutMs: 1000 },
        });
        expect(exec.isError).not.toBe(true);
        expect(((exec.content as Array<{ text?: string }>)[0].text ?? "")).toContain("ran whoami");

        const screenshot = await client.callTool({
            name: "device_screenshot",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(screenshot.isError).not.toBe(true);
        expect((screenshot.content as Array<{ type: string }>)[0].type).toBe("image");

        const click = await client.callTool({
            name: "device_click",
            arguments: { deviceId: "windows-win-helper", x: 25, y: 40, button: "right", helperTimeoutMs: 1000 },
        });
        expect(click.isError).not.toBe(true);
        expect(JSON.parse(((click.content as Array<{ text?: string }>)[0].text ?? "{}")).clicked).toEqual({
            x: 25,
            y: 40,
            button: "right",
        });

        const doubleClick = await client.callTool({
            name: "device_double_click",
            arguments: { deviceId: "windows-win-helper", x: 30, y: 50, helperTimeoutMs: 1000 },
        });
        expect(doubleClick.isError).not.toBe(true);
        expect(JSON.parse(((doubleClick.content as Array<{ text?: string }>)[0].text ?? "{}")).doubleClicked).toEqual({
            x: 30,
            y: 50,
            button: "left",
        });

        const key = await client.callTool({
            name: "device_key",
            arguments: { deviceId: "windows-win-helper", key: "Control+A", helperTimeoutMs: 1000 },
        });
        expect(key.isError).not.toBe(true);
        expect(JSON.parse(((key.content as Array<{ text?: string }>)[0].text ?? "{}")).key).toEqual({
            key: "Control+A",
            keys: "^a",
        });

        const type = await client.callTool({
            name: "device_type",
            arguments: { deviceId: "windows-win-helper", text: "hello from ccc", helperTimeoutMs: 1000 },
        });
        expect(type.isError).not.toBe(true);
        expect(JSON.parse(((type.content as Array<{ text?: string }>)[0].text ?? "{}")).typed).toEqual({
            text: "hello from ccc",
            keys: "hello from ccc",
        });

        const literalType = await client.callTool({
            name: "device_type",
            arguments: { deviceId: "windows-win-helper", text: "a+b {ok} 50% [x] (y) ~ ^", helperTimeoutMs: 1000 },
        });
        expect(literalType.isError).not.toBe(true);
        expect(JSON.parse(((literalType.content as Array<{ text?: string }>)[0].text ?? "{}")).typed).toEqual({
            text: "a+b {ok} 50% [x] (y) ~ ^",
            keys: "a{+}b {{}ok{}} 50{%} {[}x{]} {(}y{)} {~} {^}",
        });

        const scroll = await client.callTool({
            name: "device_scroll",
            arguments: { deviceId: "windows-win-helper", x: 10, y: 20, direction: "down", amount: 3, helperTimeoutMs: 1000 },
        });
        expect(scroll.isError).not.toBe(true);
        expect(JSON.parse(((scroll.content as Array<{ text?: string }>)[0].text ?? "{}")).scrolled).toEqual({
            x: 10,
            y: 20,
            direction: "down",
            amount: 3,
        });

        const cursor = await client.callTool({
            name: "device_cursor_position",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(cursor.isError).not.toBe(true);
        expect(JSON.parse(((cursor.content as Array<{ text?: string }>)[0].text ?? "{}")).cursor).toEqual({ x: 11, y: 22 });

        const uploadSource = join(homeDir, "upload.txt");
        writeFileSync(uploadSource, "upload");
        const upload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: "windows-win-helper", localPath: uploadSource, remotePath: "C:\\Users\\WDAGUtilityAccount\\upload.txt", helperTimeoutMs: 1000 },
        });
        expect(upload.isError).not.toBe(true);

        const downloadTarget = join(homeDir, "download.txt");
        const download = await client.callTool({
            name: "device_download",
            arguments: { deviceId: "windows-win-helper", remotePath: "C:\\Users\\WDAGUtilityAccount\\remote.txt", localPath: downloadTarget, helperTimeoutMs: 1000 },
        });
        expect(download.isError).not.toBe(true);
        expect(readFileSync(downloadTarget, "utf-8")).toBe("downloaded");

        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "windows-win-helper", localPath: join(homeDir, "windows-recording.zip"), timeLimitSec: 2, helperTimeoutMs: 1000 },
        });
        expect(recordStart.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string; localPath: string };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "windows-helper-frame-archive",
            localPath: join(homeDir, "windows-recording.zip"),
            timeLimitSec: 2,
        }));

        const duplicateRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(duplicateRecordStart.isError).toBe(true);
        expect((duplicateRecordStart.content as Array<{ text?: string }>)[0].text).toContain("Windows Sandbox recording already active");

        const activeRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(activeRecordStatus.isError).not.toBe(true);
        expect(JSON.parse(((activeRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: true,
            provider: "windows-helper-frame-archive",
        }));

        const recordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
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
            name: "device_record_video_stop",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(stopWithoutRecording.isError).toBe(true);
        expect((stopWithoutRecording.content as Array<{ text?: string }>)[0].text).toContain("No Windows Sandbox recording active");

        const boundedRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "windows-win-helper", localPath: join(homeDir, "bounded-windows-recording.zip"), timeLimitSec: 1, helperTimeoutMs: 1000 },
        });
        expect(boundedRecordStart.isError).not.toBe(true);
        forceInactiveRecordStatus = true;
        const inactiveRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(inactiveRecordStatus.isError).not.toBe(true);
        expect(JSON.parse(((inactiveRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();
        expect(readFileSync(join(homeDir, "bounded-windows-recording.zip"), "utf-8")).toBe("boundedzip");
        const restartAfterInactiveStatus = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "windows-win-helper", localPath: join(homeDir, "restart-windows-recording.zip"), helperTimeoutMs: 1000 },
        });
        expect(restartAfterInactiveStatus.isError).not.toBe(true);
        forceInactiveRecordStatus = false;
        const restartStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(restartStop.isError).not.toBe(true);
        clearInterval(responder);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(stop.isError).not.toBe(true);

        expect(helperRequests).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "click", x: 25, y: 40, button: "right" }),
            expect.objectContaining({ type: "double_click", x: 30, y: 50, button: "left" }),
            expect.objectContaining({ type: "key", key: "Control+A", keys: "^a" }),
            expect.objectContaining({ type: "type", text: "hello from ccc", keys: "hello from ccc" }),
            expect.objectContaining({ type: "type", text: "a+b {ok} 50% [x] (y) ~ ^", keys: "a{+}b {{}ok{}} 50{%} {[}x{]} {(}y{)} {~} {^}" }),
            expect.objectContaining({ type: "scroll", x: 10, y: 20, direction: "down", amount: 3 }),
            expect.objectContaining({ type: "cursor_position" }),
        ]));
    });

    it("cleans Windows Sandbox scratch on delete and preserves state when forced stop fails", { timeout: TIMEOUT }, async () => {
        const stoppedCreate = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Delete Stopped",
                deviceId: "windows-delete-stopped",
            },
        });
        expect(stoppedCreate.isError).not.toBe(true);
        const stoppedCreated = JSON.parse(((stoppedCreate.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; helper: { scratchDir: string } };
        };
        expect(existsSync(stoppedCreated.device.helper.scratchDir)).toBe(true);

        const stoppedDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-stopped" },
        });
        expect(stoppedDelete.isError).not.toBe(true);
        expect(existsSync(stoppedCreated.device.helper.scratchDir)).toBe(false);

        const runningCreate = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Delete Running",
                deviceId: "windows-delete-running",
            },
        });
        expect(runningCreate.isError).not.toBe(true);
        const runningCreated = JSON.parse(((runningCreate.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { scratchDir: string } };
        };
        const runningStart = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "windows-delete-running" },
        });
        expect(runningStart.isError).not.toBe(true);

        const logBeforeRefusal = readFileSync(logPath, "utf-8");
        const runningDeleteRefused = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-running" },
        });
        expect(runningDeleteRefused.isError).toBe(true);
        expect((runningDeleteRefused.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete windows-delete-running while status is running");
        expect(readFileSync(logPath, "utf-8")).toBe(logBeforeRefusal);
        expect(existsSync(runningCreated.device.helper.scratchDir)).toBe(true);
        const statusAfterRefusedDelete = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "windows-delete-running" },
        });
        expect(statusAfterRefusedDelete.isError).not.toBe(true);
        expect(JSON.parse(((statusAfterRefusedDelete.content as Array<{ text?: string }>)[0].text ?? "{}")).device.status).toBe("running");

        const logBeforeForceDelete = readFileSync(logPath, "utf-8");
        const runningForceDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-running", force: true },
        });
        expect(runningForceDelete.isError).not.toBe(true);
        const logAfterForceDelete = readFileSync(logPath, "utf-8");
        expect(logAfterForceDelete.slice(logBeforeForceDelete.length)).toContain("wsb stop");
        expect(existsSync(runningCreated.device.helper.scratchDir)).toBe(false);
        const inventoryAfterDelete = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "windows-sandbox" },
        });
        expect(inventoryAfterDelete.isError).not.toBe(true);
        const inventoryAfterDeletePayload = JSON.parse(((inventoryAfterDelete.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string }>;
        };
        expect(inventoryAfterDeletePayload.devices.some((device) => device.id === "windows-delete-running")).toBe(false);

        const failCreate = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Delete Stop Failure",
                deviceId: "windows-delete-stop-failure",
            },
        });
        expect(failCreate.isError).not.toBe(true);
        const failCreated = JSON.parse(((failCreate.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { scratchDir: string } };
        };
        const failStart = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "windows-delete-stop-failure" },
        });
        expect(failStart.isError).not.toBe(true);

        writeFileSync(failStopPath, "fail");
        const failedForceDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-stop-failure", force: true },
        });
        expect(failedForceDelete.isError).toBe(true);
        expect((failedForceDelete.content as Array<{ text?: string }>)[0].text).toContain("forced stop failure");
        expect(existsSync(failCreated.device.helper.scratchDir)).toBe(true);
        const statusAfterFailedDelete = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "windows-delete-stop-failure" },
        });
        expect(statusAfterFailedDelete.isError).not.toBe(true);
        expect(JSON.parse(((statusAfterFailedDelete.content as Array<{ text?: string }>)[0].text ?? "{}")).device.status).toBe("running");

        rmSync(failStopPath, { force: true });
        const retryForceDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-stop-failure", force: true },
        });
        expect(retryForceDelete.isError).not.toBe(true);
        expect(existsSync(failCreated.device.helper.scratchDir)).toBe(false);
    });
});
