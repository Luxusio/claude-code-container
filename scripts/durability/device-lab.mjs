#!/usr/bin/env node

import { spawn, spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createServer } from "net";
import { hiddenWindowsPowerShellArgs } from "../../device-lab-mcp/src/state/windows-system-powershell.mjs";
import {
    describeProcessIdentities,
    identityForPid,
    liveOwnedProcessIdentities,
    processIdentityKey,
    processIdentitySnapshot,
    sameProcessIdentity,
    sampleOwnedProcessIdentities,
} from "./process-identity.mjs";
import { finalizeDurabilityEvidence } from "./evidence.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const cliPath = join(repoRoot, "dist", "index.js");
const RESPONSE_LIMIT_BYTES = 1024 * 1024;

function usage() {
    return [
        "Usage: npm run test:durability:device-lab -- [options]",
        "",
        "Options:",
        "  --iterations <n>   Request rounds to run (default: 100)",
        "  --duration <time>  Maximum run time, such as 30s, 5m, or 1h",
        "  --concurrency <n>  Concurrent requests per round, 4-64 (default: 8)",
        "  --timeout <time>   Per-request timeout (default: 3s)",
        "  --progress <n>     Print progress every n rounds (default: 10)",
        "  --restart-every <n>  Restart owned broker every n rounds (default: 0/off)",
        "  --max-rss-growth <size>  Maximum RSS growth per broker generation (default: 128MiB; 0 disables)",
        "  --rss-sample-every <n>   Sample broker RSS every n rounds (default: 10)",
        "  --max-survivors <n>  Allowed owned processes after cleanup (default: 0; -1 disables assertion)",
        "  --help             Show this help",
    ].join("\n");
}

function parsePositiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return parsed;
}

function parseDuration(value, name) {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(String(value));
    if (!match) throw new Error(`${name} must be a duration such as 500ms, 30s, 5m, or 1h`);
    const factors = { ms: 1, s: 1000, m: 60000, h: 3600000 };
    const milliseconds = Number(match[1]) * factors[(match[2] || "ms").toLowerCase()];
    if (!Number.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 24 * 60 * 60 * 1000) {
        throw new Error(`${name} must be between 1ms and 24h`);
    }
    return Math.ceil(milliseconds);
}

function parseSize(value, name) {
    if (String(value) === "0") return 0;
    const match = /^(\d+(?:\.\d+)?)(b|kb|kib|mb|mib|gb|gib)?$/i.exec(String(value));
    if (!match) throw new Error(`${name} must be a size such as 128MiB, 512MB, or 1GiB`);
    const factors = {
        b: 1,
        kb: 1000,
        kib: 1024,
        mb: 1000 ** 2,
        mib: 1024 ** 2,
        gb: 1000 ** 3,
        gib: 1024 ** 3,
    };
    const bytes = Number(match[1]) * factors[(match[2] || "b").toLowerCase()];
    if (!Number.isFinite(bytes) || bytes < 1 || bytes > 16 * 1024 ** 3) {
        throw new Error(`${name} must be between 1 byte and 16GiB, or 0 to disable`);
    }
    return Math.ceil(bytes);
}

function parseArgs(args) {
    const options = {
        iterations: 100,
        iterationsExplicit: false,
        durationMs: 0,
        concurrency: 8,
        timeoutMs: 3000,
        progressEvery: 10,
        restartEvery: 0,
        maxRssGrowthBytes: 128 * 1024 ** 2,
        rssSampleEvery: 10,
        maxSurvivors: 0,
        help: false,
    };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        const next = () => {
            const value = args[index + 1];
            if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
            index += 1;
            return value;
        };
        if (argument === "--iterations") {
            options.iterations = parsePositiveInteger(next(), argument);
            options.iterationsExplicit = true;
        }
        else if (argument === "--duration") options.durationMs = parseDuration(next(), argument);
        else if (argument === "--concurrency") options.concurrency = parsePositiveInteger(next(), argument, { min: 4, max: 64 });
        else if (argument === "--timeout") options.timeoutMs = parseDuration(next(), argument);
        else if (argument === "--progress") options.progressEvery = parsePositiveInteger(next(), argument);
        else if (argument === "--restart-every") options.restartEvery = parsePositiveInteger(next(), argument, { min: 0, max: 1000000 });
        else if (argument === "--max-rss-growth") options.maxRssGrowthBytes = parseSize(next(), argument);
        else if (argument === "--rss-sample-every") options.rssSampleEvery = parsePositiveInteger(next(), argument, { max: 1000000 });
        else if (argument === "--max-survivors") {
            const value = Number(next());
            if (!Number.isSafeInteger(value) || value < -1 || value > 64) {
                throw new Error(`${argument} must be an integer from -1 to 64`);
            }
            options.maxSurvivors = value;
        }
        else if (argument === "--help" || argument === "-h") options.help = true;
        else throw new Error(`unknown option: ${argument}`);
    }
    if (options.durationMs && !options.iterationsExplicit) options.iterations = Number.MAX_SAFE_INTEGER;
    return options;
}

