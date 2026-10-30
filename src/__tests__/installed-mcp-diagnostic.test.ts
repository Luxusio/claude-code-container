import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { materializeUnixInstallPayload } from "../../scripts/install.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const unusualDirectory = process.platform === "win32" ? "payload space # percent%" : "payload space # query?";
const safeCalls = [
    { name: "devices", arguments: { view: "backends", detail: true, implicitBroker: false } },
    { name: "devices", arguments: { view: "owned", detail: true, implicitBroker: false } },
    { name: "status", arguments: { deviceId: "x11-current-display", detail: true } },
    { name: "run_flow", arguments: { detail: true, steps: [{ tool: "status", arguments: { deviceId: "x11-current-display" } }] } },
];
type FixtureMode = "healthy" | "names-mismatch" | "schema-mismatch" | "missing-schema" | "closed" | "malformed-response"
    | "malformed-payload" | "malformed-owned" | "missing-capability" | "wrong-status" | "failed-flow" | "malformed-flow"
    | "handshake-stall" | "tool-stall";
type Event = { kind: string; token?: string; pid?: number; ppid?: number; cwd?: string; env?: Record<string, string>; homeDirectory?: string; homeEntries?: string[];
    id?: string | number; method?: string; params?: Record<string, unknown> };
type ChildResult = { status: number | null; stdout: string; stderr: string; pid: number; elapsedMs: number; timedOut: boolean };

function callerEnvironment(root: string): NodeJS.ProcessEnv {
    const home = join(root, "caller home");
    const profile = join(root, "caller Windows profile");
    const temporary = join(root, "caller temp");
    const bin = join(root, "empty bin");
    for (const directory of [home, profile, temporary, bin]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(home, "caller-home-marker"), "must not be visible to the server");
    return {
        HOME: home, USERPROFILE: profile, HOMEDRIVE: "Z:", HOMEPATH: "\\caller-profile",
        APPDATA: join(profile, "Roaming"), LOCALAPPDATA: join(profile, "Local"),
        TMPDIR: temporary, TMP: temporary, TEMP: temporary, PATH: bin,
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        NODE_OPTIONS: "--no-warnings", NODE_PATH: join(root, "forbidden node_modules"),
        CCC_DEVICE_LAB_BROKER_TOKEN: "private-broker-secret", CCC_PROFILE: "inherited-profile",
        CCC_REAL_DEVICE_LAB_MCP_SERVER: join(root, "wrong-server.mjs"),
        CCC_DEVICE_LAB_TEST_ALLOW_MUTATION: "inherited-test-escape", ANDROID_HOME: join(root, "forbidden-android"),
        VITEST: "true", VITEST_ESCAPE: "inherited-test-escape", UNRELATED_CALLER_SENTINEL: "must-not-inherit",
    };
}

async function runNode(script: string, args: string[], root: string, env: NodeJS.ProcessEnv, timeoutMs = 18_000): Promise<ChildResult> {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const deadline = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    try {
        const status = await new Promise<number | null>((resolveExit, reject) => {
            child.once("error", reject);
            child.once("close", resolveExit);
        });
        return { status, stdout, stderr, pid: child.pid!, elapsedMs: Date.now() - started, timedOut };
    } finally {
        clearTimeout(deadline);
    }
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
    }
}

async function waitForExit(pid: number, timeoutMs = 750): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (alive(pid) && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 20));
    return !alive(pid);
}

function readEvents(logPath: string): Event[] {
    return existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Event) : [];
}

