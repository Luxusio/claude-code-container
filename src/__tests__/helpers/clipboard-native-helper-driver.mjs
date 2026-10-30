import {spawn, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

export const nativeHelperCompilerCases = Object.freeze([
    "safe-missing-helper", "bin-symlink", "bin-writable", "run-symlink", "run-writable",
    "ccc-root-symlink", "ccc-root-writable", "substitute-bin",
]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
function startToken(pid) {
    const result = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "stat=", "-o", "lstart="],
        {encoding: "utf8", timeout: 1000});
    const match = result.status === 0 && /^(\S+)\s+(.+)$/.exec(result.stdout.trim());
    return match && !match[1].includes("Z") ? `ps:${match[2]}` : null;
}
async function bounded(promise, milliseconds, description) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(description)), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}
async function eventually(predicate, milliseconds, description) {
    const deadline = performance.now() + milliseconds;
    do {
        const value = predicate();
        if (value) return value;
        await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(20, Math.max(0, deadline - performance.now()))));
    } while (performance.now() < deadline);
    throw new Error(description);
}
function fileIdentity(path) {
    const stat = lstatSync(path, {bigint: true});
    return {inode: String(stat.ino), device: String(stat.dev), birthtime: String(stat.birthtimeNs),
        sha256: hash(readFileSync(path)), mode: Number(stat.mode & 0o777n)};
}
function sameFile(path, before) {
    try { return JSON.stringify(fileIdentity(path)) === JSON.stringify(before); } catch { return false; }
}