async function reservePort() {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    if (!address || typeof address === "string") throw new Error("failed to reserve a broker port");
    return address.port;
}

async function boundedText(response, limit = RESPONSE_LIMIT_BYTES) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) throw new Error(`response exceeded ${limit} bytes`);
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) {
            await reader.cancel();
            throw new Error(`response exceeded ${limit} bytes`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
}

async function requestJson(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
        const response = await fetch(url, {
            ...options,
            redirect: "manual",
            signal: controller.signal,
        });
        const text = await boundedText(response);
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            throw new Error(`HTTP ${response.status} returned invalid JSON`);
        }
        if (!response.ok || body?.ok !== true) {
            throw new Error(`HTTP ${response.status}: ${body?.error || "request failed"}`);
        }
        return { body, elapsedMs: Date.now() - started };
    } catch (error) {
        if (error?.name === "AbortError") throw new Error(`timed out after ${timeoutMs}ms`);
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function waitForBroker(baseUrl, timeoutMs, broker) {
    const deadline = Date.now() + Math.max(5000, timeoutMs * 4);
    let lastError = "not ready";
    while (Date.now() < deadline) {
        if (broker.spawnError) throw new Error(`broker failed to start: ${broker.spawnError.message}`);
        if (broker.child.exitCode !== null || broker.child.signalCode !== null) {
            throw new Error(`broker exited during startup with ${broker.child.exitCode ?? broker.child.signalCode}`);
        }
        try {
            await requestJson(`${baseUrl}/health`, { method: "GET" }, timeoutMs);
            return;
        } catch (error) {
            lastError = error.message;
            await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
    }
    throw new Error(`broker did not become ready: ${lastError}`);
}

function readBrokerIdentity(homeDir, expectedPid) {
    const runtimeFile = join(homeDir, ".ccc", "devices", "broker", "runtime.json");
    const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
    const pid = Number(runtime.pid);
    if (!Number.isInteger(pid) || pid !== expectedPid) throw new Error("broker runtime PID is stale or invalid");
    const ownerId = String(runtime.ownerId || "");
    if (!/^[a-f0-9]{16}$/.test(ownerId)) throw new Error("broker runtime returned an invalid owner ID");
    const authFile = join(homeDir, ".ccc", "devices", "broker", "auth", `${ownerId}.json`);
    const auth = JSON.parse(readFileSync(authFile, "utf8"));
    if (auth.ownerId !== ownerId || !/^[a-f0-9]{64}$/.test(String(auth.secret || ""))) {
        throw new Error("broker owner authentication file is invalid");
    }
    const token = createHash("sha256")
        .update(`ccc-device-broker:owner:${ownerId}:secret:${auth.secret}`)
        .digest("hex");
    return { ownerId, token, pid };
}

async function waitForBrokerIdentity(homeDir, expectedPid, timeoutMs) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    let lastError = "identity unavailable";
    while (Date.now() < deadline) {
        try {
            return readBrokerIdentity(homeDir, expectedPid);
        } catch (error) {
            lastError = error.message;
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
    }
    throw new Error(`broker identity did not recover: ${lastError}`);
}

function startOwnedBroker(homeDir, port) {
    const child = spawn(process.execPath, [cliPath, "devices", "broker", "serve", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: repoRoot,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
    });
    const broker = { child, stderr: "", spawnError: null };
    child.once("error", (error) => { broker.spawnError = error; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { broker.stderr = `${broker.stderr}${chunk}`.slice(-2000); });
    return broker;
}

async function waitForChildExit(child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise((resolveWait) => {
        const timer = setTimeout(() => {
            child.off("exit", onExit);
            resolveWait(false);
        }, timeoutMs);
        const onExit = () => {
            clearTimeout(timer);
            resolveWait(true);
        };
        child.once("exit", onExit);
    });
}

async function waitForProcessIdentity(child, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "identity unavailable";
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`owned broker exited before process identity capture: ${child.exitCode ?? child.signalCode}`);
        }
        try {
            const identity = identityForPid(child.pid);
            if (identity) return identity;
            lastError = `PID ${child.pid} absent from process identity snapshot`;
        } catch (error) {
            lastError = error.message;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error(`could not capture owned broker process identity: ${lastError}`);
}

async function waitForOwnedProcessesExit(registry, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let survivors = liveOwnedProcessIdentities(registry);
    while (survivors.length > 0 && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        survivors = liveOwnedProcessIdentities(registry);
    }
    return survivors;
}

function cleanupCommandError(result) {
    return result.error?.message || String(result.stderr || result.stdout || `status ${result.status}`).trim();
}

async function stopOwnedChild(broker, registry) {
    const child = broker?.child;
    const rootIdentity = broker?.processIdentity;
    if (!child || !Number.isInteger(child.pid)) return [];
    if (!rootIdentity) throw new Error(`missing process identity for owned broker PID ${child.pid}; refusing uncertain cleanup`);
    sampleOwnedProcessIdentities(rootIdentity, registry);
    const currentRoot = identityForPid(rootIdentity.pid);
    if (currentRoot && !sameProcessIdentity(rootIdentity, currentRoot)) {
        throw new Error(`broker PID ${rootIdentity.pid} was reused; refusing to signal an uncertain process`);
    }
    const errors = [];
    if (process.platform === "win32") {
        if (currentRoot) {
            const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 5000,
                maxBuffer: 1024 * 1024,
            });
            if (result.status !== 0) errors.push(`taskkill failed for broker ${child.pid}: ${cleanupCommandError(result)}`);
        }
        await waitForChildExit(child, 5000);
    } else if (currentRoot) {
        try {
            process.kill(-child.pid, "SIGTERM");
        } catch (error) {
            errors.push(`process-group SIGTERM failed for broker ${child.pid}: ${error.code || error.message}`);
        }
        if (!(await waitForChildExit(child, 3000))) {
            const verifiedRoot = identityForPid(rootIdentity.pid);
            if (verifiedRoot && !sameProcessIdentity(rootIdentity, verifiedRoot)) {
                errors.push(`broker PID ${rootIdentity.pid} was reused before SIGKILL; signal refused`);
            } else if (verifiedRoot) {
                try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
                    errors.push(`process-group SIGKILL failed for broker ${child.pid}: ${error.code || error.message}`);
                }
            }
            await waitForChildExit(child, 2000);
        }
    }

    let survivors = await waitForOwnedProcessesExit(registry, 1000);
    for (const identity of survivors.filter((item) => item.pid !== rootIdentity.pid)) {
        const current = identityForPid(identity.pid);
        if (!sameProcessIdentity(identity, current)) continue;
        if (process.platform === "win32") {
            const result = spawnSync("taskkill", ["/PID", String(identity.pid), "/T", "/F"], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 5000,
                maxBuffer: 1024 * 1024,
            });
            if (result.status !== 0) errors.push(`taskkill failed for descendant ${identity.pid}: ${cleanupCommandError(result)}`);
        } else {
            try { process.kill(identity.pid, "SIGKILL"); } catch (error) {
                errors.push(`SIGKILL failed for descendant ${identity.pid}: ${error.code || error.message}`);
            }
        }
    }
    survivors = await waitForOwnedProcessesExit(registry, 1000);
    if (survivors.length > 0) errors.push(`survivors: ${describeProcessIdentities(survivors)}`);
    if (errors.length > 0) throw new Error(errors.join("; "));
    return survivors;
}