async function writeServer(path: string, logPath: string, token: string, mode: FixtureMode): Promise<void> {
    // Only fixture creation reads Source. The materialized child uses Node builtins
    // and literal protocol data, with no SDK, loader, helper or checkout imports.
    const { TOOLS } = await import("../../device-lab-mcp/src/tools.mjs") as { TOOLS: Array<{ name: string; inputSchema: unknown }> };
    writeFileSync(path, [
        'import { appendFileSync, readdirSync } from "node:fs";',
        'import { homedir } from "node:os";',
        'import { createInterface } from "node:readline";',
        `const mode = ${JSON.stringify(mode)};`,
        `const tools = ${JSON.stringify(TOOLS)};`,
        `const log = entry => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + "\\n");`,
        `log({kind:"birth",token:${JSON.stringify(token)},pid:process.pid,ppid:process.ppid,cwd:process.cwd(),env:process.env,homeDirectory:homedir(),homeEntries:readdirSync(process.env.HOME)});`,
        'const stalled = mode === "handshake-stall" || mode === "tool-stall";',
        'if (stalled) { setInterval(() => {}, 1000); process.on("SIGTERM", () => {}); }',
        'const payload = value => ({content:[{type:"text",text:JSON.stringify(value)}]});',
        'const status = {deviceId:"x11-current-display",kind:"display",backend:"x11"};',
        'createInterface({input:process.stdin}).on("line", line => {',
        '  const request = JSON.parse(line); log({kind:"rpc",id:request.id,method:request.method,params:request.params});',
        '  if (request.id === undefined) return;',
        '  const reply = result => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result}) + "\\n");',
        '  if (request.method === "initialize") {',
        '    if (mode === "closed") return process.exit(0);',
        '    if (mode === "handshake-stall") return;',
        '    return reply({protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"private-inert-fixture",version:"1"}});',
        '  }',
        '  if (request.method === "tools/list") {',
        '    if (mode === "malformed-response") return reply({tools:"not-an-array"});',
        '    if (mode === "names-mismatch") tools[0].name = "incompatible-tool-name";',
        '    if (mode === "schema-mismatch") tools[0].inputSchema = {type:"object",properties:{wrong:{type:"string"}}};',
        '    if (mode === "missing-schema") delete tools[0].inputSchema;',
        '    return reply({tools});',
        '  }',
        '  if (request.method === "tools/call") {',
        '    if (mode === "tool-stall") return;',
        '    const {name,arguments:args} = request.params;',
        '    if (name === "devices" && args.view === "backends") return reply(payload({source:"direct-provider",backends:[{name:"x11-current-display",capabilities:mode === "missing-capability" ? [] : ["status"]}]}));',
        '    if (name === "devices" && args.view === "owned") return reply(payload({devices:mode === "malformed-owned" ? "not-an-array" : []}));',
        '    if (name === "status") return reply(mode === "malformed-payload" ? {content:[{type:"text",text:"not JSON"}]} : payload(mode === "wrong-status" ? {...status,deviceId:"wrong-display"} : status));',
        '    if (name === "run_flow") return reply(payload({ok:mode !== "failed-flow",results:mode === "malformed-flow" ? [] : [{tool:"status",isError:false,content:[{type:"json",value:status}]}]}));',
        '  }',
        '  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32601,message:"fixture refused unexpected request"}}) + "\\n");',
        '}).on("close", () => { if (!stalled) process.exit(0); });',
        "",
    ].join("\n"));
}

async function withDiagnostic(mode: FixtureMode, check: (result: ChildResult, events: Event[], env: NodeJS.ProcessEnv) => Promise<void> | void,
    siblingDefault = false, bundleSource = join(repoRoot, "dist", "device-lab-mcp", "diagnostic.mjs"),
    aliasKind?: "ancestor" | "entry"): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "ccc-installed-diagnostic-"));
    const payload = join(root, unusualDirectory);
    mkdirSync(payload);
    const diagnostic = join(payload, "diagnostic.mjs");
    const server = join(payload, "server.mjs");
    const log = join(root, "owned-server.jsonl");
    const token = randomUUID();
    let result: ChildResult | undefined;
    try {
        copyFileSync(bundleSource, diagnostic);
        await writeServer(server, log, token, mode);
        const env = callerEnvironment(root);
        let entry = diagnostic;
        if (aliasKind) {
            const alias = join(root, "diagnostic alias");
            symlinkSync(aliasKind === "entry" ? diagnostic : payload, alias, aliasKind === "entry" ? "file" : "dir");
            entry = aliasKind === "entry" ? alias : join(alias, "diagnostic.mjs");
        }
        result = await runNode(entry, siblingDefault ? [] : [server], root, env);
        const events = readEvents(log);
        const birth = events.find(event => event.kind === "birth");
        expect(birth, result.stderr).toBeDefined();
        expect(birth).toMatchObject({ token, ppid: result.pid });
        expect(Number.isSafeInteger(birth!.pid)).toBe(true);
        expect(result.timedOut, result.stderr).toBe(false);
        expect(result.elapsedMs).toBeLessThan(14_000);
        expect(await waitForExit(birth!.pid!), "diagnostic must close and join its owned server before returning").toBe(true);
        expect(existsSync(birth!.env!.HOME), "diagnostic must remove its private home after joining the child").toBe(false);
        expect(existsSync(birth!.cwd!), "diagnostic must remove its private working directory").toBe(false);
        const rpc = events.filter(event => event.kind === "rpc");
        const issuedIds = new Set<string | number>();
        const cancellationCounts = new Map<string | number, number>();
        for (const request of rpc) {
            expect(["initialize", "notifications/initialized", "notifications/cancelled", "tools/list", "tools/call"]).toContain(request.method);
            if (request.method === "notifications/cancelled") {
                expect(request.id).toBeUndefined();
                expect(Object.keys(request.params || {}).sort()).toEqual(["reason", "requestId"]);
                const cancelledId = request.params!.requestId as string | number;
                expect(issuedIds.has(cancelledId), "cancellation must reference an already issued probe request").toBe(true);
                expect(typeof request.params!.reason).toBe("string");
                expect(request.params!.reason).not.toBe("");
                const count = (cancellationCounts.get(cancelledId) || 0) + 1;
                // The SDK can cancel once on timeout and once when the shared
                // cleanup signal aborts, including for already completed calls.
                expect(count).toBeLessThanOrEqual(2);
                cancellationCounts.set(cancelledId, count);
            } else if (request.id !== undefined) {
                expect(["string", "number"]).toContain(typeof request.id);
                expect(issuedIds.has(request.id)).toBe(false);
                issuedIds.add(request.id);
            }
            if (request.method === "tools/call") expect(safeCalls).toContainEqual(request.params);
        }
        expect(issuedIds.size).toBeLessThanOrEqual(safeCalls.length + 2);
        expect(rpc.length).toBeLessThanOrEqual(safeCalls.length + 3 + issuedIds.size * 2);
        await check(result, events, env);
    } finally {
        // Emergency cleanup is restricted to the PID whose private birth record
        // proves it was spawned by this exact diagnostic, never a process group.
        const birth = readEvents(log).find(event => event.kind === "birth" && event.token === token && event.ppid === result?.pid);
        if (birth?.pid && alive(birth.pid)) {
            process.kill(birth.pid, "SIGKILL");
            await waitForExit(birth.pid, 2000);
        }
        rmSync(root, { recursive: true, force: true });
    }
}