/** Actual emitted daemon/real compiler actor. No publication or clipboard request is sent. */
export async function runNativeHelperCompilerCase(entry, source, fixtureRoot, kind) {
    if (process.platform !== "darwin") throw new Error("A native Darwin host is required");
    if (!nativeHelperCompilerCases.includes(kind)) throw new Error("Unknown compiler fixture case");
    entry = resolve(entry); source = resolve(source); fixtureRoot = resolve(fixtureRoot);
    const ownedRoot = lstatSync(fixtureRoot);
    if (!ownedRoot.isDirectory() || ownedRoot.isSymbolicLink() || (ownedRoot.mode & 0o077) !== 0
        || ownedRoot.uid !== process.getuid()) throw new Error("A private owned fixture root is required");
    const area = join(fixtureRoot, kind); mkdirSync(area, {mode: 0o700});
    const home = join(area, "home"); mkdirSync(home, {mode: 0o700});
    const ccc = join(home, ".ccc"); mkdirSync(ccc, {mode: 0o700});
    const run = join(ccc, "run"); mkdirSync(run, {mode: 0o700});
    const bin = join(run, "bin");
    const sourceSha256 = hash(readFileSync(source));
    const helper = join(bin, `clipboard-helper-darwin-${sourceSha256.slice(0, 16)}`);
    const legacy = join(bin, "clipboard-helper-darwin");
    let legacyBefore;
    if (kind !== "safe-missing-helper") {
        mkdirSync(bin, {mode: 0o700});
        writeFileSync(legacy, "previous helper must not be executed or modified\n", {mode: 0o700});
        legacyBefore = fileIdentity(legacy);
    }
    if (kind.includes("symlink") || kind.includes("writable")) {
        const directory = kind.startsWith("bin-") ? bin : kind.startsWith("run-") ? run : ccc;
        if (kind.endsWith("symlink")) {
            const relocated = join(area, "owned-relocated-directory");
            renameSync(directory, relocated); symlinkSync(relocated, directory, "dir");
        } else chmodSync(directory, 0o777);
    }
    if (existsSync(helper)) throw new Error("The current helper must be absent before initialization");
    const log = join(area, "spawn-events.jsonl"), runtimeLog = join(area, "inert-runtime-invoked");
    const inertRuntime = join(area, "inert-native-runtime");
    writeFileSync(inertRuntime, `#!/bin/sh\n: > ${shellQuote(runtimeLog)}\nexit 96\n`, {mode: 0o700});
    const {NATIVE_RUNTIME_SELECTOR_KEYS} = await import(pathToFileURL(join(dirname(entry), "ports/container-runtime-invocation.js")).href);
    const invocation = {version: 1, runtime: "docker", executable: inertRuntime,
        transport: {kind: "docker", host: `unix://${join(area, "nonengine.sock")}`, configDirectory: join(area, "inert-config"),
            tls: {enabled: false, verify: false, caFile: null, certFile: null, keyFile: null}},
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null]))};
    const events = () => {
        if (!existsSync(log)) return [];
        // Ignore only an in-progress final append while the child is running.
        return readFileSync(log, "utf8").split("\n").slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
    };
    const probe = fileURLToPath(new URL("./clipboard-native-helper-probe.cjs", import.meta.url));
    const child = spawn(process.execPath, ["--require", probe, entry, "--serve", "--parent-publisher"], {
        env: {...process.env, HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            CCC_CLIPBOARD_NATIVE_HELPER_LOG: log, CCC_CLIPBOARD_NATIVE_HELPER_SUBSTITUTE: kind === "substitute-bin" ? "1" : "0"},
        stdio: ["ignore", "ignore", "ignore", "ipc"], cwd: area,
    });
    let spawnError;
    let resolveExit, resolveReady;
    // Install both lifecycle observations before dispatching initialization.
    const completion = new Promise(resolve => { resolveExit = resolve; });
    const readiness = new Promise(resolve => { resolveReady = resolve; });
    const fact = {kind, platform: process.platform, node: process.version, sourceSha256,
        entrySha256: hash(readFileSync(entry)), childPid: child.pid ?? null, childStartToken: null,
        publicationCommitted: false, ready: null, exit: null, failure: null, cleanupComplete: false, events: []};
    child.once("error", error => {
        spawnError = error.code ?? "spawn-failed";
        resolveReady({failure: "Owned daemon spawn failed"});
    });
    // stdio is ignored: the daemon's actual exit status is the required fact,
    // not a later IPC/stream close event. Absence alone never supplies status.
    child.once("exit", (status, signal) => {
        resolveExit({status, signal});
        resolveReady({failure: "Owned daemon exited before readiness"});
    });
    child.on("message", message => {
        if (message?.type === "committed") fact.publicationCommitted = true;
        if (message?.type === "ready") resolveReady({
            portValid: Number.isInteger(message.port) && message.port > 0 && message.port <= 65535,
            tokenValid: typeof message.token === "string" && /^[a-f0-9]{32}$/.test(message.token),
        });
    });
    const identity = child.pid ? startToken(child.pid) : null;
    fact.childStartToken = identity;
    const compilerCases = kind === "safe-missing-helper" || kind === "substitute-bin";
    try {
        if (!identity) throw new Error("Owned daemon start identity unavailable");
        child.send({type: "initialize", runtimeInvocation: invocation});
        const ready = await bounded(readiness, 5000, "Owned daemon readiness timed out");
        if (ready.failure) throw new Error(ready.failure);
        fact.ready = ready;
        if (compilerCases) {
            await eventually(() => events().some(event => event.kind === "compiler" && event.event === "close"),
                5000, "Real compiler completion was not observed");
            // Compiler close listeners run synchronously; observe the product's
            // publication/cleanup effect, not just the probe's preceding log.
            if (kind === "safe-missing-helper") {
                await eventually(() => existsSync(helper), 1000, "Compiled helper was not published");
                const stat = lstatSync(helper);
                fact.helper = {regular: stat.isFile(), symlink: stat.isSymbolicLink(), size: stat.size,
                    mode: stat.mode & 0o777, links: stat.nlink, sha256: hash(readFileSync(helper)),
                    header: readFileSync(helper).subarray(0, 4).toString("hex")};
            } else {
                await eventually(() => events().some(event => event.event === "substituted"), 1000, "Parent substitution did not occur");
            }
        }
    } catch (error) { fact.failure = error instanceof Error ? error.message : "Compiler fixture failed"; }
    finally {
        try {
            // On an interrupted compiler wait, settle only positively observed
            // children before disconnecting their still-owned daemon parent.
            for (const observed of events().filter(event => event.event === "spawn" && event.kind === "compiler")) {
                if (!events().some(event => event.event === "close" && event.pid === observed.pid)) {
                    if (!observed.startToken || startToken(observed.pid) !== observed.startToken) throw new Error("Compiler identity no longer qualifies cleanup");
                    process.kill(observed.pid, "SIGTERM");
                    await eventually(() => events().some(event => event.event === "close" && event.pid === observed.pid),
                        1500, "Owned compiler termination was not observed");
                }
            }
            if (child.exitCode === null && child.signalCode === null && child.connected) child.disconnect();
            try { fact.exit = await bounded(completion, 3000, "Owned daemon disconnect timed out"); }
            catch {
                if (!identity || startToken(child.pid) !== identity) throw new Error("Daemon identity no longer qualifies cleanup");
                child.kill("SIGTERM");
                fact.exit = await bounded(completion, 2000, "Owned daemon termination timed out");
            }
            fact.events = events();
            const compilers = fact.events.filter(event => event.kind === "compiler" && event.event === "spawn");
            fact.cleanupComplete = fact.exit !== null && compilers.every(event => fact.events.some(closed => closed.event === "close" && closed.pid === event.pid)
                && event.startToken && startToken(event.pid) !== event.startToken)
                && startToken(child.pid) !== identity;
        } catch (error) {
            fact.failure ??= error instanceof Error ? error.message : "Owned cleanup failed";
            // Do not keep the test driver alive through an unqualified foreign
            // successor. Its private fixture is retained for explicit recovery.
            if (child.connected) child.disconnect();
            child.unref();
        }
    }
    fact.events = events();
    fact.runtimeInvoked = existsSync(runtimeLog);
    fact.publicationAbsent = !existsSync(join(run, "clipboard.port"));
    fact.currentHelperAbsent = !existsSync(helper);
    const oldPath = kind === "substitute-bin" ? join(`${bin}.before-substitution`, basename(legacy)) : legacy;
    fact.legacyPreserved = !legacyBefore || sameFile(oldPath, legacyBefore);
    fact.stagesRemaining = existsSync(bin) ? readdirSync(bin).filter(name => name.startsWith(".clipboard-helper-")) : [];
    const compilerSpawns = fact.events.filter(event => event.kind === "compiler" && event.event === "spawn");
    const compilerCloses = fact.events.filter(event => event.kind === "compiler" && event.event === "close");
    const compilerSucceeded = compilerSpawns.length === 1 && compilerCloses.length === 1 && compilerCloses[0].status === 0
        && compilerCloses[0].signal === null && compilerSpawns[0].sourceSha256 === sourceSha256;
    if (kind === "substitute-bin") {
        const substitution = fact.events.find(event => event.event === "substituted");
        const replacement = substitution && join(bin, substitution.stage);
        fact.replacementPreserved = !!replacement && existsSync(replacement)
            && String(lstatSync(replacement, {bigint: true}).ino) === substitution.inode
            && hash(readFileSync(replacement)) === substitution.sha256
            && (lstatSync(replacement).mode & 0o777) === substitution.mode;
    }
    fact.ok = Boolean(!spawnError && !fact.failure && fact.ready?.portValid && fact.ready?.tokenValid
        && fact.exit?.status === 0 && fact.exit?.signal === null && fact.cleanupComplete
        && !fact.publicationCommitted && !fact.runtimeInvoked && fact.publicationAbsent && fact.legacyPreserved
        && (kind === "safe-missing-helper"
            ? compilerSucceeded && fact.helper?.regular && !fact.helper.symlink && fact.helper.size > 0
                && fact.helper.mode === 0o700 && fact.helper.links === 1 && fact.stagesRemaining.length === 0
            : kind === "substitute-bin"
                ? compilerSucceeded && fact.currentHelperAbsent && fact.replacementPreserved
                : fact.events.length === 0 && fact.currentHelperAbsent && fact.stagesRemaining.length === 0));
    return fact;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 4) throw new Error("Expected entry, helper source, private fixture root and case");
        const result = await runNativeHelperCompilerCase(...args);
        process.stdout.write(JSON.stringify(result) + "\n");
        process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
        process.stdout.write(JSON.stringify({ok: false, cleanupComplete: false,
            failure: error instanceof Error ? error.message : "Compiler fixture failed"}) + "\n");
        process.exitCode = 1;
    }
}
