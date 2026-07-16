#!/usr/bin/env node

import { spawn, spawnSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { androidDiscovery } from "../../device-lab-mcp/src/backends/android.mjs";
import { ownerId as currentOwnerId } from "../../device-lab-mcp/src/context.mjs";
import {
    describeProcessIdentities,
    identityForPid,
    liveOwnedProcessIdentities,
    processIdentityKey,
    processIdentitySnapshot,
    sameProcessIdentity,
    sampleOwnedProcessIdentities,
} from "./process-identity.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const realTestRunner = join(repoRoot, "scripts", "real-tests", "run.mjs");
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const PROCESS_SAMPLE_INTERVAL_MS = 50;

export const REAL_PROVIDER_TARGETS = Object.freeze({
    "android-emulator": {
        module: "scripts/real-tests/level2-android-emulator-e2e.mjs",
        backendState: "android",
        devicePrefix: "android-real-e2e-",
        tempPrefixes: ["ccc-android-emulator-e2e-"],
        destructive: "Creates, boots, controls, stops, and deletes a disposable Android emulator and AVD.",
    },
    "android-device": {
        module: "scripts/real-tests/level2-android-device-e2e.mjs",
        backendState: "android-device",
        devicePrefix: "android-device-real-e2e-",
        tempPrefixes: ["android-device-e2e-"],
        destructive: "Uses the configured physical Android device, changes device/app state, and may install/uninstall the configured APK.",
    },
    "windows-sandbox": {
        module: "scripts/real-tests/level2-windows-sandbox.mjs",
        backendState: "windows",
        devicePrefix: "windows-real-sandbox-",
        tempPrefixes: ["ccc-windows-sandbox-e2e-"],
        destructive: "Creates, controls, stops, and deletes a disposable Windows Sandbox session.",
        requireNoExistingWindowsSandbox: true,
    },
});

function usage() {
    return [
        "Usage: npm run test:durability:device-lab:real -- --target <target> [options]",
        "",
        `Targets: ${Object.keys(REAL_PROVIDER_TARGETS).join(" | ")}`,
        "",
        "Options:",
        "  --cycles <n>    Number of complete real E2E cycles, 1-100 (default: 10)",
        "  --timeout <t>   Per-cycle timeout, for example 10m or 30m (default: 20m)",
        "  --dry-run       Validate and print the execution plan without creating devices",
        "  --help          Show this help",
        "",
        "WARNING: This command runs destructive or physical-provider E2E operations.",
        "It fails rather than stopping a pre-existing Windows Sandbox session.",
    ].join("\n");
}

function positiveInteger(value, name, maximum) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new Error(`${name} must be an integer from 1 to ${maximum}`);
    }
    return parsed;
}

function durationMs(value, name) {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(String(value));
    if (!match) throw new Error(`${name} must be a duration such as 30s, 10m, or 1h`);
    const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match[2] || "ms").toLowerCase()];
    const parsed = Math.ceil(Number(match[1]) * factor);
    if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 24 * 3_600_000) {
        throw new Error(`${name} must be between 1s and 24h`);
    }
    return parsed;
}

export function parseRealProviderCycleArgs(args) {
    const options = { target: "", cycles: 10, timeoutMs: 20 * 60_000, dryRun: false, help: false };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        const next = () => {
            const value = args[index + 1];
            if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
            index += 1;
            return value;
        };
        if (argument === "--target") options.target = next();
        else if (argument === "--cycles") options.cycles = positiveInteger(next(), argument, 100);
        else if (argument === "--timeout") options.timeoutMs = durationMs(next(), argument);
        else if (argument === "--dry-run") options.dryRun = true;
        else if (argument === "--help" || argument === "-h") options.help = true;
        else throw new Error(`unknown option: ${argument}`);
    }
    if (!options.help && !REAL_PROVIDER_TARGETS[options.target]) {
        throw new Error(`--target must be one of: ${Object.keys(REAL_PROVIDER_TARGETS).join(", ")}`);
    }
    return options;
}

