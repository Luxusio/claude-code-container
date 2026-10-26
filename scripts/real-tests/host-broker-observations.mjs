import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 17373;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 262144;
const listenerArgs = ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-Fp"];

function nativeReceipt(result) {
    return {
        status: result.status ?? null,
        signal: result.signal ?? null,
        ...(result.error ? { error: { code: result.error.code || "NATIVE_COMMAND_FAILED" } } : {}),
        stdout: result.stdout || "",
        stderr: result.stderr || "",
    };
}

function runNative(executable, args) {
    return nativeReceipt(spawnSync(executable, args, {
        encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES, windowsHide: true,
    }));
}

function observeNative(run, executable, args) {
    try { return nativeReceipt(run(executable, args)); }
    catch (error) { return nativeReceipt({ error }); }
}

function succeeded(receipt) {
    return receipt.status === 0 && receipt.signal === null && !receipt.error;
}

function listenerPids(receipt) {
    if (!succeeded(receipt)) return [];
    const pids = new Set();
    for (const line of receipt.stdout.split(/\r?\n/).filter(Boolean)) {
        if (/^f\d+$/.test(line)) continue;
        const match = /^p([1-9]\d*)$/.exec(line);
        const pid = match ? Number(match[1]) : 0;
        if (!Number.isSafeInteger(pid) || pid <= 0) return [];
        pids.add(pid);
    }
    return [...pids];
}

function selectFields(record, fields) {
    const selected = {};
    if (!record || typeof record !== "object" || Array.isArray(record)) return selected;
    for (const [key, type] of Object.entries(fields)) {
        const value = record[key];
        if (value === null || typeof value === type) selected[key] = value;
        else if (type === "strings" && Array.isArray(value)) {
            selected[key] = value.filter(item => typeof item === "string");
        }
    }
    return selected;
}

function runtimeFields(record) {
    const selected = selectFields(record, {
        name: "string", managedBy: "string", pid: "number", host: "string", port: "number",
        platform: "string", command: "string", args: "strings", cwd: "string", startedAt: "string",
        processStartToken: "string",
    });
    if (record?.processIdentity && typeof record.processIdentity === "object") {
        selected.processIdentity = selectFields(record.processIdentity, {
            pid: "number", startToken: "string", commandHash: "string",
        });
    }
    return selected;
}

function observationError(code) {
    return Object.assign(new Error(code), { code });
}

async function readStatusBody(response) {
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
        void response.body?.cancel().catch(() => {});
        throw observationError("HTTP_BODY_TOO_LARGE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw observationError("HTTP_INVALID_JSON");
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES) {
                void reader.cancel().catch(() => {});
                throw observationError("HTTP_BODY_TOO_LARGE");
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw observationError("HTTP_INVALID_JSON"); }
}

async function observeStatus(fetchImpl) {
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            controller.abort();
            reject(observationError("HTTP_TIMEOUT"));
        }, TIMEOUT_MS);
    });
    let status;
    try {
        const collect = async () => {
            const response = await fetchImpl(`http://127.0.0.1:${PORT}/status`, {
                method: "GET", redirect: "manual", signal: controller.signal,
            });
            status = { ok: response.ok, http: response.status };
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                throw observationError(response.status >= 300 && response.status < 400 ? "HTTP_REDIRECT" : "HTTP_STATUS");
            }
            const body = await readStatusBody(response);
            if (!body || typeof body !== "object" || Array.isArray(body)) throw observationError("HTTP_INVALID_JSON");
            const broker = body.broker;
            const service = selectFields(broker?.serviceManager, { platform: "string", command: "string" });
            if (Array.isArray(broker?.serviceManager?.command)) {
                service.command = broker.serviceManager.command.filter(item => typeof item === "string");
            }
            return {
                ...status,
                broker: selectFields(broker, {
                    name: "string", mode: "string", version: "string", host: "string", port: "number",
                    protocolVersion: "number", startedAt: "string",
                }),
                process: selectFields(broker?.process, { pid: "number", startToken: "string" }),
                service,
            };
        };
        return { status: await Promise.race([collect(), deadline]) };
    } catch (error) {
        const code = controller.signal.aborted ? "HTTP_TIMEOUT"
            : ["HTTP_REDIRECT", "HTTP_STATUS", "HTTP_BODY_TOO_LARGE", "HTTP_INVALID_JSON"].includes(error?.code)
                ? error.code : "HTTP_UNAVAILABLE";
        return { ...(status ? { status } : {}), statusError: { code } };
    } finally {
        clearTimeout(timeout);
    }
}

export async function collectHostBrokerObservations({
    cwd = process.cwd(), home = homedir(), run = runNative, readFile = readFileSync, fetchImpl = fetch,
} = {}) {
    const checkout = { cwd, realpath: null };
    try { checkout.realpath = realpathSync(cwd); }
    catch (error) { checkout.error = { code: error.code || "CHECKOUT_UNAVAILABLE" }; }
    const root = checkout.realpath || resolve(cwd);
    const listener = observeNative(run, "/usr/sbin/lsof", listenerArgs);
    const processes = listenerPids(listener).map(pid => {
        const command = observeNative(run, "/bin/ps", ["-ww", "-p", String(pid), "-o", "command="]);
        const start = observeNative(run, "/bin/ps", ["-p", String(pid), "-o", "lstart="]);
        return { pid, command, start, startToken: succeeded(start) && start.stdout.trim() ? `ps:${start.stdout.trim()}` : null };
    });
    let runtime;
    let runtimeError;
    try {
        const parsed = JSON.parse(readFile(join(home, ".ccc", "devices", "broker", "runtime.json"), "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw observationError("RUNTIME_INVALID_JSON");
        runtime = runtimeFields(parsed);
    } catch (error) {
        const code = error instanceof SyntaxError || error?.code === "RUNTIME_INVALID_JSON" ? "RUNTIME_INVALID_JSON"
            : ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "ELOOP"].includes(error?.code)
                ? error.code : "RUNTIME_UNAVAILABLE";
        runtimeError = { code };
    }
    const status = await observeStatus(fetchImpl);
    const listenerAfter = observeNative(run, "/usr/sbin/lsof", listenerArgs);
    return {
        at: new Date().toISOString(), checkout,
        node: { executable: process.execPath, version: process.version, platform: process.platform },
        expectedEntries: { cli: join(root, "dist", "index.js"), broker: join(root, "dist", "packages", "device-lab", "dist", "broker-entry.js") },
        listener, processes, ...(runtime ? { runtime } : {}), ...(runtimeError ? { runtimeError } : {}),
        ...status, listenerAfter,
    };
}

async function main(args) {
    if (args.length === 1 && args[0] === "--help") {
        console.log("Usage: node scripts/real-tests/host-broker-observations.mjs [--help]\nRead-only macOS observations for port 17373; no build required.\nOutputs selected JSON observations, including unavailable results. Completion does not establish broker readiness.");
        return 0;
    }
    if (args.length) {
        console.error("Usage: node scripts/real-tests/host-broker-observations.mjs [--help]");
        return 1;
    }
    if (process.platform !== "darwin") {
        console.error("This diagnostic requires macOS (Darwin). Run it from the Mac checkout root.");
        return 1;
    }
    console.log(JSON.stringify(await collectHostBrokerObservations(), null, 2));
    return 0;
}

let directEntry = false;
try { directEntry = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
catch { /* An imported module need not have a filesystem entry point. */ }
if (directEntry) process.exitCode = await main(process.argv.slice(2));