function brokerRssBytes(pid) {
    const result = process.platform === "win32"
        ? spawnSync("powershell.exe", hiddenWindowsPowerShellArgs([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write([int64]$p.WorkingSet64)`,
        ]), { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })
        : spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 1024 * 1024,
        });
    if (result.status !== 0) throw new Error(`could not read broker RSS for PID ${pid}`);
    const value = Number(String(result.stdout || "").trim());
    const bytes = process.platform === "win32" ? value : value * 1024;
    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error(`broker RSS was invalid for PID ${pid}`);
    return bytes;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KiB`;
    return `${(bytes / 1024 ** 2).toFixed(1)}MiB`;
}

function requestSpec(index, baseUrl, ownerId, token, round) {
    const rpcUrl = `${baseUrl}/v1/owners/${ownerId}/rpc`;
    const rpcHeaders = { "content-type": "application/json", "x-ccc-device-token": token };
    switch (index % 4) {
        case 0:
            return { name: "health", url: `${baseUrl}/health`, options: { method: "GET" } };
        case 1:
            return { name: "status", url: `${baseUrl}/status`, options: { method: "GET" } };
        case 2:
            return {
                name: "rpc-status",
                url: rpcUrl,
                options: { method: "POST", headers: rpcHeaders, body: JSON.stringify({ method: "broker.status", params: {} }) },
            };
        default: {
            const nonce = `${round}-${index}-${randomUUID()}`;
            return {
                name: "rpc-echo",
                url: rpcUrl,
                options: { method: "POST", headers: rpcHeaders, body: JSON.stringify({ method: "broker.echo", params: { nonce } }) },
                validate: (body) => body?.result?.params?.nonce === nonce,
            };
        }
    }
}

async function runDurability(options) {
    if (!existsSync(cliPath)) throw new Error("dist/index.js is missing; run npm run build");
    const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-durability-"));
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let broker = startOwnedBroker(homeDir, port);
    let identity = null;
    let rssBaseline = 0;
    let started = 0;
    let completed = 0;
    let requests = 0;
    let slowestMs = 0;
    let restarts = 0;
    let maxRssGrowth = 0;
    let failure = null;
    let cleanupSurvivors = [];
    const ownedProcesses = new Map();
    const counts = new Map();

    const assertSurvivors = (survivors, phase) => {
        if (options.maxSurvivors >= 0 && survivors.length > options.maxSurvivors) {
            throw new Error(`${phase} left ${survivors.length} owned process(es) alive: ${describeProcessIdentities(survivors)}`);
        }
    };
    const bindBrokerProcessIdentity = async () => {
        broker.processIdentity = await waitForProcessIdentity(broker.child);
        ownedProcesses.set(processIdentityKey(broker.processIdentity), broker.processIdentity);
        sampleOwnedProcessIdentities(broker.processIdentity, ownedProcesses);
    };
    const sampleBrokerProcesses = () => {
        if (!broker.processIdentity) throw new Error(`missing broker process identity for PID ${broker.child.pid}`);
        sampleOwnedProcessIdentities(broker.processIdentity, ownedProcesses);
    };
    const sampleRss = () => {
        if (!options.maxRssGrowthBytes) return 0;
        sampleBrokerProcesses();
        const rss = brokerRssBytes(broker.child.pid);
        const growth = Math.max(0, rss - rssBaseline);
        maxRssGrowth = Math.max(maxRssGrowth, growth);
        if (growth > options.maxRssGrowthBytes) {
            throw new Error(`broker RSS grew ${formatBytes(growth)}; limit is ${formatBytes(options.maxRssGrowthBytes)}`);
        }
        return growth;
    };
    const assertRpcRecovery = async () => {
        const nonce = `restart-${restarts}-${randomUUID()}`;
        const spec = requestSpec(3, baseUrl, identity.ownerId, identity.token, nonce);
        const result = await requestJson(spec.url, spec.options, options.timeoutMs);
        if (!spec.validate(result.body) || result.body?.result?.ownerId !== identity.ownerId) {
            throw new Error("authenticated RPC did not recover after broker restart");
        }
        requests += 1;
        counts.set("rpc-echo", (counts.get("rpc-echo") || 0) + 1);
        slowestMs = Math.max(slowestMs, result.elapsedMs);
    };
    const restartBroker = async () => {
        sampleRss();
        sampleBrokerProcesses();
        const previousProcessIdentity = broker.processIdentity;
        const previousIdentity = identity;
        const survivors = await stopOwnedChild(broker, ownedProcesses);
        assertSurvivors(survivors, `restart ${restarts + 1} cleanup`);
        broker = startOwnedBroker(homeDir, port);
        await bindBrokerProcessIdentity();
        await waitForBroker(baseUrl, options.timeoutMs, broker);
        identity = await waitForBrokerIdentity(homeDir, broker.child.pid, options.timeoutMs);
        if (sameProcessIdentity(broker.processIdentity, previousProcessIdentity)) {
            throw new Error("broker restart retained the previous process identity");
        }
        if (identity.ownerId !== previousIdentity.ownerId || identity.token !== previousIdentity.token) {
            throw new Error("broker owner identity changed across restart");
        }
        restarts += 1;
        rssBaseline = options.maxRssGrowthBytes ? brokerRssBytes(broker.child.pid) : 0;
        await assertRpcRecovery();
    };

    try {
        await bindBrokerProcessIdentity();
        await waitForBroker(baseUrl, options.timeoutMs, broker);
        identity = await waitForBrokerIdentity(homeDir, broker.child.pid, options.timeoutMs);
        rssBaseline = options.maxRssGrowthBytes ? brokerRssBytes(broker.child.pid) : 0;
        started = Date.now();
        const iterationLabel = options.iterations === Number.MAX_SAFE_INTEGER ? "duration-bound" : options.iterations;
        console.log(`device-lab durability: port=${port} iterations=${iterationLabel} concurrency=${options.concurrency} restartEvery=${options.restartEvery || "off"} maxRssGrowth=${options.maxRssGrowthBytes ? formatBytes(options.maxRssGrowthBytes) : "off"}${options.durationMs ? ` duration=${options.durationMs}ms` : ""}`);

        while (completed < options.iterations && (!options.durationMs || Date.now() - started < options.durationMs)) {
            const round = completed + 1;
            const specs = Array.from({ length: options.concurrency }, (_, index) => requestSpec(index, baseUrl, identity.ownerId, identity.token, round));
            const results = await Promise.all(specs.map(async (spec) => {
                try {
                    const result = await requestJson(spec.url, spec.options, options.timeoutMs);
                    if (spec.validate && !spec.validate(result.body)) throw new Error("response validation failed");
                    counts.set(spec.name, (counts.get(spec.name) || 0) + 1);
                    return result;
                } catch (error) {
                    throw new Error(`round ${round} ${spec.name}: ${error.message}`);
                }
            }));
            completed = round;
            requests += results.length;
            slowestMs = Math.max(slowestMs, ...results.map((result) => result.elapsedMs));
            sampleBrokerProcesses();
            if (options.maxRssGrowthBytes && completed % options.rssSampleEvery === 0) sampleRss();
            if (completed % options.progressEvery === 0 || completed === options.iterations) {
                console.log(`progress: rounds=${completed} requests=${requests} restarts=${restarts} elapsed=${Date.now() - started}ms slowest=${slowestMs}ms rssGrowth=${formatBytes(maxRssGrowth)}`);
            }
            const moreWork = completed < options.iterations && (!options.durationMs || Date.now() - started < options.durationMs);
            if (moreWork && options.restartEvery && completed % options.restartEvery === 0) {
                await restartBroker();
            }
        }
        const required = ["health", "status", "rpc-status", "rpc-echo"];
        for (const name of required) {
            if (!counts.get(name)) throw new Error(`${name} was not exercised`);
        }
        sampleRss();
    } catch (error) {
        const detail = broker.stderr.trim().split(/\r?\n/).slice(-1)[0];
        failure = new Error(`${error.message}${detail ? `; broker: ${detail}` : ""}`);
    } finally {
        try {
            sampleBrokerProcesses();
            cleanupSurvivors = await stopOwnedChild(broker, ownedProcesses);
            const finalSurvivors = liveOwnedProcessIdentities(ownedProcesses);
            assertSurvivors(finalSurvivors, "final cleanup");
            cleanupSurvivors = finalSurvivors;
        } catch (error) {
            failure = new Error(`${failure ? `${failure.message}; ` : ""}cleanup guard: ${error.message}`);
        }
        const evidence = finalizeDurabilityEvidence(homeDir, failure);
        failure = evidence.failure;
    }
    if (failure) throw failure;
    console.log(`PASS device-lab durability: rounds=${completed} requests=${requests} restarts=${restarts} elapsed=${Date.now() - started}ms slowest=${slowestMs}ms rssGrowth=${formatBytes(maxRssGrowth)} survivors=${cleanupSurvivors.length}`);
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`device-lab durability: ${error.message}`);
        console.error(usage());
        process.exitCode = 2;
        return;
    }
    if (options.help) {
        console.log(usage());
        return;
    }
    try {
        await runDurability(options);
    } catch (error) {
        console.error(`FAIL device-lab durability: ${error.message}`);
        process.exitCode = 1;
    }
}

await main();