function readOptionalJson(path, kind) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return { exists: false, value: null };
        throw new Error(`${kind} metadata unreadable at ${path}: ${error?.code || error?.message || error}`);
    }
    try {
        return { exists: true, value: JSON.parse(text) };
    } catch (error) {
        throw new Error(`${kind} metadata malformed at ${path}: ${error.message}`);
    }
}

function listOptionalDirectory(path, kind) {
    try {
        return readdirSync(path);
    } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw new Error(`${kind} directory unreadable at ${path}: ${error?.code || error?.message || error}`);
    }
}

function matchingEntries(path, prefix) {
    return listOptionalDirectory(path, "test artifact")
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => join(path, entry));
}

export function listAndroidAvdNames(options = {}) {
    if (options.names) return [...options.names];
    const avdmanager = options.avdmanager || androidDiscovery().avdmanager;
    if (!avdmanager) throw new Error("Android AVD inventory unavailable: missing avdmanager");
    const result = (options.spawnSyncImpl || spawnSync)(avdmanager, ["list", "avd", "-c"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`Android AVD inventory failed: ${cleanupCommandError(result)}`);
    }
    return String(result.stdout || "").split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
}

export function inspectTestOwnedResidue(target, options = {}) {
    const definition = REAL_PROVIDER_TARGETS[target];
    if (!definition) throw new Error(`unknown target: ${target}`);
    const home = options.home || homedir();
    const owner = options.owner || currentOwnerId();
    const root = join(home, ".ccc", "devices");
    const backendRoot = join(root, "owners", owner, definition.backendState);
    const statePath = join(backendRoot, "devices.json");
    const stateMetadata = readOptionalJson(statePath, "device state");
    const state = stateMetadata.value;
    if (stateMetadata.exists && (!state || typeof state !== "object" || !Array.isArray(state.devices))) {
        throw new Error(`device state metadata malformed at ${statePath}: expected an object with devices[]`);
    }
    const residue = [];
    for (const device of Array.isArray(state?.devices) ? state.devices : []) {
        if (String(device?.id || "").startsWith(definition.devicePrefix)) {
            residue.push(`device-state:${device.id}`);
        }
    }
    for (const path of matchingEntries(backendRoot, definition.devicePrefix)) residue.push(`owner-artifact:${path}`);

    const leaseRoot = join(root, "physical-leases", definition.backendState, "locks");
    {
        for (const entry of listOptionalDirectory(leaseRoot, "physical lease").filter((name) => name.endsWith(".json"))) {
            const path = join(leaseRoot, entry);
            const leaseMetadata = readOptionalJson(path, "physical lease");
            const lease = leaseMetadata.value;
            if (!lease || typeof lease !== "object" || typeof lease.ownerId !== "string" || typeof lease.deviceId !== "string") {
                throw new Error(`physical lease metadata malformed at ${path}: expected ownerId and deviceId strings`);
            }
            if (lease?.ownerId === owner && String(lease?.deviceId || "").startsWith(definition.devicePrefix)) {
                residue.push(`physical-lease:${path}`);
            }
        }
    }
    const leaseAggregatePath = join(root, "physical-leases", `${definition.backendState}.json`);
    const leaseAggregateMetadata = readOptionalJson(leaseAggregatePath, "physical lease aggregate");
    const leaseAggregate = leaseAggregateMetadata.value;
    if (leaseAggregateMetadata.exists && (!leaseAggregate || typeof leaseAggregate !== "object" || !Array.isArray(leaseAggregate.leases))) {
        throw new Error(`physical lease aggregate metadata malformed at ${leaseAggregatePath}: expected an object with leases[]`);
    }
    for (const lease of Array.isArray(leaseAggregate?.leases) ? leaseAggregate.leases : []) {
        if (lease?.ownerId === owner && String(lease?.deviceId || "").startsWith(definition.devicePrefix)) {
            residue.push(`physical-lease-aggregate:${leaseAggregatePath}:${lease.deviceId}`);
        }
    }

    if (target === "windows-sandbox") {
        const lockPath = join(root, "host-locks", "windows-sandbox.json");
        const lockMetadata = readOptionalJson(lockPath, "Windows Sandbox host lock");
        const lock = lockMetadata.value;
        if (lockMetadata.exists && (!lock || typeof lock !== "object" || typeof lock.ownerId !== "string" || typeof lock.deviceId !== "string")) {
            throw new Error(`Windows Sandbox host lock metadata malformed at ${lockPath}: expected ownerId and deviceId strings`);
        }
        if (lock?.ownerId === owner && String(lock?.deviceId || "").startsWith(definition.devicePrefix)) {
            residue.push(`host-lock:${lockPath}`);
        }
    }
    if (target === "android-emulator") {
        const testAvdPrefix = `ccc-${owner}-real-android-e2e-`;
        const names = (options.listAndroidAvds || listAndroidAvdNames)(options.androidAvdOptions || {});
        for (const name of names) {
            if (name.startsWith(testAvdPrefix)) residue.push(`sdk-avd:${name}`);
        }
    }
    return residue;
}