function expectHealthyDiagnostic(result: ChildResult, events: Event[], callerEnv: NodeJS.ProcessEnv): void {
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "PASS", currentDisplayCapabilities: ["status"] });
    const rpc = events.filter(event => event.kind === "rpc");
    expect(rpc.filter(event => event.method !== "notifications/cancelled").map(event => event.method)).toEqual([
        "initialize", "notifications/initialized", "tools/list", ...safeCalls.map(() => "tools/call"),
    ]);
    expect(rpc.filter(event => event.method === "tools/call").map(event => event.params)).toEqual(safeCalls);
    const birth = events.find(event => event.kind === "birth")!;
    const env = birth.env!;
    expect(birth.cwd).not.toBe(repoRoot);
    expect(birth.cwd).not.toBe(dirname(callerEnv.HOME!));
    expect(birth.cwd).not.toBe(join(dirname(callerEnv.HOME!), unusualDirectory));
    expect(env.HOME).not.toBe(callerEnv.HOME);
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(birth.homeDirectory).toBe(env.HOME);
    expect(birth.homeDirectory).not.toBe(callerEnv.USERPROFILE);
    const drive = win32.parse(env.HOME).root.replace(/[\\/]$/, "");
    expect(env.HOMEDRIVE).toBe(/^[A-Za-z]:$/.test(drive) ? drive : "");
    expect(env.HOMEDRIVE + env.HOMEPATH).toBe(env.HOME);
    expect(env.APPDATA).toBe(join(env.HOME, "AppData", "Roaming"));
    expect(env.LOCALAPPDATA).toBe(join(env.HOME, "AppData", "Local"));
    expect(birth.homeEntries).not.toContain("caller-home-marker");
    for (const key of ["APPDATA", "LOCALAPPDATA"]) {
        expect(env[key], key).not.toBe(callerEnv[key]);
    }
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "CCC_DEVICE_LAB_BROKER_TOKEN", "CCC_PROFILE", "CCC_REAL_DEVICE_LAB_MCP_SERVER",
        "CCC_DEVICE_LAB_TEST_ALLOW_MUTATION", "ANDROID_HOME", "VITEST", "VITEST_ESCAPE", "UNRELATED_CALLER_SENTINEL"]) {
        expect(env[key], key).toBeUndefined();
    }
    expect(Object.keys(env).filter(key => /^(CCC_|ANDROID_|VITEST)/i.test(key))).toEqual([]);
}

