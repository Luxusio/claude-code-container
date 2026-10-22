import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "./tools.mjs";

const PROBE_TIMEOUT_MS = 9000;
const REQUEST_TIMEOUT_MS = 3000;
const CURRENT_DISPLAY = "x11-current-display";

function successfulObject(value, label) {
    assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} returned no object`);
    assert(value.ok !== false && value.isError !== true && !value.error, `${label} returned an error`);
    return value;
}

function toolPayload(result, label) {
    successfulObject(result, label);
    assert(Array.isArray(result.content) && result.content.length === 1
        && result.content[0]?.type === "text" && typeof result.content[0].text === "string", `${label} returned invalid content`);
    return successfulObject(JSON.parse(result.content[0].text), label);
}

function currentDisplayStatus(value, label) {
    successfulObject(value, label);
    assert.equal(value.deviceId, CURRENT_DISPLAY, `${label} returned the wrong device`);
    assert.equal(value.kind, "display", `${label} returned the wrong kind`);
    assert.equal(value.backend, "x11", `${label} returned the wrong backend`);
}

function isolatedEnvironment(homeDir) {
    const appData = join(homeDir, "AppData", "Roaming");
    const localAppData = join(homeDir, "AppData", "Local");
    const temp = join(homeDir, "tmp");
    for (const path of [appData, localAppData, temp]) mkdirSync(path, { recursive: true, mode: 0o700 });
    return {
        // The SDK merges its own defaults even when env is supplied. Explicitly
        // remove those before selecting the finite environment for this probe.
        ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, undefined])),
        HOME: homeDir,
        USERPROFILE: homeDir,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
        PATH: process.env.PATH || "",
        SYSTEMROOT: process.env.SYSTEMROOT,
        SYSTEMDRIVE: process.env.SYSTEMDRIVE,
        USER: "ccc-installed-diagnostic",
        LOGNAME: "ccc-installed-diagnostic",
        USERNAME: "ccc-installed-diagnostic",
        SHELL: process.platform === "win32" ? undefined : "/bin/sh",
        TERM: "dumb",
    };
}

export async function runInstalledMcpDiagnostic(options = {}) {
    const serverPath = resolve(options.serverPath || fileURLToPath(new URL("./server.mjs", import.meta.url)));
    assert(existsSync(serverPath), `device-lab MCP server not found: ${serverPath}`);
    const homeDir = mkdtempSync(join(tmpdir(), "ccc-installed-device-lab-mcp-"));
    try {
        const cwd = join(homeDir, "work");
        mkdirSync(cwd, { mode: 0o700 });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [serverPath],
            cwd,
            env: isolatedEnvironment(homeDir),
            stderr: "pipe",
        });
        // Drain diagnostics without copying arbitrary child output to the CLI.
        transport.stderr?.resume();
        let childPid;
        let childClosed = false;
        let resolveClosed;
        const closed = new Promise(resolve => { resolveClosed = resolve; });
        transport.onclose = () => { childClosed = true; resolveClosed(); };
        const start = transport.start.bind(transport);
        transport.start = async () => { await start(); childPid = transport.pid; };
        // Client.connect starts an asynchronous close itself on handshake failure.
        // Sharing that promise keeps finally responsible for its entire cleanup.
        const close = transport.close.bind(transport);
        let closing;
        transport.close = () => closing ||= close();

        const client = new Client({ name: "ccc-installed-device-lab-mcp-diagnostic", version: "1.0.0" });
        const controller = new AbortController();
        const deadlineAt = Date.now() + PROBE_TIMEOUT_MS;
        let rejectFailure;
        const failure = new Promise((_, reject) => { rejectFailure = reject; });
        const fail = error => { controller.abort(error); rejectFailure(error); };
        client.onerror = fail;
        client.onclose = () => fail(new Error("device-lab MCP server closed during diagnostic"));
        const deadline = setTimeout(() => fail(new Error("installed MCP diagnostic timed out")), PROBE_TIMEOUT_MS);
        const requestOptions = () => {
            controller.signal.throwIfAborted();
            const remaining = deadlineAt - Date.now();
            assert(remaining > 0, "installed MCP diagnostic timed out");
            return { signal: controller.signal, timeout: Math.min(REQUEST_TIMEOUT_MS, remaining), maxTotalTimeout: remaining };
        };
        const callTool = async (name, args) => toolPayload(await client.callTool({ name, arguments: args }, undefined, requestOptions()), name);
        try {
            return await Promise.race([failure, (async () => {
                await client.connect(transport, requestOptions());
                const listed = await client.listTools(undefined, requestOptions());
                assert.equal(listed.nextCursor, undefined, "advertised tool catalog must not be paginated");
                assert.deepEqual(listed.tools.map(tool => tool.name), TOOLS.map(tool => tool.name), "advertised tool names do not match canonical device-lab MCP tools");
                assert.deepEqual(listed.tools.map(tool => tool.inputSchema), TOOLS.map(tool => tool.inputSchema), "advertised tool schemas do not match canonical device-lab MCP tools");

                const catalog = await callTool("devices", { view: "backends", detail: true, implicitBroker: false });
                assert(Array.isArray(catalog.backends), "devices view:backends returned no backend list");
                for (const backend of catalog.backends) {
                    assert(backend !== null && typeof backend === "object" && typeof backend.name === "string", "devices returned an invalid backend");
                }
                const displays = catalog.backends.filter(backend => backend.name === CURRENT_DISPLAY);
                assert.equal(displays.length, 1, "x11-current-display backend must be advertised once");
                const display = successfulObject(displays[0], "current-display backend");
                assert(Array.isArray(display.capabilities) && display.capabilities.every(capability => typeof capability === "string")
                    && display.capabilities.includes("status"), "x11-current-display must expose status capability");

                const owned = await callTool("devices", { view: "owned", detail: true, implicitBroker: false });
                assert(Array.isArray(owned.devices), "devices view:owned returned no owned device list");
                for (const device of owned.devices) {
                    successfulObject(device, "owned device");
                    assert(typeof device.deviceId === "string" && device.deviceId.length > 0, "owned device returned no deviceId");
                }
                currentDisplayStatus(await callTool("status", { deviceId: CURRENT_DISPLAY, detail: true }), "status");
                const flow = await callTool("run_flow", { detail: true, steps: [{ tool: "status", arguments: { deviceId: CURRENT_DISPLAY } }] });
                assert.equal(flow.ok, true, "run_flow did not succeed");
                assert(Array.isArray(flow.results) && flow.results.length === 1, "run_flow returned the wrong step count");
                const step = successfulObject(flow.results[0], "run_flow status step");
                assert.equal(step.tool, "status", "run_flow did not run status");
                assert.equal(step.isError, false, "run_flow status step returned an error");
                assert(Array.isArray(step.content) && step.content.length === 1 && step.content[0]?.type === "json", "run_flow status step returned invalid content");
                currentDisplayStatus(step.content[0].value, "run_flow status result");
                return { status: "PASS", serverPath, tools: listed.tools.length, currentDisplayCapabilities: display.capabilities };
            })()]);
        } finally {
            clearTimeout(deadline);
            controller.abort();
            await transport.close();
            if (childPid && !childClosed) {
                // SDK close escalates to SIGKILL within four seconds. Join its
                // close event as well, within the admin's 15-second minimum.
                let joinTimeout;
                try {
                    await Promise.race([closed, new Promise((_, reject) => {
                        joinTimeout = setTimeout(() => reject(new Error("device-lab MCP server did not close")), 500);
                    })]);
                } finally {
                    clearTimeout(joinTimeout);
                }
            }
        }
    } finally {
        rmSync(homeDir, { recursive: true, force: true });
    }
}

let directEntry = false;
try {
    directEntry = !!process.argv[1]
        && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
} catch { /* An import may have no existing argv entry. */ }
if (directEntry) {
    runInstalledMcpDiagnostic({ serverPath: process.argv[2] }).then(result => {
        console.log(JSON.stringify(result, null, 2));
    }).catch(error => {
        console.error(error?.message || String(error));
        process.exitCode = 1;
    });
}