export function snapshotTestTempArtifacts(target, options = {}) {
    const definition = REAL_PROVIDER_TARGETS[target];
    const roots = [options.tempRoot || tmpdir()];
    if (target === "android-device") roots.push(join(options.repoRoot || repoRoot, "results", "device-lab-real"));
    const paths = new Set();
    for (const root of roots) {
        for (const prefix of definition.tempPrefixes) {
            for (const path of matchingEntries(root, prefix)) paths.add(path);
        }
    }
    return paths;
}

export function realProviderCycleCommand(target) {
    const definition = REAL_PROVIDER_TARGETS[target];
    if (!definition) throw new Error(`unknown target: ${target}`);
    return {
        command: process.execPath,
        args: [realTestRunner, "--compact", "--fail-on-skip", resolve(repoRoot, definition.module)],
    };
}

function appendBounded(current, chunk) {
    const combined = Buffer.from(`${current}${chunk}`);
    return combined.length <= OUTPUT_LIMIT_BYTES
        ? combined.toString("utf8")
        : combined.subarray(combined.length - OUTPUT_LIMIT_BYTES).toString("utf8");
}

function cleanupCommandError(result) {
    return result.error?.message || String(result.stderr || result.stdout || `status ${result.status}`).trim();
}

export async function terminateTimedOutProcessTree(child, rootIdentity, registry, options = {}) {
    const platform = options.platform || process.platform;
    const snapshot = options.snapshot || processIdentitySnapshot;
    const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    const killImpl = options.killImpl || process.kill.bind(process);
    const sleep = options.sleep || ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    const verificationTimeoutMs = options.verificationTimeoutMs ?? 5000;
    const errors = [];
    try {
        sampleOwnedProcessIdentities(rootIdentity, registry, snapshot());
    } catch (error) {
        errors.push(`identity sampling failed: ${error.message}`);
    }

    let currentSnapshot;
    try {
        currentSnapshot = snapshot();
    } catch (error) {
        return { ok: false, errors: [...errors, `identity verification failed: ${error.message}`], survivors: [] };
    }
    const currentRoot = identityForPid(rootIdentity.pid, currentSnapshot);
    if (currentRoot && !sameProcessIdentity(rootIdentity, currentRoot)) {
        errors.push(`root PID ${rootIdentity.pid} was reused; cleanup signal was refused`);
    } else if (currentRoot) {
        if (platform === "win32") {
            const result = spawnSyncImpl("taskkill", ["/PID", String(rootIdentity.pid), "/T", "/F"], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 10_000,
                maxBuffer: 1024 * 1024,
            });
            if (result.status !== 0) errors.push(`taskkill failed for ${rootIdentity.pid}: ${cleanupCommandError(result)}`);
        } else {
            try {
                killImpl(-rootIdentity.pid, "SIGKILL");
            } catch (error) {
                errors.push(`process-group SIGKILL failed for ${rootIdentity.pid}: ${error.code || error.message}`);
            }
        }
    }

    let survivors = [];
    const deadline = Date.now() + verificationTimeoutMs;
    do {
        try {
            survivors = liveOwnedProcessIdentities(registry, snapshot());
        } catch (error) {
            errors.push(`survivor verification failed: ${error.message}`);
            break;
        }
        if (survivors.length === 0 || Date.now() >= deadline) break;
        await sleep(50);
    } while (true);

    for (const identity of survivors.filter((item) => item.pid !== rootIdentity.pid)) {
        let current;
        try {
            current = identityForPid(identity.pid, snapshot());
        } catch (error) {
            errors.push(`descendant ${identity.pid} identity verification failed: ${error.message}`);
            continue;
        }
        if (!sameProcessIdentity(identity, current)) continue;
        if (platform === "win32") {
            const result = spawnSyncImpl("taskkill", ["/PID", String(identity.pid), "/T", "/F"], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 10_000,
                maxBuffer: 1024 * 1024,
            });
            if (result.status !== 0) errors.push(`taskkill failed for descendant ${identity.pid}: ${cleanupCommandError(result)}`);
        } else {
            try { killImpl(identity.pid, "SIGKILL"); } catch (error) {
                errors.push(`SIGKILL failed for descendant ${identity.pid}: ${error.code || error.message}`);
            }
        }
    }
    try {
        survivors = liveOwnedProcessIdentities(registry, snapshot());
    } catch (error) {
        errors.push(`final survivor verification failed: ${error.message}`);
    }
    if (survivors.length > 0) errors.push(`survivors: ${describeProcessIdentities(survivors)}`);
    return { ok: errors.length === 0 && survivors.length === 0, errors, survivors };
}