describe("installed MCP production diagnostic", () => {
    it.skipIf(process.platform === "win32")("executes the actual diagnostic through symlinked ancestors and entries", { timeout: 45_000 }, async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-diagnostic-entry-"));
        try {
            const server = join(root, "bundles", "server.mjs");
            const built = await runNode(join(repoRoot, "device-lab-mcp", "scripts", "build.mjs"), ["--outfile", server], root,
                { ...callerEnvironment(root), PATH: dirname(process.execPath) }, 30_000);
            expect(built.status, built.stderr).toBe(0);
            for (const aliasKind of ["ancestor", "entry"] as const) {
                await withDiagnostic("healthy", expectHealthyDiagnostic, false, join(dirname(server), "diagnostic.mjs"), aliasKind);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each(["absent", "missing", "unrelated"] as const)("only imports the diagnostic with an %s argv entry", async mode => {
        const root = mkdtempSync(join(tmpdir(), "ccc-diagnostic-import-"));
        try {
            const loader = join(root, "unrelated.mjs");
            const argv = mode === "absent" ? "undefined" : JSON.stringify(mode === "missing" ? join(root, "missing.mjs") : loader);
            writeFileSync(loader, `process.argv[1]=${argv};process.argv[2]=${JSON.stringify(join(root, "missing-server.mjs"))};await import(${JSON.stringify(pathToFileURL(join(repoRoot, "device-lab-mcp", "src", "installed-diagnostic.mjs")).href)});`);
            const result = await runNode(loader, [], root, callerEnvironment(root));
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr).toBe("");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each(["diagnostic.mjs", "DiAgNoStIc.MjS"])("refuses a colliding --outfile %s before changing existing output bytes", async filename => {
        const root = mkdtempSync(join(tmpdir(), "ccc-mcp-build-collision-"));
        const outputDir = join(root, unusualDirectory);
        mkdirSync(outputDir);
        try {
            const outfile = join(outputDir, filename);
            const existing = new Map([
                [outfile, Buffer.from("previous owned server artifact\0bytes\n")],
                [join(outputDir, "diagnostic.mjs"), Buffer.from("previous owned diagnostic artifact\0bytes\n")],
                [join(outputDir, "keep-existing.txt"), Buffer.from("unrelated owned output\n")],
            ]);
            for (const [path, bytes] of existing) writeFileSync(path, bytes);
            // Capture after setup so case aliases also work on Windows filesystems.
            const before = [...existing.keys()].map(path => ({ path, bytes: readFileSync(path) }));
            const entries = readdirSync(outputDir).sort();
            const result = await runNode(join(repoRoot, "device-lab-mcp", "scripts", "build.mjs"), ["--outfile", outfile], root, callerEnvironment(root));
            expect(result.timedOut).toBe(false);
            expect(result.status, result.stderr).not.toBeNull();
            expect(result.status, result.stderr).not.toBe(0);
            expect(result.stderr).toMatch(/reserved diagnostic\.mjs basename/i);
            for (const entry of before) expect(readFileSync(entry.path), entry.path).toEqual(entry.bytes);
            expect(readdirSync(outputDir).sort()).toEqual(entries);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each(["custom", "default"] as const)("builds distinct server output and a standalone diagnostic using the %s route", { timeout: 45_000 }, async route => {
        const root = mkdtempSync(join(tmpdir(), "ccc-mcp-build-output-"));
        const packageRoot = join(root, unusualDirectory);
        mkdirSync(packageRoot);
        try {
            let builder = join(repoRoot, "device-lab-mcp", "scripts", "build.mjs");
            const server = join(packageRoot, route === "default" ? "dist" : "custom output", "server.mjs");
            if (route === "default") {
                mkdirSync(join(packageRoot, "scripts"));
                for (const file of ["package.json", "server.mjs"]) copyFileSync(join(repoRoot, "device-lab-mcp", file), join(packageRoot, file));
                const sourceDirectories = [{ source: join(repoRoot, "device-lab-mcp", "src"), target: join(packageRoot, "src") }];
                while (sourceDirectories.length > 0) {
                    const directory = sourceDirectories.pop()!;
                    mkdirSync(directory.target);
                    for (const entry of readdirSync(directory.source, { withFileTypes: true })) {
                        const source = join(directory.source, entry.name);
                        const target = join(directory.target, entry.name);
                        if (entry.isDirectory()) sourceDirectories.push({ source, target });
                        else copyFileSync(source, target);
                    }
                }
                copyFileSync(builder, join(packageRoot, "scripts", "build.mjs"));
                // Only the actual build needs these authenticated development
                // dependencies. The executable witness below removes this link.
                symlinkSync(join(repoRoot, "node_modules"), join(packageRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
                builder = join(packageRoot, "scripts", "build.mjs");
            }
            const env = callerEnvironment(root);
            const built = await runNode(builder, route === "default" ? [] : ["--outfile", server], root,
                { ...env, PATH: dirname(process.execPath) }, 30_000);
            expect(built.timedOut, built.stderr).toBe(false);
            expect(built.status, built.stderr).toBe(0);
            const diagnostic = join(dirname(server), "diagnostic.mjs");
            expect(existsSync(server)).toBe(true);
            expect(existsSync(diagnostic)).toBe(true);
            expect(readFileSync(server)).not.toEqual(readFileSync(diagnostic));
            if (route === "default") {
                for (const path of ["src", "scripts", "node_modules", "server.mjs", "package.json"]) {
                    rmSync(join(packageRoot, path), { recursive: true, force: true });
                }
            }
            for (const path of ["src", "scripts", "node_modules"]) expect(existsSync(join(packageRoot, path)), path).toBe(false);
            await withDiagnostic("healthy", expectHealthyDiagnostic, true, diagnostic);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([false, true])("executes the real standalone bundle with safe exact protocol calls (sibling default: %s)", async siblingDefault => {
        await withDiagnostic("healthy", expectHealthyDiagnostic, siblingDefault);
    });

    it.each<FixtureMode>(["names-mismatch", "schema-mismatch", "missing-schema", "closed", "malformed-response", "malformed-payload",
        "malformed-owned", "missing-capability", "wrong-status", "failed-flow", "malformed-flow"])(
        "rejects %s without a false PASS and closes the private server", async mode => {
            await withDiagnostic(mode, result => {
                expect(result.status, result.stdout).not.toBe(0);
                expect(result.stdout).not.toMatch(/"status"\s*:\s*"PASS"/);
                expect(result.stderr.trim()).not.toBe("");
            });
        },
    );

    it.each<FixtureMode>(["handshake-stall", "tool-stall"])("bounds %s and joins the exact child even when it ignores SIGTERM", async mode => {
        await withDiagnostic(mode, (result, events) => {
            expect(result.status).not.toBe(0);
            expect(result.stdout).not.toMatch(/"status"\s*:\s*"PASS"/);
            expect(events.some(event => event.method === "initialize")).toBe(true);
            if (mode === "tool-stall") expect(events.some(event => event.method === "tools/call")).toBe(true);
        });
    });

    it("runs the default admin diagnostic from a materialized payload and preserves smoke exit semantics", { timeout: 45_000 }, async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-installed-admin-"));
        const payload = join(root, unusualDirectory, "ccc-dist");
        try {
            mkdirSync(dirname(payload));
            materializeUnixInstallPayload(repoRoot, payload);
            // The installer also carries scripts for other commands. Remove the
            // development smoke and helpers to prove this route is independent.
            rmSync(join(payload, "scripts", "real-tests"), { recursive: true, force: true });
            for (const path of ["src", "scripts/real-tests", "device-lab-mcp/src", "node_modules"]) {
                expect(existsSync(join(payload, path)), path).toBe(false);
            }
            const diagnostic = join(payload, "dist", "device-lab-mcp", "diagnostic.mjs");
            const server = join(payload, "dist", "device-lab-mcp", "server.mjs");
            const runner = join(root, "installed-admin.mjs");
            writeFileSync(runner, `import { devicesCli } from ${JSON.stringify(pathToFileURL(join(payload, "dist", "device-lab-admin.js")).href)};\nprocess.exitCode = devicesCli(["smoke", "--timeout-ms", "1000"]);\n`);
            const env = callerEnvironment(root);
            delete env.CCC_REAL_DEVICE_LAB_MCP_SERVER;
            const pass = await runNode(runner, [], root, env);
            expect(pass.timedOut).toBe(false);
            expect(pass.status, pass.stderr).toBe(0);
            expect(pass.stdout).toContain("device-lab-mcp-installed: PASS - installed MCP advertised surface dispatches current-display aliases");
            expect(pass.stdout).toContain(`${diagnostic} ${server} -> 0`);

            // The real default bundle must observe the closed protocol server;
            // replacing it with a fixed PASS executable would fail this witness.
            writeFileSync(server, "process.exit(0);\n");
            const failed = await runNode(runner, [], root, env);
            expect(failed.timedOut).toBe(false);
            expect(failed.status, failed.stderr).toBe(0);
            expect(failed.stdout).toContain("device-lab-mcp-installed: FAIL");
            expect(failed.stdout).not.toContain("device-lab-mcp-installed: PASS");
            expect(failed.stdout).toContain(`${diagnostic} ${server} -> 1`);

            rmSync(diagnostic);
            const missing = await runNode(runner, [], root, env);
            expect(missing.status, missing.stderr).toBe(0);
            expect(missing.stdout).toContain("device-lab-mcp-installed: SKIP");
            expect(missing.stdout).toContain(diagnostic);
            expect(missing.stdout).not.toContain("device-lab-mcp-installed: PASS");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