export async function verifySuccessfulProcessTree(rootIdentity, registry, options = {}) {
    const snapshot = options.snapshot || processIdentitySnapshot;
    const sleep = options.sleep || ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    const boundarySamples = options.boundarySamples ?? 3;
    const boundaryDelayMs = options.boundaryDelayMs ?? PROCESS_SAMPLE_INTERVAL_MS;
    const errors = [];

    for (let index = 0; index < boundarySamples; index += 1) {
        try {
            sampleOwnedProcessIdentities(rootIdentity, registry, snapshot());
        } catch (error) {
            errors.push(`success-boundary identity sampling failed: ${error.message}`);
            break;
        }
        if (index + 1 < boundarySamples) await sleep(boundaryDelayMs);
    }

    let survivors = [];
    try {
        survivors = liveOwnedProcessIdentities(registry, snapshot());
    } catch (error) {
        errors.push(`success-boundary survivor verification failed: ${error.message}`);
    }
    if (survivors.length > 0) errors.push(`survivors: ${describeProcessIdentities(survivors)}`);
    return { ok: errors.length === 0 && survivors.length === 0, errors, survivors };
}

export async function runCycle(target, timeout, spawnImpl = spawn, options = {}) {
    // Fail before spawning when the host cannot provide PID-reuse-safe identities.
    (options.processIdentitySnapshot || processIdentitySnapshot)();
    const spec = realProviderCycleCommand(target);
    const child = spawnImpl(spec.command, spec.args, {
        cwd: repoRoot,
        env: { ...process.env, CCC_TEST_LEVEL: "2" },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const rootIdentity = identityForPid(child.pid);
    if (!rootIdentity) throw new Error(`could not capture process identity for cycle runner PID ${child.pid}`);
    const processRegistry = new Map([[processIdentityKey(rootIdentity), rootIdentity]]);
    let samplingError = null;
    const sampleProcesses = () => {
        if (samplingError) return;
        try {
            sampleOwnedProcessIdentities(rootIdentity, processRegistry);
        } catch (error) {
            samplingError = error;
        }
    };
    sampleProcesses();
    const samplingTimer = setInterval(sampleProcesses, PROCESS_SAMPLE_INTERVAL_MS);
    samplingTimer.unref?.();
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
        sampleProcesses();
        output = appendBounded(output, chunk);
    });
    child.stderr?.on("data", (chunk) => {
        sampleProcesses();
        output = appendBounded(output, chunk);
    });
    return await new Promise((resolveRun) => {
        let settled = false;
        let timedOut = false;
        const settle = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(samplingTimer);
            resolveRun(result);
        };
        const timer = setTimeout(async () => {
            timedOut = true;
            let cleanup;
            try {
                cleanup = samplingError
                    ? { ok: false, errors: [`process sampling failed before timeout: ${samplingError.message}`], survivors: [] }
                    : await terminateTimedOutProcessTree(child, rootIdentity, processRegistry);
            } catch (error) {
                cleanup = { ok: false, errors: [`timeout cleanup threw: ${error.message}`], survivors: [] };
            }
            settle({ code: child.exitCode, signal: child.signalCode || "timeout", timedOut: true, cleanup, output: output.trim() });
        }, timeout);
        child.once("error", async (error) => {
            if (settled) return;
            sampleProcesses();
            let processTree;
            try {
                processTree = await terminateTimedOutProcessTree(child, rootIdentity, processRegistry);
                if (samplingError) {
                    processTree.ok = false;
                    processTree.errors.unshift(`process sampling failed after runner error: ${samplingError.message}`);
                }
            } catch (cleanupError) {
                processTree = { ok: false, errors: [`runner-error cleanup threw: ${cleanupError.message}`], survivors: [] };
            }
            settle({
                code: child.exitCode,
                signal: child.signalCode || "spawn-error",
                timedOut: false,
                processTree,
                cleanup: processTree,
                output: appendBounded(output, error.message).trim(),
            });
        });
        child.once("exit", async (code, signal) => {
            if (timedOut) return;
            clearTimeout(timer);
            sampleProcesses();
            let processTree;
            if (code === 0) {
                processTree = samplingError
                    ? { ok: false, errors: [`process sampling failed during successful cycle: ${samplingError.message}`], survivors: [] }
                    : await verifySuccessfulProcessTree(rootIdentity, processRegistry);
            } else {
                try {
                    processTree = await terminateTimedOutProcessTree(child, rootIdentity, processRegistry);
                    if (samplingError) {
                        processTree.ok = false;
                        processTree.errors.unshift(`process sampling failed during failed cycle: ${samplingError.message}`);
                    }
                } catch (error) {
                    processTree = { ok: false, errors: [`failed-cycle cleanup threw: ${error.message}`], survivors: [] };
                }
            }
            settle({ code, signal, timedOut, processTree, cleanup: code === 0 ? undefined : processTree, output: output.trim() });
        });
    });
}

function runningWindowsSandboxSessions() {
    if (process.platform !== "win32") return [];
    const command = [
        "$items = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'WindowsSandbox|WindowsSandboxClient' })",
        "$items | Select-Object -ExpandProperty Id | ConvertTo-Json -Compress",
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) throw new Error("could not verify existing Windows Sandbox sessions");
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isInteger);
}

function formatElapsed(milliseconds) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
    const options = parseRealProviderCycleArgs(args);
    if (options.help) {
        console.log(usage());
        return 0;
    }
    const definition = REAL_PROVIDER_TARGETS[options.target];
    const spec = realProviderCycleCommand(options.target);
    console.log(`REAL PROVIDER DURABILITY target=${options.target} cycles=${options.cycles} timeout=${formatElapsed(options.timeoutMs)}`);
    console.log(`WARNING ${definition.destructive}`);
    if (options.dryRun) {
        console.log(`DRY RUN ${spec.command} ${spec.args.join(" ")}`);
        return 0;
    }

    const inspectResidue = dependencies.inspectTestOwnedResidue || inspectTestOwnedResidue;
    const inspectArtifacts = dependencies.snapshotTestTempArtifacts || snapshotTestTempArtifacts;
    const inspectWindowsSessions = dependencies.runningWindowsSandboxSessions || runningWindowsSandboxSessions;
    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
        if (definition.requireNoExistingWindowsSandbox) {
            const sessions = inspectWindowsSessions();
            if (sessions.length > 0) {
                throw new Error(`refusing cycle ${cycle}/${options.cycles} while a Windows Sandbox session is active (PIDs: ${sessions.join(", ")})`);
            }
        }
        const beforeResidue = inspectResidue(options.target);
        const beforeArtifacts = [...inspectArtifacts(options.target)];
        if (beforeResidue.length > 0 || beforeArtifacts.length > 0) {
            throw new Error(`test-owned residue before cycle ${cycle}: ${[
                ...beforeResidue,
                ...beforeArtifacts.map((path) => `temp-artifact:${path}`),
            ].join(", ")}`);
        }
        const started = Date.now();
        let result = null;
        const failures = [];
        try {
            result = await (dependencies.runCycle || runCycle)(options.target, options.timeoutMs);
        } catch (error) {
            failures.push(`cycle runner threw: ${error.message}`);
        }
        const elapsed = Date.now() - started;
        if (result?.timedOut) {
            const cleanup = result.cleanup || { ok: false, errors: ["cleanup result missing"], survivors: [] };
            const cleanupDetail = cleanup.ok
                ? "process tree terminated and verified"
                : `cleanup failed (${cleanup.errors.join("; ") || "unknown error"})`;
            failures.push(`timed out after ${formatElapsed(options.timeoutMs)}; ${cleanupDetail}`);
        }
        if (result && !result.timedOut && result.code !== 0) {
            failures.push(`failed with ${result.signal || `exit ${result.code}`}\n${result.output || "<no output>"}`);
        }
        if (result && !result.timedOut) {
            const processTree = result.processTree || {
                ok: false,
                errors: ["cycle process-tree verification result missing"],
                survivors: [],
            };
            if (!processTree.ok) {
                failures.push(`process-tree cleanup/verification failed: ${processTree.errors.join("; ") || "unknown error"}`);
            }
        }
        if (definition.requireNoExistingWindowsSandbox) {
            try {
                const sessions = inspectWindowsSessions();
                if (sessions.length > 0) failures.push(`Windows Sandbox session remained or appeared (PIDs: ${sessions.join(", ")})`);
            } catch (error) {
                failures.push(`Windows Sandbox post-cycle inspection failed: ${error.message}`);
            }
        }
        try {
            const residue = inspectResidue(options.target);
            const artifacts = [...inspectArtifacts(options.target)];
            if (residue.length > 0 || artifacts.length > 0) {
                failures.push(`leaked test-owned resources: ${[...residue, ...artifacts.map((path) => `temp-artifact:${path}`)].join(", ")}`);
            }
        } catch (error) {
            failures.push(`post-cycle residue inspection failed: ${error.message}`);
        }
        if (failures.length > 0) {
            throw new Error(`cycle ${cycle}/${options.cycles} failed: ${failures.join("; ")}`);
        }
        console.log(`PASS cycle=${cycle}/${options.cycles} target=${options.target} duration=${formatElapsed(elapsed)}`);
    }
    console.log(`PASS real-provider durability target=${options.target} cycles=${options.cycles}`);
    return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().then((code) => { process.exitCode = code; }).catch((error) => {
        console.error(`FAIL ${error?.message || String(error)}`);
        process.exitCode = 1;
    });
}
