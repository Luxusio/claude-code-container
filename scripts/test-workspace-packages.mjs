import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { assembleWorkspaceRuntime } from "./workspace-build.mjs";
import { createOwnedImportRead } from "./fixtures/owned-import-read.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "ccc-workspace-package-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith("CCC_") && !name.startsWith("VITEST") && !["NODE_PATH", "NODE_OPTIONS"].includes(name)));
Object.assign(env, { HOME: temporary, USERPROFILE: temporary, CCC_DEVICE_BROKER_AUTO_START: "0" });

function run(executable, args, cwd = temporary) {
    const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 120000,
        maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    assert.equal(result.status, 0, String(result.error || result.stderr || "distribution command failed").slice(0, 2000));
    return result.stdout;
}

async function mcpSmoke(packageRoot, serverName) {
    const child = spawn(process.execPath, [join(packageRoot, `dist/${serverName}/server.mjs`)], {
        cwd: temporary, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    let output = "";
    let stderr = "";
    let sequence = 0;
    let failure;
    const pending = new Map();
    function fail(error) {
        failure = error;
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    }
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("exit", code => fail(new Error(`packaged MCP exited ${code}: ${stderr.slice(0, 1000)}`)));
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.setEncoding("utf8").on("data", chunk => {
        output += chunk;
        if (output.length > 4 * 1024 * 1024) return fail(new Error("packaged MCP output limit exceeded"));
        let newline;
        while ((newline = output.indexOf("\n")) >= 0) {
            const line = output.slice(0, newline); output = output.slice(newline + 1);
            if (!line.trim()) continue;
            let response;
            try { response = JSON.parse(line); } catch { fail(new Error("packaged MCP emitted invalid JSON")); return; }
            const entry = pending.get(response.id);
            if (entry) {
                pending.delete(response.id);
                if (response.error) entry.reject(new Error(`packaged MCP RPC failed: ${response.error.code}`));
                else entry.resolve(response.result);
            }
        }
    });
    function request(method, params = {}) {
        if (failure) return Promise.reject(failure);
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => { if (error) fail(error); });
        });
    }
    const timer = setTimeout(() => fail(new Error("packaged MCP smoke timed out")), 30000);
    try {
        const initialized = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "ccc-workspace-distribution-smoke", version: "1" } });
        assert.equal(initialized.serverInfo.name, serverName);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const listed = await request("tools/list");
        assert.ok(Array.isArray(listed.tools) && listed.tools.some(tool => tool.name === "screenshot"));
        if (serverName === "device-lab-mcp") assert.ok(listed.tools.some(tool => tool.name === "create_windows_vm"));
        await request("ping");
    } finally {
        clearTimeout(timer);
        child.stdin.end();
        if (child.exitCode === null) child.kill();
        let shutdownTimer;
        try {
            await Promise.race([closed, new Promise((_, reject) => {
                shutdownTimer = setTimeout(() => {
                    child.kill("SIGKILL");
                    reject(new Error("packaged MCP did not stop"));
                }, 5000);
            })]);
        } finally { clearTimeout(shutdownTimer); }
    }
}

async function verifyExistingLifecycle(applicationUrl, compositionUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const childProcess = await import("node:child_process");
    const module = await import("node:module");
    let nativeProbes = 0;
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
        childProcess.default[name] = () => { nativeProbes++; throw new Error("unexpected native lifecycle probe"); };
    }
    module.syncBuiltinESMExports();
    const { createContainerExistingLifecycle } = await import(applicationUrl);
    const { createNativeContainerExistingLifecycle } = await import(compositionUrl);
    const facade = await import(facadeUrl);
    assert.equal(typeof facade.startProjectContainer, "function");
    const trace = [];
    const effect = name => (...args) => { trace.push([name, ...args]); return undefined; };
    const ports = {
        listContainer: name => { trace.push(["list", name]); return { known: true, containerId: "pinned" }; },
        identity: target => { trace.push(["identity", target]); return { containerId: "pinned", running: false }; },
        managedIdentity: () => { throw new Error("unexpected managed identity probe"); },
        assertProjectSources: effect("project"), assertDeviceSources: effect("devices"),
        assertFilesystemSources: effect("filesystem"),
        inspectContract: id => { trace.push(["contract", id]); return true; },
        verifyBeforeSetup: effect("live"),
        safeToDefer: () => { throw new Error("unexpected defer probe"); },
        isRunning: name => { trace.push(["running", name]); return true; },
        canExec: id => { trace.push(["exec", id]); return true; },
        canExecAfterBriefRetry: () => { throw new Error("unexpected brief retry"); },
        deviceSourcesMatch: () => { trace.push(["device-match"]); return true; },
        syncMcp: effect("mcp"), fixSsh: effect("ssh"), syncGit: effect("git"),
        start: effect("start"), stop: effect("stop"), remove: effect("remove"),
        reportContractMismatch: effect("mismatch"), reportContractMatch: effect("match"),
        reportRestart: effect("restart"), reportRecreation: effect("recreation"),
        reportDeferred: effect("deferred"),
        throwUnsafeDefer: () => { throw new Error("unsafe defer"); }, finish: effect("finish"),
    };
    const lifecycle = createContainerExistingLifecycle(ports);
    createNativeContainerExistingLifecycle(ports, {
        startCli: "must-not-run", requiredMountDestinations: () => { throw new Error("unexpected mount read"); },
        projectPath: "/private-project",
    });
    assert.deepEqual(trace, [], "construction must not invoke ports");
    assert.equal(nativeProbes, 0, "imports and composition construction must not probe a native runtime");
    assert.deepEqual(lifecycle.run({ containerName: "project" }), { kind: "joined", containerId: "pinned" });
    assert.deepEqual(trace, [["list", "project"], ["project"], ["devices"], ["filesystem"],
        ["contract", "pinned"], ["project"], ["devices"], ["filesystem"], ["running", "project"],
        ["exec", "pinned"], ["device-match"], ["live", "pinned"], ["mcp", "pinned"], ["ssh", "pinned"],
        ["git", "pinned"], ["device-match"], ["finish", "pinned"]]);
    trace.length = 0;
    ports.inspectContract = (id, reportReason) => { trace.push(["contract", id]); reportReason("changed"); return false; };
    assert.deepEqual(lifecycle.run({ containerName: "project", replacementGuard: recreate => {
        trace.push(["guard"]); recreate(); return true;
    }, onRecreate: effect("recreated") }), { kind: "continue-to-create" });
    assert.deepEqual(trace, [["list", "project"], ["project"], ["devices"], ["filesystem"],
        ["contract", "pinned"], ["project"], ["devices"], ["filesystem"], ["identity", "project"],
        ["guard"], ["identity", "pinned"], ["recreation", "changed"], ["remove", "pinned"], ["recreated"], ["running", "project"]]);
    trace.length = 0;
    assert.equal(lifecycle.replace({ containerName: "project", reason: "changed", expectedContainerId: "pinned",
        replacementGuard: () => { trace.push(["veto"]); return false; }, onRecreate: effect("recreated") }), false);
    assert.deepEqual(trace, [["identity", "project"], ["veto"]]);
    trace.length = 0;
    ports.listContainer = name => { trace.push(["list", name]); return { known: false, containerId: null }; };
    assert.throws(() => lifecycle.run({ containerName: "project" }), /identity inspection failed/);
    assert.deepEqual(trace, [["list", "project"]]);
    assert.equal(nativeProbes, 0);
}

async function verifyDestructiveLifecycle(applicationUrl, compositionUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const childProcess = await import("node:child_process");
    const module = await import("node:module");
    let nativeProbes = 0;
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
        childProcess.default[name] = () => { nativeProbes++; throw new Error("unexpected native destructive probe"); };
    }
    module.syncBuiltinESMExports();
    const { createContainerDestructiveLifecycle } = await import(applicationUrl);
    const { createNativeContainerDestructiveLifecycle } = await import(compositionUrl);
    const facade = await import(facadeUrl);
    assert.equal(typeof facade.stopProjectContainer, "function");
    assert.equal(typeof facade.removeProjectContainer, "function");
    function fixture({ claims = [], identity = { containerId: "pinned", running: true }, cleanupFailure = false } = {}) {
        const trace = [];
        let paths = 0;
        const effect = name => (...args) => { trace.push([name, ...args]); return undefined; };
        const ports = {
            resolvePath: path => { trace.push(["resolve", path]); return `/full/${++paths}`; },
            projectId: path => { trace.push(["project", path]); return "project"; },
            containerName: (path, profile) => { trace.push(["name", path, profile]); return "container"; },
            withLifecycleLock: (prefix, callback) => {
                trace.push(["lock", prefix]); callback(); trace.push(["unlock"]); return undefined;
            },
            sessionClaims: prefix => { trace.push(["claims", prefix]); return claims; },
            ensureRuntime: effect("runtime"),
            managedIdentity: (name, path) => { trace.push(["identity", name, path]); return identity; },
            cleanupDevices: (path, timeout, profile) => {
                trace.push(["cleanup", path, timeout, profile]);
                if (cleanupFailure) throw "cleanup-failed";
                return undefined;
            },
            stop: effect("stop"), remove: effect("remove"),
            reportNotFound: effect("not-found"), reportStopping: effect("stopping"),
            reportStopped: effect("stopped"), reportRemoving: effect("removing"),
            reportRemoved: effect("removed"), reportDeviceCleanupFailure: effect("cleanup-warning"),
            throwSessionClaims: count => { trace.push(["refuse", count]); throw new Error(`claimed:${count}`); },
        };
        const lifecycle = createContainerDestructiveLifecycle(ports);
        createNativeContainerDestructiveLifecycle(ports);
        assert.deepEqual(trace, [], "both factories must construct without effects");
        assert.equal(nativeProbes, 0, "imports and composition must not probe native runtime");
        return { trace, lifecycle };
    }
    const guard = [["resolve", "input"], ["project", "/full/1"], ["lock", "project--p--work"],
        ["claims", "project--p--work"], ["runtime"]];
    const stopProof = [["resolve", "input"], ["name", "/full/2", "work"], ["identity", "container", "/full/2"]];
    const removeProof = [["resolve", "input"], ["name", "/full/2", "work"], ["resolve", "input"],
        ["identity", "container", "/full/3"]];
    for (const operation of ["stop", "remove"]) {
        const expected = [...guard, ...(operation === "stop" ? stopProof : removeProof),
            ...(operation === "remove" ? [["resolve", "input"]] : []),
            ["cleanup", operation === "stop" ? "/full/2" : "/full/4", 5000, "work"],
            ["stopping"], ["stop", "pinned"], ["stopped"],
            ...(operation === "remove" ? [["removing"], ["remove", "pinned"], ["removed"]] : []), ["unlock"]];
        const happy = fixture();
        assert.equal(happy.lifecycle[operation]("input", "work"), undefined);
        assert.deepEqual(happy.trace, expected);

        const claimed = fixture({ claims: ["raw-claim", "raw-stale-claim"] });
        assert.throws(() => claimed.lifecycle[operation]("input", "work"), /claimed:2/);
        assert.deepEqual(claimed.trace, [...guard.slice(0, 4), ["refuse", 2]]);

        const unavailable = fixture({ claims: ["raw-claim"], identity: null });
        assert.equal(unavailable.lifecycle[operation]("input", "work", { force: true }), undefined);
        assert.deepEqual(unavailable.trace, [...guard, ...(operation === "stop" ? stopProof : removeProof), ["not-found"], ["unlock"]]);

        const cleanup = fixture({ cleanupFailure: true });
        assert.equal(cleanup.lifecycle[operation]("input", "work"), undefined);
        const warned = [...expected];
        warned.splice(warned.findIndex(row => row[0] === "cleanup") + 1, 0, ["cleanup-warning", "cleanup-failed"]);
        assert.deepEqual(cleanup.trace, warned);
    }
    assert.equal(nativeProbes, 0, "shipped core behavior must not escape supplied capabilities");
}

async function verifyCreateLifecycle(applicationUrl, portsUrl, compositionUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const childProcess = await import("node:child_process");
    const module = await import("node:module");
    let nativeProbes = 0;
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
        childProcess.default[name] = () => { nativeProbes++; throw new Error("unexpected native creation probe"); };
    }
    module.syncBuiltinESMExports();
    const { createContainerCreateLifecycle } = await import(applicationUrl);
    const portModule = await import(portsUrl);
    const { createNativeContainerCreateLifecycle } = await import(compositionUrl);
    const facade = await import(facadeUrl);
    assert.deepEqual(Object.keys(portModule), [], "creation ports must remain type-only");
    assert.equal(typeof facade.startProjectContainer, "function");
    const id = "A".repeat(64);
    const request = { containerName: "project", projectMountIdentity: "physical" };
    const args = ["run", "--detach", "image"];
    function fixture({ namespace = false, collision = null, stdout = `pull noise short-id x${id} ${id} ${"b".repeat(64)}`,
        verification = { kind: "verified", via: "identity" }, absent = true, lateFailure = null } = {}) {
        const trace = [];
        const effect = name => (...args) => { trace.push([name, ...args]); return undefined; };
        const ports = {
            withFamilyLock: (prefix, operation) => { trace.push(["lock", prefix]); return operation(); },
            namespaceExists: name => { trace.push(["namespace", name]); return namespace; },
            findCollision: () => { trace.push(["collision"]); return collision; },
            reportCreating: effect("creating"), reportLabWarning: effect("lab"), reportCreateFailure: effect("failure"),
            prepareRunArgs: () => { trace.push(["args"]); return args; },
            assertProjectSources: effect("project"), assertDeviceSources: effect("devices"), assertFilesystemSources: effect("filesystem"),
            create: supplied => {
                assert.equal(supplied, args); trace.push(["create", supplied]);
                return {
                    get status() { trace.push(["status"]); return 0; },
                    get stdout() { trace.push(["stdout"]); return stdout; },
                };
            },
            verifyCreated: target => { trace.push(["verify", target]); return verification; },
            removeRejected: effect("remove"),
            explicitlyAbsent: target => { trace.push(["absent", target]); return absent; },
            syncMcp: effect("mcp"),
            fixSsh: target => { trace.push(["ssh", target]); if (lateFailure) throw lateFailure; return undefined; },
            syncGit: effect("git"),
            finish: target => { trace.push(["finish", target]); return "public-name"; },
        };
        const lifecycle = createContainerCreateLifecycle(ports);
        createNativeContainerCreateLifecycle(ports, {
            get createCli() { throw new Error("unexpected captured runtime read"); },
            get createFailureHint() { throw new Error("unexpected hint read"); },
            labWarning: () => { throw new Error("unexpected lab warning observation"); },
            explicitlyNotFound: () => { throw new Error("unexpected native absence classification"); },
        });
        assert.deepEqual(trace, [], "creation factories must not invoke capabilities");
        assert.equal(nativeProbes, 0, "creation imports/construction must not probe a native runtime");
        return { trace, ports, lifecycle };
    }
    const pre = [["lock", "mount-physical"], ["namespace", "project"], ["collision"],
        ["creating", "project", undefined], ["lab"], ["args"], ["project"], ["devices"],
        ["filesystem"], ["create", args], ["status"], ["stdout"]];
    const post = [["project"], ["devices"], ["filesystem"]];
    const verified = [["verify", id], ["mcp", id], ["ssh", id], ["git", id], ["finish", id]];
    const happy = fixture();
    for (const name of Object.keys(happy.ports)) {
        assert.throws(() => createContainerCreateLifecycle({ ...happy.ports, [name]: undefined }), TypeError);
    }
    assert.deepEqual(happy.trace, []);
    assert.equal(happy.lifecycle.run(request), "public-name");
    assert.deepEqual(happy.trace, [...pre, ...post, ...verified], "shipped application must preserve exact ID, case and ordered creation");

    const occupied = fixture({ namespace: true });
    assert.throws(() => occupied.lifecycle.run(request), /Container namespace project appeared during creation preflight; refusing replacement\./);
    assert.deepEqual(occupied.trace, pre.slice(0, 2));
    for (const profile of [undefined, ""]) {
        const collision = fixture({ collision: { containerName: "owner" } });
        assert.throws(() => collision.lifecycle.run({ ...request, profile }), {
            message: `CCC container owner already owns this physical project for profile ${profile ?? "default"}; refusing duplicate container creation. The existing container was preserved.`,
        });
        assert.deepEqual(collision.trace, pre.slice(0, 3));
    }
    for (const stdout of [undefined, null, "short-id", `${id}x`]) {
        // Explicit assignment includes undefined, which a destructuring default would otherwise replace.
        const missing = fixture();
        missing.ports.create = supplied => { missing.trace.push(["create", supplied], ["status"], ["stdout"]); return { status: 0, stdout }; };
        assert.throws(() => missing.lifecycle.run(request), {
            message: "created container bind mount identity verification failed (container runtime did not return an exact 64-hex container ID)",
        });
        assert.deepEqual(missing.trace, [...pre, ...post], "missing ID must not authorize verification or cleanup");
    }
    for (const verification of [
        { kind: "deferred", reason: "deferred", containerPath: "/project" },
        { kind: "retryable", reason: "retryable" }, { kind: "mismatch", reason: "mismatch" },
    ]) {
        const rejected = fixture({ verification });
        assert.throws(() => rejected.lifecycle.run(request), {
            message: `created container bind mount identity verification failed (${verification.reason})`,
        });
        assert.deepEqual(rejected.trace, [...pre, ...post, ["verify", id], ["remove", id], ["absent", id]]);
    }
    const primary = new Error("source changed");
    const unknown = fixture({ absent: false });
    unknown.ports.verifyCreated = target => { unknown.trace.push(["verify", target]); throw primary; };
    assert.throws(() => unknown.lifecycle.run(request), error => {
        assert.equal(error.message, `source changed; failed to remove rejected container ${id}`);
        assert.equal(error.cause, primary);
        return true;
    });
    assert.deepEqual(unknown.trace, [...pre, ...post, ["verify", id], ["remove", id], ["absent", id]]);
    const lateFailure = new Error("late SSH failure");
    const late = fixture({ lateFailure });
    assert.throws(() => late.lifecycle.run(request), error => error === lateFailure);
    assert.deepEqual(late.trace, [...pre, ...post, ...verified.slice(0, 3)], "late failure must not compensate a verified container");
    assert.equal(nativeProbes, 0, "shipped creation policy must not escape fake capabilities");
}

async function verifyImagePreparation(applicationUrl, portsUrl, compositionUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const childProcess = await import("node:child_process");
    const module = await import("node:module");
    let nativeProbes = 0;
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
        childProcess.default[name] = () => { nativeProbes++; throw new Error("unexpected native image preparation probe"); };
    }
    module.syncBuiltinESMExports();
    const { createContainerImagePreparation } = await import(applicationUrl);
    const portModule = await import(portsUrl);
    const { createNativeContainerImagePreparation } = await import(compositionUrl);
    const facade = await import(facadeUrl);
    const runtime = await import(new URL("./container-runtime.js", facadeUrl));
    runtime._setRuntimeInfoForTest({ runtime: "docker" });
    assert.deepEqual(Object.keys(portModule), [], "image ports must remain type-only");
    assert.equal(typeof facade.ensureImage, "function");
    const helperCalls = [];
    const helpers = {
        get registryImage() { throw new Error("unexpected registry read during construction/development return"); },
        isImageExists: () => { helperCalls.push("exists"); return true; },
        getImageLabel: (image, key) => { helperCalls.push("label"); assert.equal(image, "ccc"); assert.equal(key, "cli.version"); return null; },
        qualifyImageRefForRuntime: () => { throw new Error("unexpected qualification of a development image"); },
        pullImage: () => { throw new Error("unexpected development pull"); },
        tagImage: () => { throw new Error("unexpected development tag"); },
    };
    const composed = createNativeContainerImagePreparation(helpers);
    assert.deepEqual(helperCalls, [], "composition construction must not invoke supplied helpers");
    assert.equal(nativeProbes, 0, "image imports and construction must not probe a runtime");
    assert.equal(composed.run(), undefined, "actual compiled composition must preserve development return");
    assert.deepEqual(helperCalls, ["exists", "label"]);
    const originalError = console.error;
    const originalLog = console.log;
    const originalExit = process.exit;
    const failureTrace = [];
    try {
        console.log = () => {};
        console.error = message => { failureTrace.push(message); };
        process.exit = () => { throw new Error("image preparation must unwind instead of exiting"); };
        const failed = createNativeContainerImagePreparation({
            registryImage: "team/image", isImageExists: () => false,
            getImageLabel: () => { throw new Error("unexpected missing image label"); },
            qualifyImageRefForRuntime: ref => ref, pullImage: () => false,
            tagImage: () => { throw new Error("must not tag a failed pull"); },
        });
        assert.throws(() => failed.run(), { name: "Error", message: "Failed to pull CCC image; container startup was aborted." });
        assert.equal(failureTrace.length, 2);
        assert.ok(failureTrace[0].startsWith("Error: Failed to pull team/image:"));
        assert.equal(failureTrace[1], "You can build locally instead: docker build -t ccc .");
    } finally { console.error = originalError; console.log = originalLog; process.exit = originalExit; }
    const names = ["exists", "label", "qualify", "pull", "tag", "reportStale", "reportPull",
        "reportFallback", "reportFailure", "reportBuildHint", "exitFailure"];
    const qualified = "docker.io/team/image:1.2.3";
    const missing = ["exists", "version", "reportPull:1.2.3", "registryImage", "version", "qualify:team/image:1.2.3", `pull:${qualified}`];
    const stale = ["exists", "imageName", "label:ccc:cli.version", "version", "version", "reportStale:0.9.0:1.2.3", "registryImage", "version", "qualify:team/image:1.2.3", `pull:${qualified}`];
    const cases = [
        { exists: true, label: null, pull: true, trace: ["exists", "imageName", "label:ccc:cli.version"] },
        { exists: true, label: "1.2.3", pull: true, trace: ["exists", "imageName", "label:ccc:cli.version", "version"] },
        { exists: true, label: "0.9.0", pull: true, trace: [...stale, "imageName", `tag:${qualified}:ccc`] },
        { exists: true, label: "", pull: true, trace: [...stale.map(event => event === "reportStale:0.9.0:1.2.3" ? "reportStale::1.2.3" : event), "imageName", `tag:${qualified}:ccc`] },
        { exists: false, label: "unused", pull: true, trace: [...missing, "imageName", `tag:${qualified}:ccc`] },
        { exists: true, label: "0.9.0", pull: false, trace: [...stale, `reportFallback:${qualified}`] },
        { exists: false, label: "unused", pull: false, trace: [...missing, `reportFailure:${qualified}`, "reportBuildHint", "exitFailure"] },
    ];
    function fixture(scenario) {
        const trace = [];
        const effect = event => { trace.push(event); return undefined; };
        const ports = {
            exists: () => { trace.push("exists"); return scenario.exists; },
            label: (image, key) => { trace.push(`label:${image}:${key}`); return scenario.label; },
            qualify: ref => { trace.push(`qualify:${ref}`); return `docker.io/${ref}`; },
            pull: ref => { trace.push(`pull:${ref}`); return scenario.pull; },
            tag: (source, target) => effect(`tag:${source}:${target}`),
            reportStale: (label, version) => effect(`reportStale:${label}:${version}`),
            reportPull: version => effect(`reportPull:${version}`),
            reportFallback: ref => effect(`reportFallback:${ref}`),
            reportFailure: ref => effect(`reportFailure:${ref}`),
            reportBuildHint: () => effect("reportBuildHint"), exitFailure: () => effect("exitFailure"),
        };
        const facts = { imageName: "ccc", version: "1.2.3", registryImage: "team/image" };
        const request = {};
        for (const name of Object.keys(facts)) {
            Object.defineProperty(request, name, { configurable: true, get() { trace.push(name); return facts[name]; } });
        }
        const app = createContainerImagePreparation(ports);
        assert.deepEqual(trace, [], "image factory must not invoke capabilities or facts");
        return { ports, request, app, trace };
    }
    function exactThrow(operation, failure) {
        let didThrow = false;
        try { operation(); } catch (error) { didThrow = true; assert.equal(error, failure); }
        assert.equal(didThrow, true, "original thrown values must escape unchanged");
    }
    const validation = fixture(cases[0]);
    for (const name of names) {
        for (const invalid of [undefined, null, false, 1, "function", {}]) {
            assert.throws(() => createContainerImagePreparation({ ...validation.ports, [name]: invalid }), TypeError);
        }
    }
    assert.deepEqual(validation.trace, []);
    for (const scenario of cases) {
        const f = fixture(scenario);
        assert.equal(f.app.run(f.request), undefined);
        assert.deepEqual(f.trace, scenario.trace, "compiled image policy must preserve the original branch and lazy fact schedule");
        for (const name of names) {
            const position = scenario.trace.findIndex(event => event === name || event.startsWith(`${name}:`));
            if (position < 0) continue;
            for (const failure of [new Error("image callback failure"), { imageFailure: name }, null, undefined]) {
                const fault = fixture(scenario);
                fault.ports[name] = () => { throw failure; };
                exactThrow(() => fault.app.run(fault.request), failure);
                assert.deepEqual(fault.trace, scenario.trace.slice(0, position));
            }
        }
        for (const name of ["imageName", "version", "registryImage"]) {
            const positions = scenario.trace.flatMap((event, index) => event === name ? [index] : []);
            for (const [occurrence, position] of positions.entries()) {
                for (const failure of [new Error("image fact failure"), { imageFact: name }]) {
                    const fault = fixture(scenario);
                    const original = Object.getOwnPropertyDescriptor(fault.request, name).get;
                    let reads = 0;
                    Object.defineProperty(fault.request, name, { get() {
                        if (reads++ === occurrence) throw failure;
                        return original();
                    } });
                    exactThrow(() => fault.app.run(fault.request), failure);
                    assert.deepEqual(fault.trace, scenario.trace.slice(0, position));
                }
            }
        }
    }
    const live = fixture(cases[4]);
    const originalExists = live.ports.exists;
    const originalPull = live.ports.pull;
    live.ports.exists = function () {
        assert.equal(this, live.ports);
        this.pull = function (ref) { assert.equal(this, live.ports); return originalPull(ref); };
        return originalExists();
    };
    assert.equal(live.app.run(live.request), undefined);
    assert.deepEqual(live.trace, cases[4].trace);
    assert.equal(nativeProbes, 0, "shipped image policy must stay inside supplied capabilities");
}

async function verifySessionHandoff(applicationUrl, portsUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const childProcess = await import("node:child_process");
    const module = await import("node:module");
    let nativeProbes = 0;
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
        childProcess.default[name] = () => { nativeProbes++; throw new Error("unexpected native handoff probe"); };
    }
    module.syncBuiltinESMExports();
    const { createContainerSessionHandoff } = await import(applicationUrl);
    const portModule = await import(portsUrl);
    const facade = await import(facadeUrl);
    assert.deepEqual(Object.keys(portModule), [], "handoff ports must remain type-only");
    assert.equal(typeof facade.startProjectContainer, "function");
    const refusal = "Container identity changed before session handoff; refusing to join.";
    function exactThrow(operation, failure) {
        let didThrow = false;
        try { operation(); } catch (error) { didThrow = true; assert.equal(error, failure); }
        assert.equal(didThrow, true, "original thrown values must escape unchanged");
    }
    function fixture({ running = true, containerId = "pinned", failureStage, failure } = {}) {
        const trace = [];
        const step = name => { trace.push(name); if (name === failureStage) throw failure; return undefined; };
        const ports = {
            assertProjectSources: () => step("project"),
            assertFilesystemSources: () => step("filesystem"),
            identity: target => {
                assert.equal(target, "pinned"); step("identity");
                return {
                    get running() { step("running"); return running; },
                    get containerId() { step("containerId"); return containerId; },
                };
            },
        };
        const app = createContainerSessionHandoff(ports);
        assert.deepEqual(trace, [], "factory must not invoke capabilities");
        return { app, ports, trace, step };
    }
    const validation = fixture();
    const names = ["assertProjectSources", "assertFilesystemSources", "identity"];
    const getters = {};
    for (const name of names) {
        Object.defineProperty(getters, name, { get() { validation.trace.push(name); return validation.ports[name]; } });
        assert.throws(() => createContainerSessionHandoff({ ...validation.ports, [name]: null }), TypeError);
    }
    createContainerSessionHandoff(getters);
    assert.deepEqual(validation.trace, names, "factory validates capability getters in order");
    for (const failure of [new Error("capability getter"), { capability: true }]) {
        exactThrow(() => createContainerSessionHandoff({ get assertProjectSources() { throw failure; } }), failure);
    }
    const order = ["project", "filesystem", "identity", "running", "containerId", "ready"];
    for (const callbackResult of [17, Promise.resolve("ignored")]) {
        const f = fixture();
        if (callbackResult instanceof Promise) {
            Object.defineProperty(callbackResult, "then", { get() { throw new Error("callback Promise observed"); } });
        }
        assert.equal(f.app.run("pinned", "public-name", function (target) {
            assert.equal(this, undefined); assert.equal(target, "pinned");
            f.step("ready"); return callbackResult;
        }), "public-name");
        assert.deepEqual(f.trace, order);
    }
    for (const callback of [undefined, null, false, 0, ""]) {
        const f = fixture();
        assert.equal(f.app.run("pinned", "public-name", callback), "public-name");
        assert.deepEqual(f.trace, order.slice(0, 2), "no callback must avoid final identity inspection");
    }
    for (const scenario of [{ running: false }, { containerId: "successor" }, { missing: true }]) {
        const f = fixture(scenario);
        if (scenario.missing) f.ports.identity = () => { f.step("identity"); return null; };
        assert.throws(() => f.app.run("pinned", "public-name", () => f.step("ready")), { message: refusal });
        assert.deepEqual(f.trace, order.slice(0, scenario.missing ? 3 : scenario.running === false ? 4 : 5));
    }
    for (const stage of order) {
        for (const failure of [new Error(stage), { stage }]) {
            const f = fixture({ failureStage: stage, failure });
            exactThrow(() => f.app.run("pinned", "public-name", () => f.step("ready")), failure);
            assert.deepEqual(f.trace, order.slice(0, order.indexOf(stage) + 1));
        }
    }
    const malformed = fixture();
    assert.throws(() => malformed.app.run("pinned", "public-name", {}), TypeError);
    assert.deepEqual(malformed.trace, order.slice(0, 5), "malformed truthy callback fails only after valid identity");
    assert.equal(nativeProbes, 0, "shipped handoff policy must stay inside supplied capabilities");
}

async function verifyRuntimeReadiness(applicationUrl, portsUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const childProcess = await import("node:child_process");
    const module = await import("node:module");
    const originals = new Map();
    let probe;
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
        originals.set(name, childProcess.default[name]);
        childProcess.default[name] = (...args) => {
            assert.equal(name, "spawnSync", "unexpected native runtime command");
            assert.equal(typeof probe, "function", "policy must not probe native runtime");
            return probe(...args);
        };
    }
    module.syncBuiltinESMExports();
    const originalError = console.error;
    const originalExit = process.exit;
    const originalDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    try {
        const { createContainerRuntimeReadiness } = await import(applicationUrl);
        assert.deepEqual(Object.keys(await import(portsUrl)), [], "readiness ports must remain type-only");
        const facade = await import(facadeUrl);
        const runtime = await import(new URL("./container-runtime.js", facadeUrl).href);
        const cases = [
            ["docker", "docker-desktop", "Please start Docker Desktop and try again."],
            ["docker", "docker-native", "Please start the docker service (e.g. `sudo systemctl start docker`) and try again."],
            ["podman", "podman-machine", "Please start the Podman machine (`podman machine start`) and try again."],
            ["podman", "podman-rootless", "Please start the rootless Podman service (`systemctl --user start podman.socket`) and try again."],
            ["podman", "podman-rootful", "Please start the Podman service (`sudo systemctl start podman.socket`) and try again."],
        ];
        cases.push(["docker", "unknown", cases[1][2]], ["podman", "unknown", cases[4][2]],
            ["docker", "future-flavor", cases[1][2]], ["podman", "future-flavor", cases[4][2]],
            ["docker", "podman-machine", cases[1][2]], ["podman", "docker-desktop", cases[4][2]]);
        function exactThrow(operation, failure) {
            let didThrow = false;
            try { operation(); } catch (error) { didThrow = true; assert.equal(error, failure); }
            assert.equal(didThrow, true, "original thrown values must escape unchanged");
        }
        function fixture(mode, name = "docker", flavor = "docker-native", status = 1, failureStage, failure, ignored) {
            const trace = [];
            let reports = 0;
            let probes = 0;
            const step = stage => { trace.push(stage); if (stage === failureStage) throw failure; };
            const messages = [];
            const report = message => {
                step(`report:${++reports}`); messages.push(message); return ignored;
            };
            const exit = () => { step("exit"); return ignored; };
            runtime._setRuntimeInfoForTest({ runtime: name, flavor });
            console.error = function (message) { assert.equal(this, console); return report(message); };
            process.exit = function (code) { assert.equal(this, process); assert.equal(code, 1); return exit(); };
            probe = mode === "facade" ? (command, args, options) => {
                probes++;
                assert.equal(command, name);
                assert.deepEqual(args, ["info"]);
                assert.deepEqual(options, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
                step("probe");
                return { pid: 1, output: [], stdout: "", stderr: "", status, signal: null };
            } : undefined;
            const ports = {
                isRunning: () => { step("running"); return status === 0; },
                runtimeInfo: () => { step("info"); return runtime.getRuntimeInfo(); },
                reportError: message => report(message()), exitFailure: exit,
            };
            const app = createContainerRuntimeReadiness(ports);
            assert.deepEqual(trace, [], "construction must not invoke capabilities");
            return { trace, messages, ports, probes: () => probes,
                run: mode === "facade" ? () => facade.ensureDockerRunning() : () => app.run() };
        }
        const validation = fixture("core");
        for (const name of ["isRunning", "runtimeInfo", "reportError", "exitFailure"]) {
            assert.throws(() => createContainerRuntimeReadiness({ ...validation.ports, [name]: null }), {
                name: "TypeError", message: `Container runtime readiness requires a callable ${name} port.`,
            });
        }
        for (const mode of ["core", "facade"]) {
            const prefix = mode === "core" ? ["running", "info"] : ["probe"];
            const ready = fixture(mode, "podman", "podman-machine", 0);
            assert.equal(ready.run(), undefined);
            assert.deepEqual(ready.trace, prefix.slice(0, 1));
            assert.deepEqual(ready.messages, []);
            assert.equal(ready.probes(), mode === "facade" ? 1 : 0);
            for (const [name, flavor, hint] of cases) {
                for (const status of [1, null]) {
                    const f = fixture(mode, name, flavor, status);
                    assert.equal(f.run(), undefined);
                    assert.deepEqual(f.trace, [...prefix, "report:1", "report:2", "exit"]);
                    assert.deepEqual(f.messages, [`Error: ${name} is not running.`, hint]);
                    assert.equal(f.probes(), mode === "facade" ? 1 : 0);
                }
            }
            const order = [...prefix, "report:1", "report:2", "exit"];
            for (const stage of order) {
                for (const failure of [new Error(stage), { stage }]) {
                    const f = fixture(mode, "docker", "docker-native", 1, stage, failure);
                    exactThrow(f.run, failure);
                    assert.deepEqual(f.trace, order.slice(0, order.indexOf(stage) + 1));
                }
            }
            for (const ignored of [Promise.resolve("ignored"), {}]) {
                Object.defineProperty(ignored, "then", { get() { throw new Error("effect return observed"); } });
                const f = fixture(mode, "docker", "docker-native", 1, undefined, undefined, ignored);
                assert.equal(f.run(), undefined);
                assert.deepEqual(f.trace, order);
                assert.deepEqual(f.messages, ["Error: docker is not running.", cases[1][2]]);
            }
        }
        // Use the real cached facts: runtimeCli reads runtime once during the probe,
        // so the first refusal interpolation is the second runtime getter read.
        const replaced = fixture("facade");
        const replacementInfo = runtime.getRuntimeInfo();
        const selectedReports = [];
        let replacementReads = 0;
        const originalReporter = Object.getOwnPropertyDescriptor(console, "error");
        try {
            console.error = function (message) {
                assert.equal(this, console); selectedReports.push(["original", message]);
            };
            Object.defineProperty(replacementInfo, "runtime", {
                get() {
                    if (++replacementReads === 2) {
                        console.error = function (message) {
                            assert.equal(this, console); selectedReports.push(["replacement", message]);
                        };
                    }
                    return "docker";
                },
            });
            assert.equal(replaced.run(), undefined);
            assert.equal(replacementReads, 3);
            assert.deepEqual(selectedReports, [["original", "Error: docker is not running."], ["replacement", cases[1][2]]]);
            assert.deepEqual(replaced.trace, ["probe", "exit"]);
            assert.equal(replaced.probes(), 1);
        } finally { Object.defineProperty(console, "error", originalReporter); }

        const changed = fixture("facade");
        const changedInfo = runtime.getRuntimeInfo();
        const changingReporter = Object.getOwnPropertyDescriptor(console, "error");
        const changeTrace = [];
        let changingRuntime = "docker";
        Object.defineProperty(changedInfo, "runtime", {
            get() { changeTrace.push("runtime"); return changingRuntime; },
        });
        try {
            Object.defineProperty(console, "error", {
                configurable: true,
                get() {
                    changeTrace.push("reporter-get");
                    changingRuntime = "podman"; changedInfo.flavor = "podman-machine";
                    return function (message) { assert.equal(this, console); changeTrace.push(message); };
                },
            });
            assert.equal(changed.run(), undefined);
            assert.deepEqual(changeTrace, ["runtime", "reporter-get", "runtime", "Error: podman is not running.",
                "runtime", "reporter-get", cases[2][2]]);
            assert.deepEqual(changed.trace, ["probe", "exit"]);
            assert.equal(changed.probes(), 1);
        } finally { Object.defineProperty(console, "error", changingReporter); }

        for (const failure of [new Error("reporter getter"), { reporter: true }]) {
            const failed = fixture("facade");
            const failedInfo = runtime.getRuntimeInfo();
            const failingReporter = Object.getOwnPropertyDescriptor(console, "error");
            let reads = 0;
            Object.defineProperty(failedInfo, "runtime", { get() { reads++; return "docker"; } });
            try {
                Object.defineProperty(console, "error", { configurable: true, get() { throw failure; } });
                exactThrow(failed.run, failure);
                assert.equal(reads, 1, "a throwing reporter accessor must prevent refusal interpolation");
                assert.deepEqual(failed.trace, ["probe"]);
                assert.equal(failed.probes(), 1);
            } finally { Object.defineProperty(console, "error", failingReporter); }
        }
        runtime._resetRuntimeCacheForTest();
    } finally {
        console.error = originalError;
        process.exit = originalExit;
        if (originalDebug === undefined) delete process.env.DEBUG;
        else process.env.DEBUG = originalDebug;
        for (const [name, original] of originals) childProcess.default[name] = original;
        module.syncBuiltinESMExports();
    }
}

async function verifySocketAccess(applicationUrl, portsUrl, facadeUrl, runtimeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const cp = (await import("node:child_process")).default;
    const fs = (await import("node:fs")).default;
    const os = (await import("node:os")).default;
    const module = await import("node:module");
    const originals = [];
    const replace = (owner, name, value) => { originals.push([owner, name, owner[name]]); owner[name] = value; };
    const forbidden = () => { throw new Error("unexpected socket fixture native effect"); };
    let dispatch = forbidden;
    const calls = [];
    const warnings = [];
    const manifestUrl = new URL("./packages/device-lab/package.json", facadeUrl);
    const importRead = await createOwnedImportRead(new URL("./", facadeUrl), manifestUrl, "socket fixture");
    function exactThrow(operation, failure) {
        let caught = false;
        try { operation(); } catch (error) { caught = true; assert.equal(error, failure); }
        assert.equal(caught, true, "expected original thrown value");
    }
    try {
        for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "_forkChild", "ChildProcess"]) {
            if (typeof cp[name] === "function") replace(cp, name, forbidden);
        }
        replace(cp, "spawnSync", (...args) => { calls.push(args); return dispatch(...args); });
        // Newer Node loaders use this export to read owned compiled sources too.
        replace(fs, "readFileSync", importRead.read);
        replace(os, "homedir", () => process.platform === "win32" ? "C:\\ccc-socket-fake\\home" : "/ccc-socket-fake/home");
        replace(console, "warn", function (message) { assert.equal(this, console); warnings.push(message); });
        module.syncBuiltinESMExports();
        const { createContainerSocketAccess } = await import(applicationUrl);
        assert.deepEqual(Object.keys(await import(portsUrl)), [], "socket ports must remain type-only");
        const facade = await import(facadeUrl);
        const runtime = await import(runtimeUrl);
        importRead.close();
        // Node's ESM loader needs the real descriptor operations while loading
        // owned compiled modules. Fence them after imports, before public calls.
        for (const [name, value] of Object.entries(fs)) {
            if (typeof value === "function") replace(fs, name, forbidden);
        }
        for (const [name, value] of Object.entries(fs.promises)) {
            if (typeof value === "function") replace(fs.promises, name, forbidden);
        }
        module.syncBuiltinESMExports();
        const probeScript = 's=/var/run/docker.sock; [ -S "$s" ] || exit 0; [ -r "$s" ] && [ -w "$s" ] && exit 0; id -un; stat -c %g "$s"; exit 10';
        const grantScript = 'u="$1"; g="$2"; n=$(getent group "$g" | cut -d: -f1); if [ -z "$n" ]; then if getent group ccc-host-socket >/dev/null; then groupmod -g "$g" ccc-host-socket; else groupadd -g "$g" ccc-host-socket; fi; n=ccc-host-socket; fi; usermod -aG "$n" "$u"';
        const warning = "[ccc] Could not grant the container user access to the container-manager socket; docker commands inside the container may need sudo.";
        const probeCall = (cli, target) => [cli, ["exec", target, "sh", "-c", probeScript], {
            encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
        }];
        const grantCall = (cli, target, user = "ccc", gid = "0") => [cli, ["exec", "--user", "root", target,
            "timeout", "-k", "2s", "8s", "sh", "-c", grantScript, "ccc-socket-grant", user, gid], { stdio: "ignore", timeout: 10000 }];
        assert.equal(facade.CONTAINER_MANAGER_SOCKET_PROBE, probeScript);
        assert.equal(facade.CONTAINER_MANAGER_SOCKET_GRANT, grantScript);
        assert.doesNotMatch(grantScript, /\bch(mod|own|grp)\b/);
        const reset = () => {
            calls.length = 0; warnings.length = 0; dispatch = forbidden;
            runtime._setRuntimeInfoForTest({ runtime: "docker" });
            assert.equal(facade.resetContainerManagerSocketAccessWarningForTest(), undefined);
        };
        const coreTrace = [];
        const ports = {
            probe(target) { assert.equal(this, ports); coreTrace.push(["probe", target]); return { status: 10, stdout: "ccc 0 extra" }; },
            grant(...args) { assert.equal(this, ports); coreTrace.push(["grant", ...args]); return { status: 1 }; },
            warn() { assert.equal(this, ports); coreTrace.push("warn"); return undefined; },
        };
        const getters = {};
        for (const name of ["probe", "grant", "warn"]) {
            Object.defineProperty(getters, name, { get() { coreTrace.push(name); return ports[name]; } });
            assert.throws(() => createContainerSocketAccess({ ...ports, [name]: null }), TypeError);
        }
        createContainerSocketAccess(getters);
        assert.deepEqual(coreTrace, ["probe", "grant", "warn"]);
        coreTrace.length = 0;
        const core = createContainerSocketAccess(ports);
        assert.equal(core.run("one"), undefined); assert.equal(core.run("two"), undefined);
        assert.deepEqual(coreTrace, [["probe", "one"], ["grant", "one", "ccc", "0"], "warn", ["probe", "two"], ["grant", "two", "ccc", "0"]]);
        assert.equal(core.resetWarning(), undefined);
        core.run("three"); assert.equal(coreTrace.at(-1), "warn");
        createContainerSocketAccess(ports).run("independent"); assert.equal(coreTrace.filter(value => value === "warn").length, 3);

        for (const cli of ["docker", "podman"]) {
            reset(); runtime._setRuntimeInfoForTest({ runtime: cli });
            dispatch = () => ({ status: 0, get stdout() { throw new Error("unexpected success stdout read"); } });
            assert.equal(facade.ensureContainerManagerSocketAccess("target"), undefined);
            assert.deepEqual(calls, [probeCall(cli, "target")]); assert.deepEqual(warnings, []);
        }
        reset();
        const observationTrace = [];
        let reads = 0;
        dispatch = () => {
            if (calls.length === 1) {
                observationTrace.push("probe");
                runtime._setRuntimeInfoForTest({ runtime: "podman", rootless: true, flavor: "podman-rootless" });
                return {
                    get status() { observationTrace.push(`status:${++reads}`); return reads === 1 ? 1 : 10; },
                    get stdout() { observationTrace.push("stdout"); return { toString() { observationTrace.push("coerce"); return " \tubuntu\n00042 extra\n"; } }; },
                    get error() { throw new Error("unexpected error projection"); },
                };
            }
            assert.equal(calls.length, 2); observationTrace.push("grant");
            return { get status() { observationTrace.push("grant-status"); return 0; }, get error() { throw new Error("unexpected error read"); } };
        };
        assert.equal(facade.ensureContainerManagerSocketAccess("pinned"), undefined);
        assert.deepEqual(calls, [probeCall("docker", "pinned"), grantCall("podman", "pinned", "ubuntu", "00042")]);
        assert.deepEqual(observationTrace, ["probe", "status:1", "stdout", "coerce", "status:2", "grant", "grant-status"]);
        assert.deepEqual(warnings, []);

        for (const [status, stdout] of [[1, "ccc 0"], [null, "ccc 0"], [10, "bad;user 0"], [10, "ccc 0x1"], [10, undefined]]) {
            reset(); dispatch = () => ({ status, stdout });
            facade.ensureContainerManagerSocketAccess("one"); facade.ensureContainerManagerSocketAccess("two");
            assert.deepEqual(calls, [probeCall("docker", "one"), probeCall("docker", "two")]); assert.deepEqual(warnings, [warning]);
            const previous = calls.length; assert.equal(facade.resetContainerManagerSocketAccessWarningForTest(), undefined);
            assert.equal(calls.length, previous);
            facade.ensureContainerManagerSocketAccess("reset"); assert.deepEqual(warnings, [warning, warning]);
        }
        const steps = ["probe", "status:1", "stdout", "coerce", "status:2", "grant", "grant-status", "warn"];
        for (const step of steps) for (const failure of [new Error(step), { step }]) {
            reset(); const trace = []; let statusReads = 0;
            const visit = name => { trace.push(name); if (name === step) throw failure; };
            dispatch = () => {
                if (calls.length === 1) { visit("probe"); return {
                    get status() { visit(`status:${++statusReads}`); return 10; },
                    get stdout() { visit("stdout"); return { toString() { visit("coerce"); return "ccc 0"; } }; },
                }; }
                assert.equal(calls.length, 2); visit("grant"); return { get status() { visit("grant-status"); return 1; } };
            };
            console.warn = function (message) { assert.equal(this, console); assert.equal(message, warning); visit("warn"); };
            exactThrow(() => facade.ensureContainerManagerSocketAccess("target"), failure);
            assert.deepEqual(trace, steps.slice(0, steps.indexOf(step) + 1));
            assert.deepEqual(calls, [probeCall("docker", "target"), ...(steps.indexOf(step) >= steps.indexOf("grant") ? [grantCall("docker", "target")] : [])]);
        }
        reset(); dispatch = () => ({ status: 1 });
        const warningFailure = { warning: "failed" };
        let warningCalls = 0;
        console.warn = function (message) {
            assert.equal(this, console); assert.equal(message, warning); warningCalls++;
            facade.ensureContainerManagerSocketAccess("reentrant"); throw warningFailure;
        };
        exactThrow(() => facade.ensureContainerManagerSocketAccess("outer"), warningFailure);
        assert.equal(facade.ensureContainerManagerSocketAccess("later"), undefined);
        assert.equal(warningCalls, 1);
        assert.deepEqual(calls, [probeCall("docker", "outer"), probeCall("docker", "reentrant"), probeCall("docker", "later")]);
        facade.resetContainerManagerSocketAccessWarningForTest();
        console.warn = function (message) { assert.equal(this, console); assert.equal(message, warning); warningCalls++;
            return { get then() { throw new Error("unexpected warning return observation"); } }; };
        assert.equal(facade.ensureContainerManagerSocketAccess("reset"), undefined); assert.equal(warningCalls, 2);
        runtime._resetRuntimeCacheForTest();
        console.log("PASS compiled socket core, actual public facade, native fences and warning lifetime");
    } finally {
        for (const [owner, name, original] of originals.reverse()) owner[name] = original;
        module.syncBuiltinESMExports();
    }
}

async function verifyToolRegistryDomain(domainUrl, registryUrl) {
    const assert = (await import("node:assert/strict")).default;
    const cp = (await import("node:child_process")).default;
    const fs = (await import("node:fs")).default;
    const module = await import("node:module");
    const originals = [];
    const replace = (owner, name, value) => { originals.push([owner, name, owner[name]]); owner[name] = value; };
    let effects = 0;
    const forbidden = () => { effects++; throw new Error("unexpected tool catalog native effect"); };
    let restoreCatalog = () => {};
    const exactThrow = (action, expected) => {
        let caught = false;
        try { action(); } catch (error) { caught = true; assert.equal(error, expected); }
        assert.ok(caught, "expected the original failure to propagate");
    };
    const freshGraph = (first, second) => {
        assert.deepEqual(first, second);
        if (first !== null && typeof first === "object") {
            assert.notEqual(first, second);
            for (const key of Object.keys(first)) freshGraph(first[key], second[key]);
        }
    };
    try {
        for (const [name, value] of Object.entries(cp)) if (typeof value === "function") replace(cp, name, forbidden);
        const writes = ["write", "writev", "writeFile", "appendFile", "mkdir", "mkdtemp", "rm", "unlink", "rename",
            "chmod", "chown", "fchmod", "fchown", "symlink", "link", "rmdir", "copyFile", "cp", "truncate", "ftruncate", "createWriteStream"];
        for (const name of writes) {
            for (const suffix of ["", "Sync"]) if (typeof fs[name + suffix] === "function") replace(fs, name + suffix, forbidden);
            if (typeof fs.promises[name] === "function") replace(fs.promises, name, forbidden);
        }
        // Keep loader reads available until the actual compiled modules are loaded.
        module.syncBuiltinESMExports();
        const domain = await import(domainUrl);
        const registry = await import(registryUrl);
        assert.equal(effects, 0);
        for (const [name, value] of Object.entries(fs)) if (typeof value === "function") replace(fs, name, forbidden);
        for (const [name, value] of Object.entries(fs.promises)) if (typeof value === "function") replace(fs.promises, name, forbidden);
        module.syncBuiltinESMExports();

        const tools = registry.getAllTools();
        const snapshots = new Map();
        const capture = value => {
            if (snapshots.has(value)) return;
            const descriptors = Object.getOwnPropertyDescriptors(value);
            snapshots.set(value, descriptors);
            for (const descriptor of Object.values(descriptors)) {
                if (descriptor.value !== null && typeof descriptor.value === "object") capture(descriptor.value);
            }
        };
        capture(tools);
        restoreCatalog = () => {
            for (const [value, descriptors] of snapshots) {
                for (const key of Reflect.ownKeys(value)) {
                    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) Reflect.deleteProperty(value, key);
                }
                Object.defineProperties(value, descriptors);
            }
        };
        const first = domain.createDefaultToolCatalog(), second = domain.createDefaultToolCatalog();
        freshGraph(first, second);
        assert.deepEqual(first, tools); // Complete literal values are pinned by the retained M11a golden proof.
        assert.notEqual(first, tools);
        const unchanged = structuredClone(second);
        for (const value of first) {
            value.name = "changed"; value.defaultFlags.push("changed"); value.updateCommand.push("changed");
            value.credentialMounts[0].hostDir = "changed";
            value.credentialMounts.push({ hostDir: "new", containerDir: "/new" });
            value.subcommands?.push("changed"); value.subcommandsAcceptingDefaultFlags?.push("changed");
        }
        first.splice(0, 1);
        assert.deepEqual(second, unchanged);
        assert.deepEqual(domain.createDefaultToolCatalog(), unchanged);
        assert.equal(registry.getAllTools(), tools);
        assert.equal(registry.getDefaultTool(), tools[0]);
        for (const value of tools) assert.equal(registry.getToolByName(value.name), value);

        const [a, b, c, d] = domain.createDefaultToolCatalog();
        a.name = "duplicate"; b.name = "claude"; c.name = "duplicate"; d.name = "empty-package";
        a.installCommand = "npm install -g first"; b.installCommand = " npm install -g excluded";
        c.installCommand = "npm install -g npm install -g second"; d.installCommand = "npm install -g ";
        b.credentialMounts = [a.credentialMounts[0]];
        const custom = [a, b, c, d];
        assert.equal(domain.findToolByName(custom, "duplicate"), a);
        assert.equal(domain.findDefaultTool(custom), b);
        for (const name of ["", "CLAUDE", "unknown"]) assert.equal(domain.findToolByName(custom, name), undefined);
        assert.equal(domain.findToolByName([], "claude"), undefined);
        assert.equal(domain.findDefaultTool([]), undefined);
        assert.deepEqual(domain.getAllCredentialMounts([]), []);
        assert.deepEqual(domain.getNpmTools([]), []);
        assert.deepEqual(domain.getNpmTools(custom), [{ cmd: "duplicate", pkg: "first" },
            { cmd: "duplicate", pkg: "npm install -g second" }, { cmd: "empty-package", pkg: "" }]);
        const mounts = domain.getAllCredentialMounts(custom), nextMounts = domain.getAllCredentialMounts(custom);
        assert.notEqual(mounts, nextMounts);
        assert.equal(mounts[0], a.credentialMounts[0]); assert.equal(mounts[a.credentialMounts.length], mounts[0]);
        for (let index = 0; index < mounts.length; index++) assert.equal(mounts[index], nextMounts[index]);
        custom.reverse();
        assert.equal(domain.findToolByName(custom, "duplicate"), c);
        b.name = "renamed"; assert.equal(domain.findDefaultTool(custom), undefined);
        tools.splice(0, tools.length, ...custom);
        assert.equal(registry.getAllTools(), tools);
        assert.equal(registry.getToolByName("duplicate"), c);
        assert.equal(registry.getDefaultTool(), undefined);
        const added = domain.createDefaultToolCatalog()[0];
        tools.push(added); assert.equal(registry.getDefaultTool(), added);
        const projected = registry.getAllCredentialMounts();
        assert.deepEqual(projected, domain.getAllCredentialMounts(tools));
        assert.notEqual(projected, registry.getAllCredentialMounts());
        projected[0].hostDir = "mutated-shared-mount";
        assert.equal(registry.getAllCredentialMounts()[0], projected[0]);
        assert.equal(registry.getAllCredentialMounts()[0].hostDir, "mutated-shared-mount");
        const npm = registry.getNpmTools(), nextNpm = registry.getNpmTools();
        assert.deepEqual(npm, domain.getNpmTools(tools)); assert.notEqual(npm, nextNpm);
        for (let index = 0; index < npm.length; index++) assert.notEqual(npm[index], nextNpm[index]);
        tools.splice(tools.indexOf(added), 1); assert.equal(registry.getDefaultTool(), undefined);
        restoreCatalog();

        const trace = [];
        const ordered = domain.createDefaultToolCatalog().slice(0, 3);
        for (const value of ordered) {
            const { name, installCommand, credentialMounts } = value;
            Object.defineProperties(value, {
                name: { get() { trace.push(name + ".name"); return name; } },
                installCommand: { get() { trace.push(name + ".install"); return installCommand; } },
                credentialMounts: { get() { trace.push(name + ".mounts"); return credentialMounts; } },
            });
        }
        tools.splice(0, tools.length, ...ordered);
        assert.equal(registry.getToolByName("gemini"), ordered[1]);
        assert.deepEqual(trace, ["claude.name", "gemini.name"]); trace.length = 0;
        assert.equal(registry.getDefaultTool(), ordered[0]); assert.deepEqual(trace, ["claude.name"]); trace.length = 0;
        registry.getAllCredentialMounts(); assert.deepEqual(trace, ["claude.mounts", "gemini.mounts", "codex.mounts"]); trace.length = 0;
        registry.getNpmTools();
        assert.deepEqual(trace, ["claude.install", "gemini.install", "codex.install",
            "gemini.name", "gemini.install", "codex.name", "codex.install"]);
        restoreCatalog();

        const raw = { unusual: true };
        for (const [method, action] of [["find", () => registry.getToolByName("x")],
            ["find", () => registry.getDefaultTool()], ["flatMap", () => registry.getAllCredentialMounts()]]) {
            const calls = [];
            Object.defineProperty(tools, method, { configurable: true, get() {
                calls.push("get"); return function () { assert.equal(this, tools); calls.push("call"); return raw; };
            } });
            assert.equal(action(), raw); assert.deepEqual(calls, ["get", "call"]); restoreCatalog();
        }
        const calls = [];
        const filtered = { get map() {
            calls.push("map.get"); return function () { assert.equal(this, filtered); calls.push("map.call"); return raw; };
        } };
        Object.defineProperty(tools, "filter", { configurable: true, get() {
            calls.push("filter.get"); return function () { assert.equal(this, tools); calls.push("filter.call"); return filtered; };
        } });
        assert.equal(registry.getNpmTools(), raw);
        assert.deepEqual(calls, ["filter.get", "filter.call", "map.get", "map.call"]); restoreCatalog();
        for (const sentinel of [new Error("original failure"), { nonError: true }]) {
            for (const [method, action] of [["find", () => registry.getToolByName("x")],
                ["find", () => registry.getDefaultTool()], ["flatMap", () => registry.getAllCredentialMounts()],
                ["filter", () => registry.getNpmTools()]]) {
                Object.defineProperty(tools, method, { configurable: true, get() { throw sentinel; } });
                exactThrow(action, sentinel); restoreCatalog();
            }
            for (const [field, action] of [["name", () => registry.getToolByName("x")],
                ["name", () => registry.getDefaultTool()], ["name", () => registry.getNpmTools()],
                ["credentialMounts", () => registry.getAllCredentialMounts()], ["installCommand", () => registry.getNpmTools()]]) {
                const value = domain.createDefaultToolCatalog()[1];
                Object.defineProperty(value, field, { get() { throw sentinel; } });
                tools.splice(0, tools.length, value); exactThrow(action, sentinel); restoreCatalog();
            }
            for (const method of ["startsWith", "replace"]) {
                const command = { startsWith() { return true; }, replace() { return "pkg"; } };
                Object.defineProperty(command, method, { value() { throw sentinel; } });
                const value = domain.createDefaultToolCatalog()[1];
                Object.defineProperty(value, "installCommand", { value: command });
                tools.splice(0, tools.length, value); exactThrow(() => registry.getNpmTools(), sentinel); restoreCatalog();
            }
            Object.defineProperty(tools, "filter", { configurable: true, value() { return { map() { throw sentinel; } }; } });
            exactThrow(() => registry.getNpmTools(), sentinel); restoreCatalog();
        }
        assert.equal(effects, 0, "tool catalog execution performed a native effect");
        console.log("PASS actual compiled domain catalog and legacy facade ownership, mutation, receivers and failures");
    } finally {
        restoreCatalog();
        for (const [owner, name, original] of originals.reverse()) owner[name] = original;
        module.syncBuiltinESMExports();
    }
}

async function verifyRequestedToolSetup(applicationUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { createRequestedToolSetup } = await import(applicationUrl);
    const target = "requested-tool target";
    const tool = { name: "codex", binary: "before-install" };
    const trace = [];
    let observation = { status: 0 };
    let probeFailure;
    const setup = createRequestedToolSetup({
        ensureClaudeLauncher() { assert.fail("unexpected Claude route"); },
        ensureNpmTool(selected, original) {
            assert.equal(selected, target);
            assert.equal(original, tool);
            trace.push("install");
            original.binary = "installed-codex";
        },
        probeLauncher(selected, path) {
            assert.equal(selected, target);
            assert.equal(path, "/home/ccc/.local/bin/installed-codex");
            trace.push("probe");
            if (probeFailure) throw probeFailure;
            return observation;
        },
        ensureCodexSandbox(selected) {
            assert.equal(selected, target);
            trace.push("sandbox");
        },
    });
    assert.deepEqual(trace, [], "construction must perform no effects");
    assert.equal(setup.ensure(target, tool), undefined);
    assert.deepEqual(trace, ["install", "probe", "sandbox"]);
    trace.length = 0;
    observation = { status: null, error: { code: "ETIMEDOUT" } };
    assert.throws(() => setup.ensure(target, tool), {
        message: "Requested tool codex readiness check timed out",
    });
    assert.deepEqual(trace, ["install", "probe"], "timeout must prevent sandbox setup");
    trace.length = 0;
    probeFailure = { originalProbeFailure: true };
    assert.throws(() => setup.ensure(target, tool), error => error === probeFailure);
    assert.deepEqual(trace, ["install", "probe"], "probe failure must propagate before sandbox setup");
}

async function verifyToolRegistryLayout(domainUrl, registryUrl, setupUrl, runtimeUrl, first) {
    const assert = (await import("node:assert/strict")).default;
    const cp = (await import("node:child_process")).default;
    const fs = (await import("node:fs")).default;
    const module = await import("node:module");
    const originals = [];
    const replace = (owner, name, value) => { originals.push([owner, name, owner[name]]); owner[name] = value; };
    let effects = 0;
    const forbidden = () => { effects++; throw new Error("unexpected shared launcher fixture native effect"); };
    const calls = [];
    let dispatch = forbidden;
    const writeNames = ["write", "writev", "writeFile", "appendFile", "mkdir", "mkdtemp", "rm", "unlink", "rename", "chmod", "chown", "fchmod", "fchown", "symlink", "link", "rmdir", "copyFile", "cp", "truncate", "ftruncate", "createWriteStream"];
    const manifestUrl = new URL("./packages/device-lab/package.json", setupUrl);
    const importRead = await createOwnedImportRead(new URL("./", setupUrl), manifestUrl, "shared launcher fixture");
    importRead.restrictSources([new URL(registryUrl), new URL(domainUrl), new URL("./domain/tool-registry.js", registryUrl)]);
    try {
        for (const [name, value] of Object.entries(cp)) if (typeof value === "function") replace(cp, name, forbidden);
        for (const name of writeNames) for (const suffix of ["", "Sync"]) if (typeof fs[name + suffix] === "function") replace(fs, name + suffix, forbidden);
        for (const name of writeNames) if (typeof fs.promises[name] === "function") replace(fs.promises, name, forbidden);
        replace(fs, "readFileSync", importRead.read);
        module.syncBuiltinESMExports();
        // Ordinary loader reads remain available until the actual package imports complete.
        assert.ok(first === "registry" || first === "setup");
        const imported = {};
        for (const name of [first, first === "registry" ? "setup" : "registry"]) {
            if (name === "setup") importRead.restrictSources(null);
            imported[name] = await import(name === "registry" ? registryUrl : setupUrl);
            if (name === "registry" && first === "registry") assert.equal(importRead.manifestReads, 0, "registry imported the installer runtime graph");
        }
        assert.ok(imported.registry && imported.setup, "both real production imports must succeed");
        assert.equal(effects, 0, "imports performed a native mutation/process effect");
        const { CLAUDE_BIN_PATH } = await import(domainUrl);
        const registry = imported.registry;
        const setup = imported.setup;
        const runtime = await import(runtimeUrl);
        importRead.close();
        assert.equal(CLAUDE_BIN_PATH, "/home/ccc/.local/bin/claude");
        assert.equal(setup.CLAUDE_BIN_PATH, CLAUDE_BIN_PATH);
        const tools = registry.getAllTools();
        assert.equal(registry.getAllTools(), tools);
        assert.equal(registry.getDefaultTool(), tools[0]);
        for (const tool of tools) assert.equal(registry.getToolByName(tool.name), tool);
        assert.deepEqual(tools, [
            { name: "claude", displayName: "Claude Code", binary: CLAUDE_BIN_PATH,
                defaultFlags: ["--dangerously-skip-permissions"], credentialMounts: [
                    { hostDir: ".ccc/claude", containerDir: "/home/ccc/.claude" },
                    { hostDir: ".claude/ide", containerDir: "/home/ccc/.claude/ide" }],
                needsNodeRuntime: true, updateCommand: ["claude", "update"], installCommand: "curl -fsSL https://claude.ai/install.sh | bash" },
            { name: "gemini", displayName: "Gemini CLI", binary: "gemini", defaultFlags: ["--yolo"],
                credentialMounts: [{ hostDir: ".gemini", containerDir: "/home/ccc/.gemini" }],
                needsNodeRuntime: false, updateCommand: ["gemini", "update"], installCommand: "npm install -g @google/gemini-cli" },
            { name: "codex", displayName: "Codex", binary: "codex", defaultFlags: ["--dangerously-bypass-approvals-and-sandbox"],
                subcommands: ["exec", "e", "review", "login", "logout", "mcp", "plugin", "mcp-server", "app-server", "remote-control", "completion", "update", "doctor", "migrate-rollouts", "sandbox", "debug", "apply", "a", "resume", "fork", "cloud", "exec-server", "features", "help"],
                subcommandsAcceptingDefaultFlags: ["exec", "e", "resume", "fork"], credentialMounts: [
                    { hostDir: ".ccc/codex", containerDir: "/home/ccc/.codex" }, { hostDir: ".omx", containerDir: "/home/ccc/.omx" },
                    { hostDir: ".agents", containerDir: "/home/ccc/.agents" }],
                needsNodeRuntime: false, updateCommand: ["codex", "update"], installCommand: "npm install -g @openai/codex" },
            { name: "opencode", displayName: "OpenCode", binary: "opencode", defaultFlags: ["--dangerously-skip-permissions"],
                credentialMounts: [{ hostDir: ".local/share/opencode", containerDir: "/home/ccc/.local/share/opencode" },
                    { hostDir: ".config/opencode", containerDir: "/home/ccc/.config/opencode" }],
                needsNodeRuntime: false, updateCommand: ["opencode", "update"], installCommand: "npm install -g opencode-ai" },
        ]);
        assert.deepEqual(registry.getAllCredentialMounts(), tools.flatMap(tool => tool.credentialMounts));
        assert.deepEqual(registry.getNpmTools(), [{ cmd: "gemini", pkg: "@google/gemini-cli" }, { cmd: "codex", pkg: "@openai/codex" }, { cmd: "opencode", pkg: "opencode-ai" }]);
        assert.deepEqual(setup.CLAUDE_LAYOUT_PATHS, { bin: CLAUDE_BIN_PATH, dataDir: "/home/ccc/.local/share/claude", volumeDataDir: "/home/ccc/.local/share/mise/.claude-data", legacyCacheFile: "/home/ccc/.local/share/mise/.claude-bin/claude" });
        for (const [name, value] of Object.entries(fs)) if (typeof value === "function") replace(fs, name, forbidden);
        for (const [name, value] of Object.entries(fs.promises)) if (typeof value === "function") replace(fs.promises, name, forbidden);
        replace(cp, "spawnSync", (...args) => { calls.push(args); return dispatch(...args); });
        replace(console, "log", () => undefined);
        module.syncBuiltinESMExports();
        for (const cli of ["docker", "podman"]) for (const installNeeded of [false, true]) {
            calls.length = 0;
            runtime._setRuntimeInfoForTest({ runtime: cli });
            const responses = installNeeded ? ["INSTALL\n", "", "VALID\n", ""] : ["VALID\n", ""];
            dispatch = () => { assert.ok(responses.length, "unexpected additional command"); return { status: 0, stdout: responses.shift(), stderr: "" }; };
            assert.equal(setup.ensureTools("pinned target", registry.getDefaultTool()), undefined);
            assert.equal(calls.length, installNeeded ? 4 : 2);
            assert.equal(calls[0][0], cli);
            assert.deepEqual(calls[0][1].slice(0, 4), ["exec", "pinned target", "sh", "-c"]);
            for (const path of Object.values(setup.CLAUDE_LAYOUT_PATHS)) assert.ok(calls[0][1][4].includes(path));
            assert.deepEqual(calls[0][2], { encoding: "utf-8", timeout: setup.CLAUDE_PROBE_TIMEOUT_MS });
            if (installNeeded) {
                assert.deepEqual(calls[1], [cli, ["exec", "pinned target", "sh", "-c", "timeout -k 5s 285s sh -c 'curl -fsSL https://claude.ai/install.sh | bash'"], { stdio: "inherit", timeout: setup.CONTAINER_TOOL_MUTATION_TIMEOUT_MS }]);
                assert.deepEqual(calls[2], calls[0]);
            }
            assert.deepEqual(calls.at(-1), [cli, ["exec", "pinned target", "test", "-x", CLAUDE_BIN_PATH], { stdio: "ignore", timeout: 15000 }]);
            assert.deepEqual(responses, []);
        }
        runtime._resetRuntimeCacheForTest();
        assert.equal(effects, 0, "public setup escaped native fences");
    } finally {
        for (const [owner, name, original] of originals.reverse()) owner[name] = original;
        module.syncBuiltinESMExports();
    }
}

async function verifyCodexConfigPreparation(applicationUrl, portsUrl, facadeUrl, runtimeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const cp = (await import("node:child_process")).default;
    const fs = (await import("node:fs")).default;
    const os = (await import("node:os")).default;
    const module = await import("node:module");
    const originals = [];
    const replace = (owner, name, value) => { originals.push([owner, name, owner[name]]); owner[name] = value; };
    const forbidden = () => { throw new Error("unexpected Codex config fixture native effect"); };
    const calls = [];
    let dispatch = forbidden;
    const manifestUrl = new URL("./packages/device-lab/package.json", facadeUrl);
    const importRead = await createOwnedImportRead(new URL("./", facadeUrl), manifestUrl, "Codex config fixture");
    function exactThrow(operation, failure) {
        let caught = false;
        try { operation(); } catch (error) { caught = true; assert.equal(error, failure); }
        assert.equal(caught, true, "expected original thrown value");
    }
    try {
        for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "_forkChild", "ChildProcess"]) {
            if (typeof cp[name] === "function") replace(cp, name, forbidden);
        }
        replace(cp, "spawnSync", (...args) => { calls.push(args); return dispatch(...args); });
        replace(fs, "readFileSync", importRead.read);
        replace(os, "homedir", () => process.platform === "win32" ? "C:\\ccc-codex-config-fake\\home" : "/ccc-codex-config-fake/home");
        module.syncBuiltinESMExports();
        const { createCodexConfigPreparation } = await import(applicationUrl);
        assert.deepEqual(Object.keys(await import(portsUrl)), [], "Codex config ports must remain type-only");
        const facade = await import(facadeUrl);
        const runtime = await import(runtimeUrl);
        const acl = await import(new URL("./codex-config-acl.js", facadeUrl));
        const layout = await import(new URL("./utils.js", facadeUrl));
        const path = await import("node:path");
        importRead.close();
        // The loader retains descriptor operations until owned imports finish.
        // All public calls below run with native filesystem effects forbidden.
        for (const [name, value] of Object.entries(fs)) if (typeof value === "function") replace(fs, name, forbidden);
        for (const [name, value] of Object.entries(fs.promises)) if (typeof value === "function") replace(fs.promises, name, forbidden);
        module.syncBuiltinESMExports();
        const stages = ["probe", "repair", "finalize"];
        const target = "pinned target;$(ignored)";
        const diagnostic = (stage, timeout = false) => `Codex config ${stage === "probe" ? "access probe" : "repair"} ${timeout ? "timed out" : "failed"}`;
        const reset = () => { calls.length = 0; dispatch = forbidden; runtime._setRuntimeInfoForTest({ runtime: "docker" }); };
        const clean = stage => ({ status: stage === "probe" ? 1 : 0 });
        function coreFixture(selected, observation) {
            const trace = [];
            const ports = Object.fromEntries(stages.map(stage => [stage, function (received) {
                assert.equal(this, ports); assert.equal(received, target); trace.push(stage);
                return stage === selected ? observation : clean(stage);
            }]));
            return { ports, trace, core: createCodexConfigPreparation(ports) };
        }
        assert.equal(facade.CODEX_CONFIG_PREPARE_TIMEOUT_MS, 15000);
        for (const stage of stages) assert.throws(() => createCodexConfigPreparation({ ...coreFixture().ports, [stage]: null }), {
            name: "TypeError", message: `Codex config preparation requires a callable ${stage} port.`,
        });
        const alreadyAccessible = coreFixture("probe", { status: 0, get error() { throw new Error("unobserved core success error"); } });
        assert.equal(alreadyAccessible.core.run(target), undefined); assert.deepEqual(alreadyAccessible.trace, ["probe"]);
        const successful = coreFixture();
        assert.equal(successful.core.run(target), undefined); assert.equal(successful.core.run(target), undefined);
        assert.deepEqual(successful.trace, [...stages, ...stages]);
        for (const stage of stages) {
            const outcomes = [
                [{ status: null, error: { code: "ETIMEDOUT" } }, true], [{ status: 124 }, true], [{ status: 137 }, true],
                [{ status: null }, false], [{ status: -1 }, false], [{ status: 42 }, false],
                [{ status: clean(stage).status, error: { code: "ENOENT" } }, false],
                [{ status: clean(stage).status, error: Symbol("opaque") }, false],
            ];
            if (stage !== "probe") outcomes.push([{ status: 1 }, false], [{ status: 0, error: { code: "ETIMEDOUT" } }, true]);
            for (const [observation, timeout] of outcomes) {
                const f = coreFixture(stage, observation);
                assert.throws(() => f.core.run(target), { name: "Error", message: diagnostic(stage, timeout) });
                assert.deepEqual(f.trace, stages.slice(0, stages.indexOf(stage) + 1));

            }
        }
        reset();
        const trace = []; const clis = ["docker", "podman", "docker"];
        dispatch = () => {
            const index = calls.length - 1; const stage = stages[index]; assert.ok(stage, "unexpected later native effect");
            assert.equal(calls[index], stage); trace.push(stage);
            runtime._setRuntimeInfoForTest({ runtime: clis[(index + 1) % clis.length] });
            let statusReads = 0; let errorReads = 0;
            const result = {
                get status() { trace.push(`${stage}:status:${++statusReads}`); return stage === "probe" ? (statusReads === 1 ? 2 : 1) : 0; },
                get error() { trace.push(`${stage}:error:${++errorReads}`); return errorReads === 1 ? {
                    get code() { trace.push(`${stage}:code`); return undefined; },
                } : undefined; },
            };
            for (const field of ["stdout", "stderr", "signal", "pid", "output", "then"]) Object.defineProperty(result, field, {
                get() { throw new Error(`unobserved native ${field}`); },
            });
            return result;
        };
        const rawPorts = Object.fromEntries(stages.map(stage => [stage, () => { calls.push(stage); return dispatch(); }]));
        assert.equal(createCodexConfigPreparation(rawPorts).run(target), undefined);
        assert.deepEqual(calls, stages);
        assert.deepEqual(trace, [
            "probe", "probe:status:1", "probe:error:1", "probe:code", "probe:status:2", "probe:status:3", "probe:error:2", "probe:status:4", "probe:status:5",
            "repair", "repair:error:1", "repair:code", "repair:status:1", "repair:status:2", "repair:error:2", "repair:status:3",
            "finalize", "finalize:error:1", "finalize:code", "finalize:status:1", "finalize:status:2", "finalize:error:2", "finalize:status:3",
        ]);
        for (const stage of stages) {
            const observations = stage === "probe"
                ? ["dispatch", "status:1", "error:1", "code", "status:2", "status:3", "error:2", "status:4", "status:5"]
                : ["dispatch", "error:1", "code", "status:1", "status:2", "error:2", "status:3"];
            for (const step of observations) for (const failure of [new Error(step), { step }]) {
                reset(); const observed = []; let statusReads = 0; let errorReads = 0;
                const visit = name => { observed.push(name); if (name === step) throw failure; };
                dispatch = () => {
                    const selected = stages[calls.length - 1]; assert.ok(selected, "unexpected later core effect");
                    if (selected !== stage) return clean(selected);
                    visit("dispatch"); return {
                        get status() { visit(`status:${++statusReads}`); return clean(stage).status; },
                        get error() { visit(`error:${++errorReads}`); return errorReads === 1 ? {
                            get code() { visit("code"); return undefined; },
                        } : undefined; },
                    };
                };
                const rawPorts = Object.fromEntries(stages.map(stage => [stage, () => { calls.push(stage); return dispatch(); }]));
                exactThrow(() => createCodexConfigPreparation(rawPorts).run(target), failure);
                assert.deepEqual(observed, observations.slice(0, observations.indexOf(step) + 1));
                assert.deepEqual(calls, stages.slice(0, stages.indexOf(stage) + 1));
            }
        }
        const directoryGuard = 'dir=/home/ccc/.codex; [ ! -L "$dir" ] && [ -d "$dir" ]';
        const directoryProbe = `${directoryGuard} && [ -r "$dir" ] && [ -w "$dir" ] && [ -x "$dir" ]`;
        const configProbe = `${directoryGuard} && file="$dir/config.toml" && [ ! -L "$file" ] && { [ ! -e "$file" ] || { [ -f "$file" ] && [ -r "$file" ] && [ -w "$file" ]; }; }`;
        const wrap = script => `timeout -k 2s 10s sh -c '${script.replace(/'/g, `'"'"'`)}'`;
        const nativeCall = (cli, script, root = false) => [cli,
            ["exec", ...(root ? ["--user", "root"] : []), target, "sh", "-c", wrap(script)],
            { encoding: "utf-8", timeout: 15000 }];
        const uidCall = cli => [cli, ["exec", target, "sh", "-c", "id -u"], { encoding: "utf-8", timeout: 15000 }];
        const hostReads = [];
        const hostUid = typeof process.getuid === "function" ? process.getuid() : 1000;
        replace(process, "getuid", () => hostUid);
        replace(fs, "lstatSync", selected => {
            hostReads.push(selected);
            const config = layout.getCodexConfigFile("work");
            assert.ok(selected === config || selected === path.dirname(config));
            return { uid: hostUid, nlink: 1, isDirectory: () => selected === path.dirname(config), isFile: () => selected === config };
        });
        module.syncBuiltinESMExports();
        for (const cli of ["docker", "podman"]) {
            reset(); hostReads.length = 0; runtime._setRuntimeInfoForTest({ runtime: cli });
            dispatch = () => ({ status: 0 });
            assert.equal(facade.prepareCodexConfigForContainer(target, "work"), undefined);
            assert.deepEqual(calls, [nativeCall(cli, directoryProbe), nativeCall(cli, configProbe)]);
            assert.deepEqual(hostReads, [], "accessible credentials must not trigger host validation or ACL repair");
            reset(); hostReads.length = 0; runtime._setRuntimeInfoForTest({ runtime: cli });
            const expected = [nativeCall(cli, directoryProbe), uidCall(cli),
                nativeCall(cli, acl.codexConfigDirectoryAclScript("1000"), true), nativeCall(cli, directoryProbe),
                nativeCall(cli, configProbe), nativeCall(cli, acl.codexConfigFileAclScript("1000"), true), nativeCall(cli, configProbe)];
            dispatch = () => {
                const index = calls.length - 1;
                assert.deepEqual(calls[index], expected[index], "native ACL sequence must remain directory-first and target-pinned");
                return { status: index === 0 || index === 4 ? 1 : 0, stdout: index === 1 ? "1000\n" : "", stderr: "" };
            };
            assert.equal(facade.prepareCodexConfigForContainer(target, "work"), undefined);
            assert.deepEqual(calls, expected);
            const config = layout.getCodexConfigFile("work");
            assert.deepEqual(hostReads, [path.dirname(config), config, path.dirname(config), config]);
            for (const observation of [{ status: 42, stderr: "guard rejected" }, { status: null, error: { message: "probe unavailable" } }]) {
                reset(); hostReads.length = 0; runtime._setRuntimeInfoForTest({ runtime: cli });
                dispatch = () => observation;
                const detail = observation.error?.message ?? observation.stderr;
                assert.throws(() => facade.prepareCodexConfigForContainer(target, "work"), {
                    name: "Error", message: `Unable to prepare Codex credentials at ${path.dirname(config)}: directory access check failed (${detail})`,
                });
                assert.deepEqual(calls, [nativeCall(cli, directoryProbe)]);
                assert.deepEqual(hostReads, []);
            }
            reset(); runtime._setRuntimeInfoForTest({ runtime: cli });
            const failure = new Error("original native ACL probe failure");
            dispatch = () => { throw failure; };
            exactThrow(() => facade.prepareCodexConfigForContainer(target, "work"), failure);
            assert.deepEqual(calls, [nativeCall(cli, directoryProbe)]);
        }
        runtime._resetRuntimeCacheForTest();
        console.log("PASS compiled Codex config core raw observations and actual public facade directory-first ACL commands, pinned targets and native fences");
    } finally {
        for (const [owner, name, original] of originals.reverse()) owner[name] = original;
        module.syncBuiltinESMExports();
    }
}

async function verifyExecReadiness(applicationUrl, portsUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { createContainerExecReadiness } = await import(applicationUrl);
    assert.deepEqual(Object.keys(await import(portsUrl)), [], "exec readiness ports must remain type-only");
    const cases = [
        { times: [100, 15250], outcomes: [], expected: false, trace: [["now", 100], ["now", 15250]] },
        { times: [0.5, 14950.75, 15100.25, 15150.25], outcomes: [false, true], expected: true,
            trace: [["now", 0.5], ["now", 14950.75], ["probe", " exact-target ", 199.75], ["now", 15100.25], ["sleep", 50.25], ["now", 15150.25], ["probe", " exact-target ", 0.25]] },
        { times: [100, -100, -200, -300, -400, -500, -600], outcomes: [false, false, false], expected: false,
            trace: [["now", 100], ["now", -100], ["probe", " exact-target ", 5000], ["now", -200], ["sleep", 75], ["now", -300], ["probe", " exact-target ", 5000], ["now", -400], ["sleep", 75], ["now", -500], ["probe", " exact-target ", 5000], ["now", -600]] },
    ];
    for (const scenario of cases) {
        const trace = [];
        let clocks = 0;
        let probes = 0;
        const ports = {
            now() { assert.equal(this, ports); assert.ok(clocks < scenario.times.length); const value = scenario.times[clocks++]; trace.push(["now", value]); return value; },
            canExec(target, timeout) { assert.equal(this, ports); assert.ok(probes < scenario.outcomes.length); trace.push(["probe", target, timeout]); return scenario.outcomes[probes++]; },
            sleep(duration) { assert.equal(this, ports); trace.push(["sleep", duration]); return undefined; },
        };
        const app = createContainerExecReadiness(ports);
        assert.deepEqual(trace, [], "factory must not invoke ports");
        assert.equal(app.run(" exact-target "), scenario.expected);
        assert.deepEqual(trace, scenario.trace);
    }
    let clock = 0;
    let reads = 0;
    const late = createContainerExecReadiness({
        now: () => { reads++; return clock; },
        canExec: () => { clock = 1000; return true; },
        sleep: () => { throw new Error("unexpected late success pause"); },
    });
    assert.equal(late.run("late-target"), true);
    assert.equal(reads, 2, "late success must not observe another clock");
}

async function verifyCompiledPublicExecReadiness(facadeUrl, runtimeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const fs = (await import("node:fs")).default;
    const cp = (await import("node:child_process")).default;
    const os = (await import("node:os")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const { fileURLToPath } = await import("node:url");
    const hostPath = (await import("node:path")).default;
    function fixturePaths(host, root) {
        const contains = (parent, selected) => {
            const relative = host.relative(parent, selected);
            return host.isAbsolute(selected) && !host.isAbsolute(relative)
                && relative !== ".." && !relative.startsWith(`..${host.sep}`);
        };
        return {
            root, home: host.join(root, "home"), project: host.join(root, "project"), contains,
            hostMarker: selected => host.basename(selected),
            guestMarker: selected => hostPath.posix.basename(selected),
            mount(value) {
                const match = value.match(/^(.*):(\/[^:]+)(?::ro)?$/);
                assert.ok(match);
                return { Source: match[1], Destination: match[2], Type: host.isAbsolute(match[1]) ? "bind" : "volume", RW: !value.endsWith(":ro") };
            },
        };
    }
    for (const [host, root, project, marker] of [
        [hostPath.posix, "/fake", "/fake/project", "/fake/project/.ccc-marker"],
        [hostPath.win32, "C:\\fake", "C:\\fake\\project", "C:\\fake\\project\\.ccc-marker"],
    ]) {
        const example = fixturePaths(host, root);
        assert.equal(example.project, project); assert.equal(host.isAbsolute(example.home), true);
        assert.equal(example.contains(root, project), true);
        assert.equal(example.contains(root, `${root}-outside${host.sep}project`), false);
        assert.deepEqual(example.mount(`${project}:/project/selected:ro`), { Source: project, Destination: "/project/selected", Type: "bind", RW: false });
        assert.equal(example.mount("ccc-volume:/home/ccc/data").Type, "volume");
        const stored = new Map([[example.hostMarker(marker), "challenge"]]);
        assert.equal(stored.get(example.guestMarker("/project/selected/.ccc-marker")), "challenge");
    }
    const fixtureHost = fixturePaths(hostPath, hostPath.resolve(hostPath.parse(process.cwd()).root, "ccc-exec-readiness-fixture"));
    const packageDist = fileURLToPath(new URL("./", facadeUrl));
    const id = "a".repeat(64);
    const baseImageId = `sha256:${"b".repeat(64)}`;
    const derivedImageId = `sha256:${"c".repeat(64)}`;
    const readonlyAccountProbe = ["run", "--rm", "--network", "none", "--user", "ccc", "--entrypoint", "/bin/sh", derivedImageId, "-c", 'set -eu; test "$(id -un)" = ccc; test "$(getent passwd ccc | cut -d: -f6)" = /home/ccc; test "$(getent group ccc | cut -d: -f3)" = "$(id -g)"; sudo -n true; printf "%s:%s:%s:ccc\\n" "$(id -u)" "$(id -g)" "$HOME"'];
    const uid = process.platform === "linux" ? process.geteuid() : 1000;
    const gid = process.platform === "linux" ? process.getegid() : 1000;
    const identityLabels = { "ccc.identity.version": "1", "ccc.identity.uid": String(uid),
        "ccc.identity.gid": String(gid), "ccc.identity.mapping": process.platform === "linux" ? "host" : "desktop",
        "ccc.identity.base": baseImageId };
    const project = fixtureHost.project;
    const home = fixtureHost.home;
    // This child models a host invocation, even when verification runs in a container.
    delete process.env.container;
    const manifestUrl = new URL("./packages/device-lab/package.json", facadeUrl).href;
    const ownedManifest = fileURLToPath(new URL("../package.json", facadeUrl));
    const result = (status = 0, stdout = "") => ({ status, stdout, stderr: "", pid: 1, output: [], signal: null });
    const files = new Map();
    const calls = [];
    const trace = [];
    let existing = false;
    let armed = false;
    let active = false;
    let now = 0;
    let probes = 0;
    let outcomes = [];
    let runArgs = [];
    let firstWait;
    let waitCount = 0;
    // Node's loader also uses filesystem exports. Load the owned compiled graph
    // before replacing them with fixture data, which is not executable source.
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
        cp[name] = () => { throw new Error(`unexpected native command capability: ${name}`); };
    }
    os.homedir = () => home;
    os.tmpdir = () => home;
    const readOwnedCode = fs.readFileSync;
    fs.readFileSync = (selected, ...args) => {
        const path = selected instanceof URL ? fileURLToPath(selected) : String(selected);
        if (selected instanceof URL && selected.href === manifestUrl) return JSON.stringify({ version: "0.0.0-fixture" });
        assert.ok(path === ownedManifest || (fixtureHost.contains(packageDist, path) && /\.(?:js|mjs|json)$/.test(path)), `unfenced import read: ${path}`);
        return readOwnedCode(selected, ...args);
    };
    syncBuiltinESMExports();
    const docker = await import(facadeUrl);
    const runtime = await import(runtimeUrl);
    assert.equal(typeof docker.startProjectContainer, "function", "owned compiled public facade must load");
    assert.equal(typeof runtime._setRuntimeInfoForTest, "function", "owned compiled runtime must load");
    const unavailablePowerShell = hostPath.win32.join("\\\\?\\GLOBALROOT\\SystemRoot\\System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const fakePath = selected => {
        if (typeof selected === "number") { assert.equal(selected, 1); return hostPath.join(fixtureHost.root, "owner.json"); }
        const path = selected instanceof URL ? fileURLToPath(selected) : String(selected);
        if (path === unavailablePowerShell) throw Object.assign(new Error("unavailable fixture process identity"), { code: "ENOENT" });
        assert.ok(fixtureHost.contains(fixtureHost.root, path) || fixtureHost.contains(packageDist, path)
            || /^\/proc\/(?:\d+\/(?:stat|cmdline)|sys\/kernel\/random\/boot_id)$/.test(path), `unfenced filesystem path: ${path}`);
        return path;
    };
    const stat = selected => {
        const path = fakePath(selected);
        const file = path.endsWith(".json") || path.includes(".guard");
        return { isSymbolicLink: () => false, isDirectory: () => !file, isFile: () => file,
            dev: 1, ino: 1, size: 16, gid: 100, mode: 0o100600, nlink: 1 };
    };
    // The graph is loaded; fence all application filesystem effects before use.
    for (const name of Object.keys(fs)) {
        if (typeof fs[name] === "function") fs[name] = () => { throw new Error(`unexpected filesystem capability: ${name}`); };
    }
    Object.assign(fs, {
        existsSync: selected => {
            // Model this preparation observation without opening a real host device.
            if (selected === "/dev/kvm") return false;
            fakePath(selected); return false;
        },
        statSync: stat, lstatSync: stat, fstatSync: descriptor => stat(descriptor),
        realpathSync: selected => fakePath(selected),
        readFileSync: (selected, encoding) => {
            if (selected instanceof URL && selected.href === manifestUrl) return JSON.stringify({ version: "0.0.0-fixture" });
            const path = fakePath(selected);
            const content = files.get(path) ?? "fixture";
            return encoding ? content : Buffer.from(content);
        },
        writeFileSync: (selected, content) => { files.set(fakePath(selected), String(content)); },
        mkdirSync: selected => { fakePath(selected); }, chmodSync: selected => { fakePath(selected); },
        openSync: selected => { fakePath(selected); return 1; }, closeSync: descriptor => { assert.equal(descriptor, 1); },
        rmSync: selected => { files.delete(fakePath(selected)); }, unlinkSync: selected => { files.delete(fakePath(selected)); },
        readdirSync: selected => { fakePath(selected); return []; }, readSync: () => 0,
        renameSync: (from, to) => { from = fakePath(from); to = fakePath(to); files.set(to, files.get(from)); files.delete(from); },
    });
    os.homedir = () => home;
    os.tmpdir = () => home;
    os.hostname = () => "fixture-host";
    os.uptime = () => 0;
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
        cp[name] = () => { throw new Error(`unexpected native command capability: ${name}`); };
    }
    cp.spawnSync = (cli, args, options) => {
        assert.ok(Array.isArray(args), "native command must have explicit argv");
        // POSIX identity probes are explicitly unavailable; the exact Windows
        // PowerShell existence probe above fails before any process can spawn.
        if ((cli === "ps" || cli === "/bin/ps") && args.length === 4 && args[0] === "-p"
            && /^\d+$/.test(args[1]) && args[2] === "-o" && ["lstart=", "command="].includes(args[3])) return result(1);
        assert.equal(cli, "docker", "no host program may run");
        calls.push(args);
        if (args[0] === "volume" && args.length === 4 && args[1] === "ls" && args[2] === "--format" && args[3] === "{{.Name}}") return result();
        if (args[0] === "images") return result(0, baseImageId);
        if (args[0] === "inspect" && args[1] === "ccc" && args[3] === "{{.Id}}") return result(0, baseImageId);
        if (args[0] === "image" && args[1] === "inspect") {
            if (args.length === 3 && args[2].startsWith("ccc-identity:")) {
                return result(0, JSON.stringify([{ Id: derivedImageId, Config: { User: "ccc", Labels: identityLabels } }]));
            }
            return result(0, "<no value>");
        }
        if (args[0] === "run" && args[1] === "--rm") {
            assert.deepEqual(args, readonlyAccountProbe);
            return result(0, `${uid}:${gid}:/home/ccc:ccc`);
        }
        if (args[0] === "run") { assert.equal(armed, false, "guarded existing paths must not create"); assert.equal(args.at(-1), derivedImageId); runArgs = [...args]; return result(0, id); }
        if (args[0] === "ps" && args[1] === "-aq") return result(0, existing ? id : "");
        if (args[0] === "ps" && args[1] === "-q") { active = armed; return result(0, existing ? id : ""); }
        if (args[0] === "ps") return result();
        if (args[0] === "inspect" && args.includes("{{.Id}}|{{.State.Running}}")) return result(0, `${id}|true`);
        if (args[0] === "inspect" && args.includes("{{.State.Running}}")) return result(0, String(existing));
        if (args[0] === "inspect" && args.includes("{{json .}}")) {
            const mounts = [];
            const labels = {};
            const env = [];
            for (let index = 0; index < runArgs.length; index++) {
                const argument = runArgs[index];
                const value = runArgs[index + 1];
                if (argument === "-v") {
                    mounts.push(fixtureHost.mount(value));
                }
                if (argument === "--tmpfs") mounts.push({ Source: "", Destination: value.split(":")[0], Type: "tmpfs", RW: true });
                if (argument === "--label") labels[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
                if (argument === "-e") env.push(value);
            }
            assert.equal(runArgs.at(-1), derivedImageId, "inspection provenance must use the exact selected derived image");
            assert.deepEqual(Object.fromEntries(Object.keys(identityLabels).filter(key => key !== "ccc.identity.base").map(key => [key, labels[key]])),
                Object.fromEntries(Object.entries(identityLabels).filter(([key]) => key !== "ccc.identity.base")));
            assert.equal(runArgs.includes("--privileged"), false, "fixture must not hide a privileged container");
            const selectedUser = runArgs.includes("--user") ? runArgs[runArgs.indexOf("--user") + 1] : "ccc";
            assert.notEqual(selectedUser, "root");
            return result(0, JSON.stringify({ Id: id, Image: derivedImageId, State: { Running: true }, Mounts: mounts,
                Config: { User: selectedUser, Labels: labels, Env: env },
                HostConfig: { Init: true, Devices: [], DeviceRequests: [], GroupAdd: [], Privileged: false } }));
        }
        if (args.length === 3 && args[0] === "exec" && args[1] === id && args[2] === "true") {
            assert.equal(active, true, "only the armed real lifecycle may call readiness");
            assert.deepEqual(options, { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
            trace.push(`probe:${id}:5000`);
            now += 10;
            return result(outcomes[probes++] ? 0 : 1);
        }
        if (active && probes > 0 && outcomes[probes - 1]) active = false;
        if (args[0] === "exec" && args[2] === "cat") {
            assert.equal(args[1], id);
            if (options?.encoding === null) return { ...result(), stdout: Buffer.from("fixture") };
            const marker = fixtureHost.guestMarker(args[3]);
            const entry = [...files].find(([path]) => fixtureHost.hostMarker(path) === marker);
            assert.ok(entry, "only an actual fake mount marker may be returned");
            return result(0, entry[1]);
        }
        if (args[0] === "exec" && args[2] === "sh" && args[4] === 'printf "%s:%s:%s:%s" "$(id -u)" "$(id -g)" "$(id -un)" "$HOME"') {
            assert.equal(args[1], id);
            return result(0, `${uid}:${gid}:ccc:/home/ccc`);
        }
        if (args[0] === "exec" && args[2] === "sh") {
            assert.deepEqual(args, ["exec", id, "sh", "-c", docker.sshCredentialCopyShell(true),
                "ccc-ssh-copy", "/home/ccc/.ssh", "/tmp/.ssh-copy"]);
            assert.deepEqual(options, { stdio: "ignore" });
            return result();
        }
        if (args[0] === "exec") {
            assert.equal(args[1], id);
            assert.ok(["sha256sum"].includes(args[2]), "unknown helper execution must fail closed");
            return result();
        }
        if (args[0] === "cp") {
            assert.ok(fixtureHost.contains(packageDist, args[1]));
            assert.ok(args[2].startsWith(`${id}:/tmp/ccc-managed-`));
            return result();
        }
        throw new Error(`unexpected fenced Docker command: ${JSON.stringify(args)}`);
    };
    Date.now = function () { assert.equal(this, Date); if (active) trace.push(`now:${now}`); return now; };
    const SharedBuffer = globalThis.SharedArrayBuffer;
    globalThis.SharedArrayBuffer = new Proxy(SharedBuffer, {
        construct(constructor, args) { if (active) { assert.deepEqual(args, [4]); trace.push("allocate:4"); } return Reflect.construct(constructor, args); },
    });
    const ignored = Promise.resolve("ignored native wait result");
    Object.defineProperty(ignored, "then", { get() { throw new Error("must not inspect native wait result"); } });
    Atomics.wait = function (sleeper, index, value, duration) {
        assert.equal(this, Atomics);
        if (active) {
            assert.ok(sleeper instanceof Int32Array); assert.equal(sleeper.byteLength, 4);
            assert.deepEqual([index, value, duration], [0, 0, 75]);
            if (firstWait) assert.equal(sleeper, firstWait); else firstWait = sleeper;
            waitCount++; trace.push(`sleep:${duration}`); now += duration;
        }
        return ignored;
    };
    console.log = console.warn = console.error = () => {};
    delete process.env.DEBUG; delete process.env.SSH_AUTH_SOCK;
    syncBuiltinESMExports();
    runtime._setRuntimeInfoForTest({ runtime: "docker", flavor: "docker-native", remote: false, dockerDesktop: false });
    // Build the exact native run contract once using this same compiled public API.
    docker.startProjectContainer(project, () => {});
    existing = true;
    const success = ["allocate:4", "now:0", "now:0", `probe:${id}:5000`, "now:10", "sleep:75", "now:85", `probe:${id}:5000`, "now:95", "sleep:75", "now:170", `probe:${id}:5000`];
    for (const available of [true, false]) {
        armed = true; active = false; now = 0; probes = 0; waitCount = 0; firstWait = undefined;
        outcomes = [false, false, available]; calls.length = 0; trace.length = 0;
        const joined = [];
        const handoffs = [];
        let guards = 0;
        const start = () => docker.startProjectContainer(project, () => {}, undefined, undefined, undefined, undefined,
            () => { guards++; return false; }, (selected, handoff) => { joined.push(selected); handoffs.push(handoff); });
        if (available) {
            assert.equal(start(), docker.getContainerName(project));
            assert.deepEqual(joined, [id]); assert.deepEqual(handoffs, [{ startedByInvocation: false }]); assert.equal(guards, 0);
        } else {
            assert.throws(start, /automatic destructive recovery was refused/);
            assert.deepEqual(joined, []); assert.equal(guards, 1);
        }
        // Success disables observation when the first post-readiness helper executes;
        // exhaustion stays armed through the policy's last clock and lock release.
        // Successful reuse allocates separate bounded retry sessions for fresh
        // inspection and live mount proof after the readiness probe succeeds.
        assert.deepEqual(trace, available ? [...success, "allocate:4", "allocate:4"] : [...success, "now:180", "now:180"]);
        assert.equal(probes, 3); assert.equal(waitCount, 2);
        assert.deepEqual(calls.filter(args => ["stop", "rm", "start"].includes(args[0])), [], "retry outcome must preserve the existing selected container");
        assert.deepEqual(calls.filter(args => args[0] === "run"), [readonlyAccountProbe], "only the exact isolated account validation may run");
    }
}

async function verifySessionShutdownAuthorization(applicationUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { armSessionOwnership, createSessionOwnershipGuardian } = await import(applicationUrl);
    const binding = { lockFile: "/fixture/own.lock", projectPath: "/fixture/project" };
    const receipt = { path: binding.lockFile, bytes: "nonsecret-fixture", device: "1", inode: "2", birthtime: "3", ownerPid: 17 };
    const id = "a".repeat(64);
    let messageListener;
    const messages = [];
    const handle = await armSessionOwnership(binding, receipt, {
        timeoutMs: 1000, assertOwnership: () => {}, cleanup: () => { throw new Error("unexpected startup cleanup"); },
        setTimer: () => ({}), clearTimer: () => {},
        launch: () => ({
            send: async frame => { messages.push(frame); messageListener(frame.type === "init" ? { type: "ready" } : { type: "ack", sequence: frame.sequence }); },
            onMessage: listener => { messageListener = listener; return () => {}; }, onLoss: () => () => {},
            unref: () => {}, close: () => {},
        }),
    }, error => { throw error; });
    await handle.updateContainer(id, "podman");
    assert.deepEqual(messages.at(-1), { type: "update", sequence: 1, containerId: id, runtime: "podman", cleanupEnabled: false });
    await handle.updateContainer(id, "podman", true);
    assert.deepEqual(messages.at(-1), { type: "update", sequence: 2, containerId: id, runtime: "podman", cleanupEnabled: true });
    await assert.rejects(handle.updateContainer(id, "podman", "true"), { name: "TypeError", message: "Invalid session cleanup authorization." });
    assert.equal(messages.length, 3, "invalid authorization must not emit an IPC update");
    // Explicit revocation is valid and must survive the ACK boundary.
    await handle.updateContainer(id, "podman", false);
    assert.equal(messages.at(-1).cleanupEnabled, false);
    await handle.release();
    for (const enabled of [false, true]) {
        const trace = [];
        const guardian = createSessionOwnershipGuardian({
            validate: (b, r) => { assert.deepEqual(b, binding); assert.deepEqual(r, receipt); },
            send: async frame => { trace.push(["send", frame]); },
            rollback: (b, r) => { assert.deepEqual(b, binding); assert.deepEqual(r, receipt); trace.push(["rollback"]); },
            cleanup: (b, r, selected, runtime) => { assert.deepEqual(b, binding); assert.deepEqual(r, receipt); trace.push(["cleanup", selected, runtime]); },
            finish: status => { trace.push(["finish", status]); },
        });
        await guardian.receive({ type: "init", binding, receipt });
        await guardian.receive({ type: "update", sequence: 1, containerId: id, runtime: "podman", cleanupEnabled: enabled });
        await guardian.disconnect();
        await guardian.disconnect();
        assert.deepEqual(trace, [["send", { type: "ready" }], ["send", { type: "ack", sequence: 1 }],
            enabled ? ["cleanup", id, "podman"] : ["rollback"], ["finish", 0]]);
    }
}

async function verifyOwnedEnvFile(facadeUrl, adapterUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { existsSync, readFileSync, statSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { basename, dirname } = await import("node:path");
    const facade = await import(facadeUrl);
    const adapter = await import(adapterUrl);
    assert.equal(typeof adapter.writeNativeEnvFile, "function");
    assert.equal(typeof adapter.writeOwnedNativeEnvFile, "function");
    const entries = [["CCC_PACKAGE_FIXTURE", "nonsecret-marker"], ["SKIPPED", "line\nbreak"]];
    const expected = "CCC_PACKAGE_FIXTURE=nonsecret-marker\n";
    const before = process.listeners("exit");
    const owned = facade.writeOwnedEnvFile(entries);
    try {
        assert.equal(typeof owned.path, "string");
        assert.equal(typeof owned.dispose, "function");
        assert.equal(dirname(owned.path), tmpdir());
        assert.match(basename(owned.path), /^ccc-env-[a-f0-9]{12}$/);
        assert.equal(readFileSync(owned.path, "utf8"), expected);
        if (process.platform !== "win32") assert.equal(statSync(owned.path).mode & 0o777, 0o600);
        const added = process.listeners("exit").filter(listener => !before.includes(listener));
        assert.deepEqual(added, [owned.dispose]);
        owned.dispose();
        assert.equal(existsSync(owned.path), false);
        assert.deepEqual(process.listeners("exit"), before);
        owned.dispose();
        assert.equal(existsSync(owned.path), false);
        assert.deepEqual(process.listeners("exit"), before);
    } finally { owned.dispose(); }
    const legacy = facade.writeEnvFile(entries);
    try {
        assert.equal(typeof legacy, "string");
        assert.equal(dirname(legacy), tmpdir());
        assert.equal(readFileSync(legacy, "utf8"), expected);
        assert.deepEqual(process.listeners("exit"), before);
    } finally { unlinkSync(legacy); }
}

async function verifyProfileCatalog(facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { existsSync, readFileSync, statSync, writeFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const facade = await import(facadeUrl);
    const profiles = join(homedir(), ".ccc", "profiles");
    assert.deepEqual(facade.listProfiles(), ["default"]);
    assert.equal(facade.profileExists("default"), true);
    assert.equal(facade.ensureProfile("default"), false);
    assert.equal(facade.profileExists("package-profile"), false);
    assert.throws(() => facade.createProfile("default"), /^Error: Profile "default" is reserved\.$/);
    assert.throws(() => facade.removeProfile("default"), /^Error: Profile "default" cannot be removed\.$/);
    assert.throws(() => facade.ensureProfile("package-missing"),
        /^Error: Profile "package-missing" does not exist\. Create it with: ccc profile add package-missing$/);
    assert.equal(existsSync(profiles), false, "queries and reserved errors must not create profile storage");
    const settings = { env: { CCC_PACKAGE_PROFILE_FIXTURE: "nonsecret-marker" } };
    assert.equal(facade.createProfile("package-profile", settings), undefined);
    const created = join(profiles, "package-profile");
    assert.equal(readFileSync(join(created, "claude.json"), "utf8"), "{}");
    assert.equal(readFileSync(join(created, "claude", "settings.json"), "utf8"), JSON.stringify(settings, null, 2));
    assert.equal(statSync(join(created, "codex")).isDirectory(), true);
    assert.equal(facade.ensureProfile("package-profile"), false);
    assert.equal(facade.isBuiltinProfile("local-llm"), true);
    assert.equal(facade.ensureProfile("local-llm"), true);
    assert.equal(facade.ensureProfile("local-llm"), false);
    const builtin = join(profiles, "local-llm");
    assert.equal(readFileSync(join(builtin, "claude", "settings.json"), "utf8"),
        JSON.stringify(facade.BUILTIN_PROFILES["local-llm"].settings, null, 2));
    writeFileSync(join(profiles, "plain-entry"), "nonsecret-file");
    assert.equal(facade.profileExists("plain-entry"), true);
    const listed = facade.listProfiles();
    assert.equal(listed[0], "default");
    assert.deepEqual(listed.slice(1).sort(), ["local-llm", "package-profile"]);
    if (process.platform !== "win32") {
        for (const directory of [created, builtin]) {
            for (const path of [directory, join(directory, "claude"), join(directory, "codex")]) {
                assert.equal(statSync(path).mode & 0o777, 0o700);
            }
            for (const path of [join(directory, "claude.json"), join(directory, "claude", "settings.json")]) {
                assert.equal(statSync(path).mode & 0o777, 0o600);
            }
        }
    }
    for (const name of ["package-profile", "local-llm", "plain-entry", "package-missing"]) {
        assert.equal(facade.removeProfile(name), undefined);
        assert.equal(facade.profileExists(name), false);
    }
    assert.deepEqual(facade.listProfiles(), ["default"]);
}

async function verifyWorkspaceNaming(domainUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
    const { join, resolve, dirname, basename } = await import("node:path");
    const domain = await import(domainUrl);
    const facade = await import(facadeUrl);
    assert.equal(domain.WORKTREE_SEPARATOR, "--");
    assert.equal(facade.WORKTREE_SEPARATOR, domain.WORKTREE_SEPARATOR);
    assert.equal(domain.formatWorkspaceSiblingBasename("repo--nested", "feature//ui"), "repo--nested--feature--ui");
    assert.equal(domain.formatWorkspaceSiblingBasename("Repo", " spaced\\branch "), "Repo-- spaced\\branch ");
    assert.deepEqual([...domain.iterateWorkspaceSourceBasenames("a----b--")], ["a", "a--", "a----b"]);
    assert.deepEqual([...domain.iterateWorkspaceSourceBasenames("--a--b")], []);
    assert.deepEqual([...domain.iterateWorkspaceSourceBasenames("a---b")], ["a"]);
    const directory = mkdtempSync(join(process.cwd(), "workspace-naming-"));
    try {
        const source = join(directory, "repo--nested");
        const expected = join(dirname(resolve(source)), `${basename(resolve(source))}--feature-ui`);
        assert.equal(facade.getWorkspacePath(source, "feature/ui"), expected);
        assert.deepEqual(facade.listWorkspaces(source), []);
        mkdirSync(expected);
        assert.deepEqual(facade.listWorkspaces(source), [{ branch: "feature-ui", path: expected }]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function verifyDockerEndpointSelection(applicationUrl, runtimeUrl, dockerUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const cp = (await import("node:child_process")).default;
    const application = await import(applicationUrl);
    const runtime = await import(runtimeUrl);
    const docker = await import(dockerUrl);
    const trace = [];
    const resolve = application.createDockerEndpointResolver({
        readContextOverride: () => { trace.push("context"); return "colima-fixture"; },
        readHostOverride: () => { throw new Error("shadowed host must not be read"); },
        inspectContextEndpoint: context => { trace.push(context); return null; },
    });
    assert.deepEqual(trace, []);
    assert.equal(resolve(), null);
    assert.deepEqual(trace, ["context", "colima-fixture"]);
    const mounts = await import(new URL("./bind-mount-verification.js", runtimeUrl).href);
    const required = { containerPath: "/var/run/docker.sock", presence: "core", readonly: false,
        type: "bind", sourceKind: "daemon" };
    const observed = { Destination: "/var/run/docker.sock", Source: "/daemon/custom.sock", Type: "bind", RW: true };
    assert.deepEqual(mounts.classifyRequiredMount(required, observed, { sourcePathMatches: true,
        liveProof: { kind: "mismatch", reason: "fixture foreign daemon" } }, "strict"),
    { kind: "mismatch", reason: "fixture foreign daemon", containerPath: "/var/run/docker.sock" });
    const original = cp.spawnSync;
    const saved = new Map(["DOCKER_CONTEXT", "DOCKER_HOST", "CCC_RUNTIME_SOCKET", "WSL_DISTRO_NAME", "container", "HOSTNAME"]
        .map(name => [name, process.env[name]]));
    const calls = [];
    let endpoint = "ssh://fixture.invalid";
    cp.spawnSync = (command, args) => {
        assert.equal(command, "docker"); calls.push(args);
        if (args.join(" ") === "--version") return { status: 0, stdout: "Docker version 27.1.1" };
        if (args.join(" ") === "info --format {{.OperatingSystem}}") return { status: 0, stdout: "Docker Desktop" };
        if (args[0] === "context") {
            assert.deepEqual(args, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", "--", "colima-fixture"]);
            return { status: 0, stdout: endpoint };
        }
        if (args[0] === "inspect") {
            assert.deepEqual(args, ["inspect", "ccc-package-parent", "--format", "{{json .Mounts}}"]);
            return { status: 0, stdout: JSON.stringify([{ Source: "/srv/daemon", Destination: "/daemon" }]) };
        }
        assert.deepEqual(args, ["info", "--format", "{{json .SecurityOptions}}"]);
        return { status: 0, stdout: "[]" };
    };
    syncBuiltinESMExports();
    try {
        process.env.DOCKER_CONTEXT = "colima-fixture";
        process.env.DOCKER_HOST = "unix:///shadowed-client.sock";
        process.env.CCC_RUNTIME_SOCKET = "/daemon/custom.sock";
        delete process.env.WSL_DISTRO_NAME;
        if (process.platform === "linux") {
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-package-parent";
        }
        runtime._resetSelinuxCacheForTest();
        runtime._resetRuntimeCacheForTest(); runtime.setRuntimeOverride("docker");
        const info = runtime.getRuntimeInfo();
        assert.equal(info.dockerDesktop, false, "remote selected context must not inherit shadowed local capabilities");
        assert.equal(info.socketPath, "/daemon/custom.sock");
        const count = calls.length;
        assert.equal(runtime.getRuntimeInfo(), info); assert.equal(calls.length, count);
        const args = docker.buildDockerRunArgs({ containerName: "ccc-package-endpoint", fullPath: "/package-source",
            projectMountPath: "/project/package", projectMountIdentity: "package-identity",
            credentialMounts: [], gitIdentityMounts: [], claudeJsonFile: "/package-home/claude.json",
            miseVolumeName: "ccc-package-mise", pidsLimit: "-1", imageName: "ccc",
            hostSshDir: null, sshAgentSocket: null });
        assert.ok(args.includes("/daemon/custom.sock:/var/run/docker.sock"));
        assert.equal(args.some(value => value.includes("shadowed-client.sock")), false);
        if (process.platform === "linux") {
            assert.deepEqual(runtime.bindMountArgs("/daemon/project", "/project"), ["-v", "/srv/daemon/project:/project"]);
            assert.deepEqual(runtime.bindMountArgs("/daemon/custom.sock", "/var/run/docker.sock", { sourceNamespace: "daemon" }),
                ["-v", "/daemon/custom.sock:/var/run/docker.sock"]);
        }
        endpoint = "";
        runtime._resetRuntimeCacheForTest(); runtime.setRuntimeOverride("docker");
        assert.equal(runtime.getRuntimeInfo().dockerDesktop, false, "empty selected context must not fall back to shadowed host");
    } finally {
        cp.spawnSync = original; syncBuiltinESMExports(); runtime._resetRuntimeCacheForTest(); runtime._resetSelinuxCacheForTest();
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
}

async function verifyWorkspaceBranchDelivery(applicationUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { createWorkspaceBranchValidation } = await import(applicationUrl);
    const facade = await import(facadeUrl);
    let calls = 0;
    const validate = createWorkspaceBranchValidation({ utf8ByteLength: value => { calls++; return Buffer.byteLength(value, "utf8"); } });
    assert.equal(calls, 0);
    assert.throws(() => validate(""), /^Error: Invalid branch name: cannot be empty$/);
    assert.throws(() => validate("-bad.."), /cannot start with '-'/);
    assert.equal(calls, 0, "earlier branch guards precede native byte measurement");
    assert.equal(validate("feature/작업"), "feature/작업");
    assert.equal(calls, 1);
    assert.throws(() => createWorkspaceBranchValidation({}), TypeError);
    const failure = new Error("fixture byte calculation");
    const broken = createWorkspaceBranchValidation({ utf8ByteLength: () => { throw failure; } });
    assert.throws(() => broken("allowed"), error => error === failure);
    for (const branch of ["x".repeat(255), "é".repeat(127) + "a", "💡".repeat(63) + "abc"]) {
        assert.equal(facade.validateBranchName(branch), branch);
    }
    for (const branch of ["x".repeat(256), "é".repeat(128), "💡".repeat(64)]) {
        assert.throws(() => facade.validateBranchName(branch), /^Error: Invalid branch name: too long \(max 255 bytes\)$/);
    }
    assert.equal(facade.validateBranchName("part.lock/child"), "part.lock/child");
    assert.throws(() => facade.validateBranchName(new String("allowed")), TypeError);
}

async function verifyProfileRequestDelivery(domainUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const directory = mkdtempSync(join(process.cwd(), "profile-request-"));
    const saved = [process.env.HOME, process.env.USERPROFILE];
    process.env.HOME = directory; process.env.USERPROFILE = directory;
    try {
        const domain = await import(domainUrl);
        const facade = await import(facadeUrl);
        assert.equal(domain.DEFAULT_PROFILE_NAME, "default");
        assert.equal(facade.DEFAULT_PROFILE_NAME, domain.DEFAULT_PROFILE_NAME);
        for (const request of [undefined, "", "default"]) {
            assert.equal(domain.normalizeProfile(request), undefined);
            assert.equal(facade.normalizeProfile(request), undefined);
            assert.equal(facade.profileClaudeDir(request), join(directory, ".ccc", "profiles", "default", "claude"));
        }
        assert.equal(domain.normalizeProfile(), undefined);
        assert.equal(facade.normalizeProfile(), undefined);
        for (const request of ["Work", " spaced ", "../raw", "한글"]) {
            assert.equal(domain.normalizeProfile(request), request);
            assert.equal(facade.normalizeProfile(request), request);
        }
        const raw = { [Symbol.toPrimitive]() { throw new Error("unexpected coercion"); } };
        assert.equal(domain.normalizeProfile(raw), raw);
        assert.equal(facade.normalizeProfile(raw), raw);
        assert.throws(() => facade.profileClaudeDir(raw), TypeError);
        assert.equal(facade.profileClaudeDir("Work"), join(directory, ".ccc", "profiles", "Work", "claude"));
    } finally {
        for (const [name, value] of [["HOME", saved[0]], ["USERPROFILE", saved[1]]]) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        rmSync(directory, { recursive: true, force: true });
    }
}

async function verifyWorktreeAdditionDelivery(applicationUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { createWorktreeAddition } = await import(applicationUrl);
    const facade = await import(facadeUrl);
    const request = { repositoryPath: "source", destinationPath: "destination", branch: "topic", failureContext: { kind: "unified" } };
    const prepared = { opaque: "preparation" }, receipt = { opaque: "registration" };
    const trace = [];
    const add = createWorktreeAddition({
        observeBranch: actual => { assert.equal(actual, request); trace.push("observe"); return "none"; },
        prepareAddition: (actual, action) => { assert.equal(actual, request); assert.equal(action, "worktree-new"); trace.push("prepare"); return prepared; },
        addPrepared: (actual, preparation) => { assert.equal(actual, request); assert.equal(preparation, prepared); trace.push("add"); return { status: 0, registrationReceipt: receipt }; },
        compensateFailedAddition: () => { assert.fail("successful addition must not compensate"); },
    });
    assert.deepEqual(trace, []);
    const added = add(request);
    assert.equal(added.prepared, prepared); assert.equal(added.registrationReceipt, receipt);
    assert.deepEqual(trace, ["observe", "prepare", "add"]);
    assert.throws(() => createWorktreeAddition({}), TypeError);
    const failure = new Error("owned compensation fixture");
    const failed = createWorktreeAddition({
        observeBranch: () => "local", prepareAddition: () => prepared,
        addPrepared: () => ({ status: null, stderr: "  original diagnostic  ", registrationReceipt: null }),
        compensateFailedAddition: (_request, action, preparation, registration) => {
            assert.equal(action, "worktree-existing"); assert.equal(preparation, prepared); assert.equal(registration, null); throw failure;
        },
    });
    assert.throws(() => failed(request), error => error.cause === failure
        && error.message === "Failed to create worktree: original diagnostic; rollback failed: owned compensation fixture");
    const root = mkdtempSync(join(process.cwd(), "worktree-addition-"));
    function git(args, cwd = root) {
        const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15000, windowsHide: true });
        assert.equal(result.status, 0, String(result.error || result.stderr));
        return result.stdout.trim();
    }
    try {
        git(["init", "source"]);
        const source = join(root, "source");
        git(["config", "user.name", "Fixture"], source);
        git(["config", "user.email", "fixture@example.invalid"], source);
        git(["config", "commit.gpgsign", "false"], source);
        writeFileSync(join(source, "owned.txt"), "owned fixture\n");
        git(["add", "owned.txt"], source); git(["commit", "-m", "fixture"], source);
        const result = facade.createWorkspace(source, "topic");
        assert.equal(result.workspacePath, join(root, "source--topic"));
        assert.deepEqual(result.created, [{ name: "source", branch: "topic", action: "worktree-new" }]);
        assert.equal(git(["branch", "--show-current"], result.workspacePath), "topic");
        git(["init", "nested-source"]);
        const nestedSource = join(root, "nested-source");
        git(["config", "user.name", "Fixture"], nestedSource);
        git(["config", "user.email", "fixture@example.invalid"], nestedSource);
        git(["config", "commit.gpgsign", "false"], nestedSource);
        writeFileSync(join(nestedSource, "nested.txt"), "nested fixture\n");
        git(["add", "nested.txt"], nestedSource); git(["commit", "-m", "nested"], nestedSource);
        git(["-c", "protocol.file.allow=always", "submodule", "add", nestedSource, "nested"], source);
        git(["commit", "-am", "nested repository"], source);
        const nested = facade.createWorkspace(source, "nested-topic");
        assert.deepEqual(nested.created, [
            { name: "source", branch: "nested-topic", action: "worktree-new" },
            { name: "nested", branch: "nested-topic", action: "worktree-new" },
        ]);
        assert.equal(git(["branch", "--show-current"], join(nested.workspacePath, "nested")), "nested-topic");
        const multiRoot = join(root, "multi-source");
        mkdirSync(multiRoot);
        for (const name of ["repo-a", "repo-b"]) {
            git(["init", name], multiRoot);
            const repository = join(multiRoot, name);
            git(["config", "user.name", "Fixture"], repository);
            git(["config", "user.email", "fixture@example.invalid"], repository);
            git(["config", "commit.gpgsign", "false"], repository);
            writeFileSync(join(repository, "owned.txt"), name);
            git(["add", "owned.txt"], repository); git(["commit", "-m", "fixture"], repository);
        }
        writeFileSync(join(multiRoot, "plain.txt"), "independent copy\n");
        const multi = facade.createWorkspace(multiRoot, "multi-topic");
        assert.deepEqual(multi.created, [
            { name: "repo-a", branch: "multi-topic", action: "worktree-new" },
            { name: "repo-b", branch: "multi-topic", action: "worktree-new" },
        ]);
        assert.deepEqual(multi.copied, ["plain.txt"]);
        assert.equal(readFileSync(join(multi.workspacePath, "plain.txt"), "utf8"), "independent copy\n");
        for (const name of ["repo-a", "repo-b"]) assert.equal(git(["branch", "--show-current"], join(multi.workspacePath, name)), "multi-topic");
    } finally { rmSync(root, { recursive: true, force: true }); }
}

async function verifyUnifiedCreationDelivery(applicationUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { createUnifiedWorkspaceCreation } = await import(applicationUrl);
    const request = { repositoryPath: "source", destinationPath: "destination", branch: "topic" };
    const prepared = { opaque: "prepared" }, registration = { opaque: "registration" };
    const nested = { name: "nested", branch: "topic", action: "worktree-existing" };
    const failure = new Error("nested fixture failure");
    let failRepair = false;
    const trace = [];
    const create = createUnifiedWorkspaceCreation({
        observeBranch: child => { assert.equal(child.failureContext.kind, "unified"); trace.push("observe"); return "none"; },
        prepareAddition: () => { trace.push("prepare"); return prepared; },
        addPrepared: (_child, value) => { assert.equal(value, prepared); trace.push("add"); return { status: 0, registrationReceipt: registration }; },
        compensateFailedAddition: () => assert.fail("addition succeeded"),
        requireRootRegistration: (value, actual) => { assert.equal(value, registration); assert.equal(actual, request); trace.push("require"); return registration; },
        sourceWorkspaceName: actual => { assert.equal(actual, request); trace.push("name"); return "source"; },
        repairNestedWorktrees: actual => { assert.equal(actual, request); trace.push("repair"); if (failRepair) throw failure; return [nested]; },
        rootWorktreeMatches: actual => { assert.equal(actual, request); trace.push("match"); return true; },
        removeRegisteredRoot: (actual, value) => { assert.equal(actual, request); assert.equal(value, registration); trace.push("remove"); },
        rollbackCreatedRootBranch: (actual, action, value) => { assert.equal(actual, request); assert.equal(action, "worktree-new"); assert.equal(value, prepared); trace.push("branch"); },
    });
    assert.deepEqual(trace, []);
    const result = create(request);
    assert.deepEqual(trace, ["observe", "prepare", "add", "require", "name", "repair"]);
    assert.equal(result.workspacePath, "destination"); assert.equal(result.created[1], nested);
    assert.deepEqual(result.copied, []);
    trace.length = 0; failRepair = true;
    assert.throws(() => create(request), error => error === failure);
    assert.deepEqual(trace, ["observe", "prepare", "add", "require", "name", "repair", "match", "remove", "branch"]);
    assert.throws(() => createUnifiedWorkspaceCreation({}), TypeError);
}

async function verifyMultiCreationDelivery(applicationUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { createMultiWorkspaceCreation } = await import(applicationUrl);
    const request = { repositoryPath: "source", destinationPath: "workspace", branch: "topic" };
    const entries = [
        { name: "one", path: "source/one", isGitRepo: true },
        { name: "two", path: "source/two", isGitRepo: true },
        { name: "plain-a", path: "source/plain-a", isGitRepo: false },
        { name: "plain-b", path: "source/plain-b", isGitRepo: false },
    ];
    const workspace = { opaque: "workspace" }, copied = { opaque: "copied" };
    const prepared = new Map(), registrations = new Map(), trace = [];
    const copyFailure = new Error("owned copy fixture failure");
    let mode = "success";
    const create = createMultiWorkspaceCreation({
        observeBranch: () => "none",
        prepareAddition: child => { const token = { opaque: child.repositoryPath }; prepared.set(child.repositoryPath, token); return token; },
        addPrepared: child => {
            const token = { opaque: child.repositoryPath }; registrations.set(child.repositoryPath, token);
            return { status: mode === "repo" && child.repositoryPath.endsWith("two") ? 1 : 0, stderr: "later addition failed", registrationReceipt: token };
        },
        compensateFailedAddition: child => { trace.push(`failed-add:${child.repositoryPath}`); },
        scanSource: actual => { assert.equal(actual, request); return entries; },
        destinationPath: (_actual, name) => `workspace/${name}`,
        ensureWorkspaceParent: () => {}, createWorkspaceExclusive: () => {},
        captureWorkspaceIdentity: () => workspace,
        requireRegistration: receipt => receipt,
        pathExists: path => !(mode === "copy" && path === "workspace/plain-b"),
        worktreeMatches: () => true,
        removeRegisteredWorktree: (actual, source, _destination, receipt) => {
            assert.equal(actual, request); assert.equal(receipt, registrations.get(source)); trace.push(`remove:${source}`);
        },
        rollbackCreatedBranch: (source, branch, action, token) => {
            assert.equal(branch, "topic"); assert.equal(action, "worktree-new"); assert.equal(token, prepared.get(source)); trace.push(`branch:${source}`);
        },
        assertWorkspaceIdentity: (actual, identity) => { assert.equal(actual, request); assert.equal(identity, workspace); },
        workspaceEntryCount: () => 0,
        quarantineWorkspace: (_actual, identity) => { assert.equal(identity, workspace); trace.push("root"); },
        copyEntry: source => { if (mode === "copy" && source.endsWith("plain-b")) throw copyFailure; },
        captureCopiedIdentity: () => copied,
        quarantineCopiedEntry: (_actual, destination, identity) => { assert.equal(identity, copied); trace.push(`copy:${destination}`); },
    });
    assert.deepEqual(trace, []);
    const result = create(request);
    assert.deepEqual(result.created.map(entry => entry.name), ["one", "two"]);
    assert.deepEqual(result.copied, ["plain-a", "plain-b"]);
    assert.equal(result.workspacePath, "workspace");
    mode = "repo";
    assert.throws(() => create(request), /^Error: Failed to create worktree for two: later addition failed$/);
    assert.deepEqual(trace, ["failed-add:source/two", "remove:source/one", "branch:source/one", "root"]);
    trace.length = 0; mode = "copy";
    assert.throws(() => create(request), error => error === copyFailure);
    assert.deepEqual(trace, ["remove:source/two", "branch:source/two", "remove:source/one", "branch:source/one", "copy:workspace/plain-a", "root"]);
    assert.throws(() => createMultiWorkspaceCreation({}), TypeError);
}

async function smoke(packageRoot) {
    assert.equal(existsSync(join(packageRoot, "node_modules")), false);
    assert.equal(existsSync(join(packageRoot, "x11-mcp")), false, "standalone X11 source was distributed");
    assert.equal(existsSync(join(packageRoot, "dist/x11-mcp")), false, "obsolete X11 bundle was distributed");
    run(process.execPath, [join(packageRoot, "dist/index.js"), "--version"]);
    assert.match(run(process.execPath, [join(packageRoot, "dist/index.js"), "--help"]), /ccc/i);
    const invalidRuntime = spawnSync(process.execPath, [join(packageRoot, "dist/index.js"), "--runtime", "invalid"], {
        cwd: temporary, env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(invalidRuntime.status, 1, "installed CLI must reject invalid runtime before native execution");
    assert.match(invalidRuntime.stderr, /Invalid --runtime value: 'invalid'\. Allowed: 'docker' or 'podman'\./);
    const unownedGuardian = spawnSync(process.execPath, [join(packageRoot, "dist/session-ownership-guardian.js")], {
        cwd: temporary, env, encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    assert.equal(unownedGuardian.status, 1, "shipped guardian must reject launch without owned IPC");
    assert.equal(unownedGuardian.stdout.trim(), "");
    assert.equal(unownedGuardian.stderr.trim(), "", "guardian rejection must occur after resolving its shipped dependencies");
    const core = pathToFileURL(join(packageRoot, "dist/packages/device-lab/dist/device-lab-broker.js")).href;
    const hyperV = pathToFileURL(join(packageRoot, "dist/packages/hyper-v/dist/index.js")).href;
    const transport = pathToFileURL(join(packageRoot, "dist/packages/hyper-v/dist/low-level/powershell-transport.js")).href;
    const sessionDomain = pathToFileURL(join(packageRoot, "dist/domain/session-lock.js")).href;
    const sessionApplication = pathToFileURL(join(packageRoot, "dist/application/session-lock-liveness.js")).href;
    const sessionFacade = pathToFileURL(join(packageRoot, "dist/session-lock-liveness.js")).href;
    const claimsDomain = pathToFileURL(join(packageRoot, "dist/domain/session-claims.js")).href;
    const claimsApplication = pathToFileURL(join(packageRoot, "dist/application/session-claims.js")).href;
    const claimsFacade = pathToFileURL(join(packageRoot, "dist/session.js")).href;
    const cleanupApplication = pathToFileURL(join(packageRoot, "dist/application/session-cleanup.js")).href;
    const cleanupPorts = pathToFileURL(join(packageRoot, "dist/ports/session-cleanup.js")).href;
    const homeLayout = pathToFileURL(join(packageRoot, "dist/home-layout.js")).href;
    for (const [path, symbol] of [
        ["dist/adapters/session-env-file.js", "writeOwnedNativeEnvFile"],
        ["dist/adapters/session-env-file.d.ts", "writeNativeEnvFile"],
        ["dist/adapters/session-env-file.d.ts", "writeOwnedNativeEnvFile"],
        ["dist/utils.d.ts", "writeEnvFile"],
        ["dist/utils.d.ts", "writeOwnedEnvFile"],
        ["dist/domain/session-lock.d.ts", "SessionLockOwner"],
        ["dist/application/session-lock-liveness.d.ts", "createSessionLockLiveness"],
        ["dist/ports/session-lock-liveness.d.ts", "SessionLockLivenessPorts"],
        ["dist/domain/session-claims.d.ts", "encodeSessionClaim"],
        ["dist/application/session-claims.d.ts", "createSessionClaims"],
        ["dist/ports/session-claims.d.ts", "SessionClaimsPorts"],
        ["dist/session.d.ts", "getSessionLockClaimsForContainer"],
        ["dist/application/session-cleanup.d.ts", "createSessionCleanup"],
        ["dist/ports/session-cleanup.d.ts", "SessionCleanupPorts"],
        ["dist/session.d.ts", "getCurrentSession"],
        ["dist/session.d.ts", "setSessionContainerId"],
        ["dist/session.d.ts", "setSessionCleanupEnabled"],
        ["dist/session.d.ts", "cleanupSession"],
        ["dist/session.d.ts", "armSessionOwnership"],
        ["dist/session.d.ts", "confirmSessionOwnership"],
        ["dist/application/session-ownership.d.ts", "armSessionOwnership"],
        ["dist/ports/session-ownership.d.ts", "SessionOwnershipHandle"],
        ["dist/application/container-existing-lifecycle.d.ts", "createContainerExistingLifecycle"],
        ["dist/ports/container-existing-lifecycle.d.ts", "ContainerExistingLifecyclePorts"],
        ["dist/composition/container-existing-lifecycle.d.ts", "createNativeContainerExistingLifecycle"],
        ["dist/docker.d.ts", "startProjectContainer"],
        ["dist/application/container-session-handoff.d.ts", "createContainerSessionHandoff"],
        ["dist/ports/container-session-handoff.d.ts", "ContainerSessionHandoffPorts"],
        ["dist/application/container-runtime-readiness.d.ts", "createContainerRuntimeReadiness"],
        ["dist/ports/container-runtime-readiness.d.ts", "ContainerRuntimeReadinessPorts"],
        ["dist/application/container-exec-readiness.d.ts", "createContainerExecReadiness"],
        ["dist/ports/container-exec-readiness.d.ts", "ContainerExecReadinessPorts"],
        ["dist/application/container-socket-access.d.ts", "createContainerSocketAccess"],
        ["dist/ports/container-socket-access.d.ts", "ContainerSocketAccessPorts"],
        ["dist/application/codex-config-preparation.d.ts", "createCodexConfigPreparation"],
        ["dist/ports/codex-config-preparation.d.ts", "CodexConfigPreparationPorts"],
        ["dist/docker.d.ts", "prepareCodexConfigForContainer"],
        ["dist/docker.d.ts", "ensureContainerManagerSocketAccess"],
        ["dist/docker.d.ts", "resetContainerManagerSocketAccessWarningForTest"],
        ["dist/docker.d.ts", "ensureDockerRunning"],
        ["dist/application/container-destructive-lifecycle.d.ts", "createContainerDestructiveLifecycle"],
        ["dist/ports/container-destructive-lifecycle.d.ts", "ContainerDestructiveLifecyclePorts"],
        ["dist/composition/container-destructive-lifecycle.d.ts", "createNativeContainerDestructiveLifecycle"],
        ["dist/application/container-create-lifecycle.d.ts", "createContainerCreateLifecycle"],
        ["dist/ports/container-create-lifecycle.d.ts", "ContainerCreateLifecyclePorts"],
        ["dist/ports/container-create-lifecycle.d.ts", "CreatedContainerMountVerification"],
        ["dist/composition/container-create-lifecycle.d.ts", "createNativeContainerCreateLifecycle"],
        ["dist/composition/container-create-lifecycle.d.ts", "NativeContainerCreateLifecycleContext"],
        ["dist/application/container-image-preparation.d.ts", "createContainerImagePreparation"],
        ["dist/ports/container-image-preparation.d.ts", "ContainerImagePreparationPorts"],
        ["dist/ports/container-image-preparation.d.ts", "ContainerImagePreparationRequest"],
        ["dist/composition/container-image-preparation.d.ts", "createNativeContainerImagePreparation"],
        ["dist/composition/container-image-preparation.d.ts", "NativeContainerImagePreparationHelpers"],
        ["dist/docker.d.ts", "ensureImage"],
        ["dist/application/tool-preferences.d.ts", "createToolPreferences"],
        ["dist/ports/tool-preferences.d.ts", "ToolPreferencePorts"],
        ["dist/profile.js", "createProfileCatalog"],
        ["dist/profile.d.ts", "ProfileSettings"],
        ["dist/profile.d.ts", "BuiltinProfile"],
        ["dist/application/profile-catalog.js", "createProfileCatalog"],
        ["dist/application/profile-catalog.d.ts", "createProfileCatalog"],
        ["dist/ports/profile-catalog.d.ts", "ProfileCatalogPorts"],
        ["dist/application/requested-tool-setup.d.ts", "createRequestedToolSetup"],
        ["dist/ports/requested-tool-setup.d.ts", "RequestedToolSetupPorts"],
        ["dist/docker.d.ts", "stopProjectContainer"],
        ["dist/docker.d.ts", "removeProjectContainer"],
    ]) {
        assert.ok(existsSync(join(packageRoot, path)), `architecture declaration missing: ${path}`);
        assert.ok(readFileSync(join(packageRoot, path), "utf8").includes(symbol), `architecture declaration missing: ${symbol}`);
    }
    for (const [path, legacy, owned] of [
        ["dist/utils.d.ts", "writeEnvFile", "writeOwnedEnvFile"],
        ["dist/adapters/session-env-file.d.ts", "writeNativeEnvFile", "writeOwnedNativeEnvFile"],
    ]) {
        const declarations = readFileSync(join(packageRoot, path), "utf8");
        assert.match(declarations, new RegExp(`export declare function ${legacy}\\(entries: Array<\\[string, string\\]>\\): string;`));
        assert.match(declarations, new RegExp(`export declare function ${owned}\\(entries: Array<\\[string, string\\]>\\): \\{\\s*path: string;\\s*dispose\\(\\): void;\\s*\\};`));
    }
    const envFileHome = mkdtempSync(join(temporary, "env-file-home-"));
    const envFileSmoke = spawnSync(process.execPath, ["--input-type=module", "-e",
        `await (${verifyOwnedEnvFile.toString()})(${JSON.stringify(pathToFileURL(join(packageRoot, "dist/utils.js")).href)},${JSON.stringify(pathToFileURL(join(packageRoot, "dist/adapters/session-env-file.js")).href)});`], {
        cwd: envFileHome,
        env: { ...env, HOME: envFileHome, USERPROFILE: envFileHome, TMPDIR: envFileHome, TMP: envFileHome, TEMP: envFileHome },
        encoding: "utf8", timeout: 120000, windowsHide: true,
    });
    assert.equal(envFileSmoke.status, 0, "environment file distribution proof failed");
    console.log("PASS environment file distribution: compiled utilities and native adapter, declarations, private file bytes and disposal listener lifetime");
    const profileHome = mkdtempSync(join(temporary, "profile-home-"));
    const profileSmoke = spawnSync(process.execPath, ["--input-type=module", "-e",
        `await (${verifyProfileCatalog.toString()})(${JSON.stringify(pathToFileURL(join(packageRoot, "dist/profile.js")).href)});`], {
        cwd: profileHome,
        env: { ...env, HOME: profileHome, USERPROFILE: profileHome, TMPDIR: profileHome, TMP: profileHome, TEMP: profileHome },
        encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(profileSmoke.status, 0, String(profileSmoke.error || profileSmoke.stderr || "profile distribution proof failed").slice(0, 2000));
    const profileContract = join(packageRoot, "profile-catalog-consumer.mts");
    writeFileSync(profileContract, [
        'import { createProfile, ensureProfile, listProfiles, profileExists, isBuiltinProfile, removeProfile, validateProfileName, BUILTIN_PROFILES, type ProfileSettings, type BuiltinProfile } from "./dist/profile.js";',
        'import { createProfileCatalog, type ProfileCatalog } from "./dist/application/profile-catalog.js";',
        'import type { ProfileCatalogPorts, ProfileSettings as PortSettings, BuiltinProfile as PortBuiltin } from "./dist/ports/profile-catalog.js";',
        'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
        'declare const ports: ProfileCatalogPorts; declare const settings: ProfileSettings; declare const builtin: BuiltinProfile;',
        'const catalog: ProfileCatalog = createProfileCatalog(ports, "default"); const inward: PortSettings = settings; const inwardBuiltin: PortBuiltin = builtin;',
        'const exact: [Equal<ReturnType<typeof listProfiles>, string[]>, Equal<ReturnType<typeof profileExists>, boolean>, Equal<ReturnType<typeof isBuiltinProfile>, boolean>, Equal<ReturnType<typeof ensureProfile>, boolean>, Equal<ReturnType<typeof createProfile>, void>, Equal<ReturnType<typeof removeProfile>, void>, Equal<ReturnType<typeof validateProfileName>, boolean>, Equal<typeof BUILTIN_PROFILES, Readonly<Record<string, BuiltinProfile>>>] = [true,true,true,true,true,true,true,true];',
        '// @ts-expect-error Catalog construction requires explicit default name.',
        'createProfileCatalog(ports);',
        '// @ts-expect-error Public settings remain an object.',
        'createProfile("fixture", "invalid");',
        'void [catalog, inward, inwardBuiltin, exact];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", profileContract]);
    } finally { rmSync(profileContract); }
    console.log("PASS profile catalog distribution: actual compiled public facade, declarations, private layout/settings, builtin ensure, file-entry queries, reserved errors and Unix modes");
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyWorkspaceNaming.toString()})(${JSON.stringify(pathToFileURL(join(packageRoot, "dist/domain/workspace-naming.js")).href)}, ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/worktree.js")).href)});`]);
    const namingContract = join(packageRoot, "workspace-naming-consumer.mts");
    writeFileSync(namingContract, [
        'import { WORKTREE_SEPARATOR as publicSeparator, getWorkspacePath, listWorkspaces } from "./dist/worktree.js";',
        'import { WORKTREE_SEPARATOR, formatWorkspaceSiblingBasename, iterateWorkspaceSourceBasenames } from "./dist/domain/workspace-naming.js";',
        'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
        'const literals: ["--", "--"] = [publicSeparator, WORKTREE_SEPARATOR];',
        'const exact: [Equal<typeof formatWorkspaceSiblingBasename, (sourceBasename: string, branch: string) => string>, Equal<ReturnType<typeof iterateWorkspaceSourceBasenames>, Generator<string, void, unknown>>, Equal<typeof getWorkspacePath, (sourcePath: string, branch: string) => string>, Equal<ReturnType<typeof listWorkspaces>, Array<{ branch: string; path: string }>>] = [true,true,true,true];',
        '// @ts-expect-error Naming does not accept a numeric branch.',
        'formatWorkspaceSiblingBasename("repo", 1);',
        '// @ts-expect-error The public separator must retain its literal type.',
        'const widened: "other" = publicSeparator;',
        'void [literals, exact, widened];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", namingContract]);
    } finally { rmSync(namingContract); }
    console.log("PASS workspace naming distribution: actual compiled pure rules and public facade, native sibling paths/listing and exact emitted declaration consumer");
    const endpointUrls = ["application/docker-endpoint-selection", "container-runtime", "docker"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyDockerEndpointSelection.toString()})(${endpointUrls.map(value => JSON.stringify(value)).join(",")});`]);
    const endpointContract = join(packageRoot, "docker-endpoint-consumer.mts");
    writeFileSync(endpointContract, [
        'import { createDockerEndpointResolver } from "./dist/application/docker-endpoint-selection.js";',
        'import type { DockerEndpointSelectionPorts } from "./dist/ports/docker-endpoint-selection.js";',
        'import { bindMountArgs } from "./dist/container-runtime.js";',
        'declare const ports: DockerEndpointSelectionPorts;',
        'const resolve: () => string | null = createDockerEndpointResolver(ports);',
        '// @ts-expect-error All semantic ports are required.',
        'createDockerEndpointResolver({ ...ports, readContextOverride: undefined });',
        '// @ts-expect-error Observation ports remain synchronous.',
        'createDockerEndpointResolver({ ...ports, inspectContextEndpoint: async () => "unix:///socket" });',
        'bindMountArgs("/daemon/socket", "/var/run/docker.sock", { sourceNamespace: "daemon" });',
        '// @ts-expect-error Only explicit client/daemon source namespaces are supported.',
        'bindMountArgs("/daemon/socket", "/var/run/docker.sock", { sourceNamespace: "other" });',
        'void resolve;',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", endpointContract]);
    } finally { rmSync(endpointContract); }
    console.log("PASS Docker endpoint distribution: compiled required ports, actual context precedence/cache/daemon mount facade and emitted declaration consumer");
    const branchUrls = ["application/workspace-branch-validation", "worktree"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyWorkspaceBranchDelivery.toString()})(${branchUrls.map(value => JSON.stringify(value)).join(",")});`]);
    const profileUrls = ["domain/profile-request", "home-layout"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyProfileRequestDelivery.toString()})(${profileUrls.map(value => JSON.stringify(value)).join(",")});`]);
    const parallelContract = join(packageRoot, "parallel-workspace-profile-consumer.mts");
    writeFileSync(parallelContract, [
        'import { createWorkspaceBranchValidation } from "./dist/application/workspace-branch-validation.js";',
        'import type { WorkspaceBranchValidationPorts } from "./dist/ports/workspace-branch-validation.js";',
        'import { validateBranchName } from "./dist/worktree.js";',
        'import { DEFAULT_PROFILE_NAME, normalizeProfile } from "./dist/domain/profile-request.js";',
        'import { DEFAULT_PROFILE_NAME as facadeDefault, normalizeProfile as facadeNormalize } from "./dist/home-layout.js";',
        'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
        'declare const ports: WorkspaceBranchValidationPorts;',
        'const validate: (branch: string) => string = createWorkspaceBranchValidation(ports);',
        'const literals: ["default", "default"] = [DEFAULT_PROFILE_NAME, facadeDefault];',
        'const signatures: [Equal<typeof validateBranchName, (branch: string) => string>, Equal<typeof normalizeProfile, (profile?: string) => string | undefined>, Equal<typeof facadeNormalize, (profile?: string) => string | undefined>] = [true,true,true];',
        '// @ts-expect-error Byte measurement is required.',
        'createWorkspaceBranchValidation({});',
        '// @ts-expect-error Port methods are readonly.',
        'ports.utf8ByteLength = () => 1;',
        '// @ts-expect-error Native profile signature remains optional string.',
        'facadeNormalize(1);',
        'void [validate, literals, signatures];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", parallelContract]);
    } finally { rmSync(parallelContract); }
    console.log("PASS parallel workspace/profile distribution: actual compiled policy and native facades, UTF-8 thresholds/raw identity/private home paths and strict emitted declaration consumers");
    const worktreeAdditionUrls = ["application/workspace/worktree-addition", "worktree"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyWorktreeAdditionDelivery.toString()})(${worktreeAdditionUrls.map(value => JSON.stringify(value)).join(",")});`]);
    const additionContract = join(packageRoot, "worktree-addition-consumer.mts");
    writeFileSync(additionContract, [
        'import { createWorktreeAddition } from "./dist/application/workspace/worktree-addition.js";',
        'import type { WorktreeAdditionPorts, WorktreeAdditionRequest } from "./dist/ports/workspace/worktree-addition.js";',
        'import { createWorkspace, type WorktreeResult } from "./dist/worktree.js";',
        'declare const ports: WorktreeAdditionPorts<{ opaque: "prepared" }, { opaque: "receipt" }>;',
        'declare const request: WorktreeAdditionRequest;',
        'const result = createWorktreeAddition(ports)(request);',
        'const prepared: { opaque: "prepared" } = result.prepared;',
        'const receipt: { opaque: "receipt" } | null = result.registrationReceipt;',
        'const facade: (source: string, branch: string) => WorktreeResult = createWorkspace;',
        '// @ts-expect-error All semantic effects are required.',
        'createWorktreeAddition({});',
        '// @ts-expect-error Port functions are readonly.',
        'ports.observeBranch = () => "none";',
        '// @ts-expect-error The addition is synchronous.',
        'const asynchronous: Promise<unknown> = result;',
        'void [prepared, receipt, facade, asynchronous];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", additionContract]);
    } finally { rmSync(additionContract); }
    console.log("PASS worktree addition distribution: compiled opaque receipt policy, real native Git facade and emitted generic/required/synchronous declarations");
    const unifiedUrl = pathToFileURL(join(packageRoot, "dist/application/workspace/unified-creation.js")).href;
    run(process.execPath, ["--input-type=module", "-e", `await (${verifyUnifiedCreationDelivery.toString()})(${JSON.stringify(unifiedUrl)});`]);
    const unifiedContract = join(packageRoot, "unified-creation-consumer.mts");
    writeFileSync(unifiedContract, [
        'import { createUnifiedWorkspaceCreation } from "./dist/application/workspace/unified-creation.js";',
        'import type { UnifiedCreationPorts, UnifiedCreationRequest } from "./dist/ports/workspace/unified-creation.js";',
        'import type { WorktreeCreationAction } from "./dist/domain/workspace/creation-result.js";',
        'import type { WorktreeAdditionAction } from "./dist/ports/workspace/worktree-addition.js";',
        'import { createWorkspace, type WorktreeResult, type WorktreeRepoResult } from "./dist/worktree.js";',
        'type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
        'declare const ports: UnifiedCreationPorts<{opaque:"prepared"},{opaque:"registration"}>;',
        'declare const request: UnifiedCreationRequest;',
        'const result: WorktreeResult = createUnifiedWorkspaceCreation(ports)(request);',
        'const alias: Equal<WorktreeCreationAction, WorktreeAdditionAction> = true;',
        'const facade: (source:string,branch:string)=>WorktreeResult = createWorkspace;',
        'const entry: WorktreeRepoResult = {name:"repo",branch:"topic",action:"worktree-new"};',
        'entry.name = "changed"; result.created.push(entry); result.copied.push("plain"); result.workspacePath = "changed";',
        '// @ts-expect-error Every semantic port is required.',
        'createUnifiedWorkspaceCreation({});',
        '// @ts-expect-error Ports are readonly.',
        'ports.rootWorktreeMatches = () => true;',
        '// @ts-expect-error Public creation remains synchronous.',
        'const asynchronous: Promise<unknown> = result;',
        'void [alias,facade,asynchronous];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", unifiedContract]);
    } finally { rmSync(unifiedContract); }
    console.log("PASS unified creation distribution: compiled ordered repair/compensation, actual nested Git facade and mutable legacy/generic declaration consumers");
    const multiUrl = pathToFileURL(join(packageRoot, "dist/application/workspace/multi-creation.js")).href;
    run(process.execPath, ["--input-type=module", "-e", `await (${verifyMultiCreationDelivery.toString()})(${JSON.stringify(multiUrl)});`]);
    const multiContract = join(packageRoot, "multi-creation-consumer.mts");
    writeFileSync(multiContract, [
        'import { createMultiWorkspaceCreation } from "./dist/application/workspace/multi-creation.js";',
        'import type { MultiCreationPorts, MultiCreationRequest } from "./dist/ports/workspace/multi-creation.js";',
        'import { createWorkspace, type WorkspaceEntry, type WorktreeResult } from "./dist/worktree.js";',
        'import type { WorkspaceEntry as DomainEntry } from "./dist/domain/workspace/source-entry.js";',
        'type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;',
        'declare const ports: MultiCreationPorts<{p:"prepared"},{r:"registration"},{w:"workspace"},{c:"copied"}>;',
        'declare const request: MultiCreationRequest;',
        'const result: WorktreeResult = createMultiWorkspaceCreation(ports)(request);',
        'const entry: WorkspaceEntry = {name:"repo",path:"path",isGitRepo:true};',
        'entry.name="changed"; entry.path="changed"; entry.isGitRepo=false; result.copied.push("plain");',
        'const same: Equal<WorkspaceEntry,DomainEntry> = true;',
        'const facade: (source:string,branch:string)=>WorktreeResult = createWorkspace;',
        '// @ts-expect-error All semantic effects are required.',
        'createMultiWorkspaceCreation({});',
        '// @ts-expect-error Ports are readonly.',
        'ports.pathExists = () => true;',
        '// @ts-expect-error The factory result is synchronous.',
        'const asynchronous: Promise<unknown> = result;',
        'void [entry,same,facade,asynchronous];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", multiContract]);
    } finally { rmSync(multiContract); }
    console.log("PASS multi creation distribution: compiled forward/reverse compensation, actual multiple Git/file-copy facade and mutable legacy/opaque declaration consumers");
    const toolDetectDeclarations = readFileSync(join(packageRoot, "dist/tool-detect.d.ts"), "utf8");
    assert.match(toolDetectDeclarations, /export declare function getDefaultToolPreference\(\): string \| null;/);
    assert.match(toolDetectDeclarations, /export declare function setDefaultToolPreference\(toolName: string\): void;/);
    assert.match(toolDetectDeclarations, /export declare function resolveTool\(env: Record<string, string \| undefined>\): ToolDefinition;/);
    const toolPreferencePortDeclarations = readFileSync(join(packageRoot, "dist/ports/tool-preferences.d.ts"), "utf8");
    assert.match(toolPreferencePortDeclarations, /readToolOverride\(\): string \| undefined;/);
    assert.match(toolPreferencePortDeclarations, /readSavedDefaultTool\(\): unknown;/);
    assert.match(toolPreferencePortDeclarations, /saveDefaultTool\(toolName: string\): void;/);
    assert.match(toolPreferencePortDeclarations, /findTool\(name: string\): ToolDefinition \| undefined;/);
    assert.match(toolPreferencePortDeclarations, /getDefaultTool\(\): ToolDefinition;/);
    const handoffDeclarations = readFileSync(join(packageRoot, "dist/ports/container-session-handoff.d.ts"), "utf8");
    assert.match(handoffDeclarations, /import type \{ ExistingContainerIdentity \} from ["']\.\/container-existing-lifecycle\.js["'];/);
    assert.match(handoffDeclarations, /assertProjectSources\(\): undefined;/);
    assert.match(handoffDeclarations, /assertFilesystemSources\(\): undefined;/);
    assert.match(handoffDeclarations, /identity\(id: string\): ExistingContainerIdentity \| null;/);
    assert.doesNotMatch(handoffDeclarations, /Promise<|\?:|\): void;/);
    const handoffApplicationDeclarations = readFileSync(join(packageRoot, "dist/application/container-session-handoff.d.ts"), "utf8");
    assert.match(handoffApplicationDeclarations, /createContainerSessionHandoff\(ports: ContainerSessionHandoffPorts\)/);
    assert.match(handoffApplicationDeclarations, /run: \(containerId: string, containerName: string, onReady\?: \(id: string\) => void\) => string;/);
    assert.match(readFileSync(join(packageRoot, "dist/docker.js"), "utf8"), /import \{ createContainerSessionHandoff \} from ["']\.\/application\/container-session-handoff\.js["'];/);
    const readinessDeclarations = readFileSync(join(packageRoot, "dist/ports/container-runtime-readiness.d.ts"), "utf8");
    assert.match(readinessDeclarations, /import type \{ RuntimeName \} from ["']\.\.\/domain\/container-runtime\.js["'];/);
    assert.match(readinessDeclarations, /isRunning\(\): boolean;/);
    assert.match(readinessDeclarations, /runtimeInfo\(\): \{\s*runtime: RuntimeName;\s*flavor: string;\s*\};/);
    assert.match(readinessDeclarations, /reportError\(message: \(\) => string\): undefined;/);
    assert.match(readinessDeclarations, /exitFailure\(\): undefined;/);
    assert.doesNotMatch(readinessDeclarations, /Promise<|\?:|\): void;|RuntimeInfo|RuntimeFlavor/);
    const readinessApplicationDeclarations = readFileSync(join(packageRoot, "dist/application/container-runtime-readiness.d.ts"), "utf8");
    assert.match(readinessApplicationDeclarations, /createContainerRuntimeReadiness\(ports: ContainerRuntimeReadinessPorts\)/);
    assert.match(readinessApplicationDeclarations, /run: \(\) => undefined;/);
    assert.match(readFileSync(join(packageRoot, "dist/docker.d.ts"), "utf8"), /ensureDockerRunning\(\): void;/);
    assert.match(readFileSync(join(packageRoot, "dist/docker.js"), "utf8"), /import \{ createContainerRuntimeReadiness \} from ["']\.\/application\/container-runtime-readiness\.js["'];/);
    const socketPortsDeclarations = readFileSync(join(packageRoot, "dist/ports/container-socket-access.d.ts"), "utf8");
    assert.match(socketPortsDeclarations, /probe\(target: string\): \{\s*status: number \| null;\s*stdout\?: unknown;\s*\};/);
    assert.match(socketPortsDeclarations, /grant\(target: string, user: string, gid: string\): \{\s*status: number \| null;\s*\};/);
    assert.match(socketPortsDeclarations, /warn\(\): undefined;/);
    assert.doesNotMatch(socketPortsDeclarations, /Promise<|\): void;|probe\?|grant\?|warn\?|SpawnSyncReturns|node:/);
    const socketApplicationDeclarations = readFileSync(join(packageRoot, "dist/application/container-socket-access.d.ts"), "utf8");
    assert.match(socketApplicationDeclarations, /createContainerSocketAccess\(ports: ContainerSocketAccessPorts\)/);
    assert.match(socketApplicationDeclarations, /run: \(target: string\) => undefined;/);
    assert.match(socketApplicationDeclarations, /resetWarning: \(\) => undefined;/);
    assert.doesNotMatch(socketApplicationDeclarations, /Promise<|ports\?:/);
    const socketFacadeDeclarations = readFileSync(join(packageRoot, "dist/docker.d.ts"), "utf8");
    assert.match(socketFacadeDeclarations, /ensureContainerManagerSocketAccess\(containerName: string\): void;/);
    assert.match(socketFacadeDeclarations, /resetContainerManagerSocketAccessWarningForTest\(\): void;/);
    assert.match(readFileSync(join(packageRoot, "dist/docker.js"), "utf8"), /import \{ createContainerSocketAccess \} from ["']\.\/application\/container-socket-access\.js["'];/);
    const codexPortsDeclarations = readFileSync(join(packageRoot, "dist/ports/codex-config-preparation.d.ts"), "utf8");
    for (const stage of ["probe", "repair", "finalize"]) assert.match(codexPortsDeclarations,
        new RegExp(`${stage}\\(target: string\\): \\{\\s*status: number \\| null;\\s*error\\?: unknown;\\s*\\};`));
    assert.doesNotMatch(codexPortsDeclarations, /Promise<|\): void;|probe\?|repair\?|finalize\?|SpawnSyncReturns|NodeJS|node:/);
    const codexApplicationDeclarations = readFileSync(join(packageRoot, "dist/application/codex-config-preparation.d.ts"), "utf8");
    assert.match(codexApplicationDeclarations, /createCodexConfigPreparation\(ports: CodexConfigPreparationPorts\)/);
    assert.match(codexApplicationDeclarations, /run: \(target: string\) => undefined;/);
    assert.doesNotMatch(codexApplicationDeclarations, /Promise<|ports\?:/);
    assert.match(readFileSync(join(packageRoot, "dist/docker.d.ts"), "utf8"), /prepareCodexConfigForContainer\(containerName: string, profile\?: string\): void;/);
    const lifecycleFacadeDeclarations = readFileSync(join(packageRoot, "dist/docker.d.ts"), "utf8");
    assert.match(lifecycleFacadeDeclarations, /startProjectContainer\(\.\.\.args: Parameters<typeof startProjectContainerLocked>\): string;/);
    assert.match(lifecycleFacadeDeclarations, /declare function startProjectContainerLocked\(projectPath: string, ensureDirs: \(\) => void,/);
    assert.match(lifecycleFacadeDeclarations, /onContainerReady\?: \(containerId: string, handoff: \{\s*startedByInvocation: boolean;\s*\}\) => void/);
    assert.match(lifecycleFacadeDeclarations, /initiallyRunningContainerId\?: string/);
    assert.match(lifecycleFacadeDeclarations, /onContainerStarted\?: \(containerId: string\) => void\): string;/);
    const ownershipHandleDeclarations = readFileSync(join(packageRoot, "dist/ports/session-ownership.d.ts"), "utf8");
    assert.match(ownershipHandleDeclarations, /updateContainer\(containerId: string \| null, runtime: SessionOwnershipRuntime, cleanupEnabled\?: boolean\): Promise<void>;/);
    assert.match(ownershipHandleDeclarations, /cleanupEnabled: boolean;/);
    assert.match(readFileSync(join(packageRoot, "dist/docker.js"), "utf8"), /import \{ createCodexConfigPreparation \} from ["']\.\/application\/codex-config-preparation\.js["'];/);
    const execPortsDeclarations = readFileSync(join(packageRoot, "dist/ports/container-exec-readiness.d.ts"), "utf8");
    assert.match(execPortsDeclarations, /now\(\): number;/);
    assert.match(execPortsDeclarations, /canExec\(target: string, timeoutMs: number\): boolean;/);
    assert.match(execPortsDeclarations, /sleep\(ms: number\): undefined;/);
    assert.doesNotMatch(execPortsDeclarations, /Promise<|\?:|\): void;/);
    const execApplicationDeclarations = readFileSync(join(packageRoot, "dist/application/container-exec-readiness.d.ts"), "utf8");
    assert.match(execApplicationDeclarations, /createContainerExecReadiness\(ports: ContainerExecReadinessPorts\)/);
    assert.match(execApplicationDeclarations, /run: \(target: string\) => boolean;/);
    assert.doesNotMatch(execApplicationDeclarations, /Promise<|\?:/);
    const execFacadeDeclarations = readFileSync(join(packageRoot, "dist/docker.d.ts"), "utf8");
    assert.match(execFacadeDeclarations, /canExecContainer\(containerName: string, timeoutMs\?: number\): boolean;/);
    assert.match(execFacadeDeclarations, /recreateRunningContainer\?: \(recreate: \(\) => void\) => boolean,/);
    const execFacadeSource = readFileSync(join(packageRoot, "dist/docker.js"), "utf8");
    assert.match(execFacadeSource, /import \{ createContainerExecReadiness \} from ["']\.\/application\/container-exec-readiness\.js["'];/);
    assert.match(execFacadeSource, /function canExecContainerAfterBriefRetry\(containerName\) \{\s*const sleeper = new Int32Array\(new SharedArrayBuffer\(4\)\);\s*return createContainerExecReadiness\(\{\s*now: \(\) => Date\.now\(\),\s*canExec: \(target, timeoutMs\) => canExecContainer\(target, timeoutMs\),\s*sleep: ms => \{\s*Atomics\.wait\(sleeper, 0, 0, ms\);\s*return undefined;\s*\},?\s*\}\)\.run\(containerName\);\s*\}/);
    const destructiveDeclarations = readFileSync(join(packageRoot, "dist/ports/container-destructive-lifecycle.d.ts"), "utf8");
    assert.match(destructiveDeclarations, /withLifecycleLock\(prefix: string, operation: \(\) => undefined\): undefined;/);
    assert.match(destructiveDeclarations, /cleanupDevices\(fullPath: string, timeoutMs: number, profile\?: string\): undefined;/);
    assert.match(destructiveDeclarations, /stop\(id: string\): undefined;/);
    assert.match(destructiveDeclarations, /remove\(id: string\): undefined;/);
    assert.match(destructiveDeclarations, /throwSessionClaims\(count: number\): never;/);
    const createDeclarations = readFileSync(join(packageRoot, "dist/ports/container-create-lifecycle.d.ts"), "utf8");
    assert.match(createDeclarations, /withFamilyLock\(prefix: string, operation: \(\) => string\): string;/);
    assert.match(createDeclarations, /namespaceExists\(name: string\): boolean;/);
    assert.match(createDeclarations, /findCollision\(\): \{\s*containerName: string;\s*\} \| null;/);
    assert.match(createDeclarations, /reportCreating\(name: string, debug: boolean \| undefined\): undefined;/);
    for (const name of ["reportLabWarning", "reportCreateFailure", "assertProjectSources", "assertDeviceSources", "assertFilesystemSources"]) {
        assert.match(createDeclarations, new RegExp(`${name}\\(\\): undefined;`));
    }
    assert.match(createDeclarations, /prepareRunArgs\(\): string\[\];/);
    assert.match(createDeclarations, /create\(args: string\[\]\): ContainerCreateResult;/);
    assert.match(createDeclarations, /status: number \| null;/);
    assert.match(createDeclarations, /stdout: string \| null \| undefined;/);
    assert.match(createDeclarations, /verifyCreated\(id: string\): CreatedContainerMountVerification;/);
    for (const name of ["removeRejected", "syncMcp", "fixSsh", "syncGit"]) {
        assert.match(createDeclarations, new RegExp(`${name}\\(id: string\\): undefined;`));
    }
    assert.match(createDeclarations, /explicitlyAbsent\(id: string\): boolean;/);
    assert.match(createDeclarations, /finish\(id: string\): string;/);
    assert.doesNotMatch(createDeclarations, /Promise<|\): void;/);
    assert.match(readFileSync(join(packageRoot, "dist/application/container-create-lifecycle.d.ts"), "utf8"), /run: \(request: ContainerCreateLifecycleRequest\) => string;/);
    const createContextDeclarations = readFileSync(join(packageRoot, "dist/composition/container-create-lifecycle.d.ts"), "utf8");
    assert.match(createContextDeclarations, /createCli: string;/);
    assert.match(createContextDeclarations, /createFailureHint: string;/);
    assert.match(createContextDeclarations, /labWarning\(\): \{\s*unsupportedReason\?: string;\s*\} \| null;/);
    assert.match(createContextDeclarations, /explicitlyNotFound\(result: ReturnType<typeof spawnSync>\): boolean;/);
    assert.doesNotMatch(createContextDeclarations, /Promise</);
    const imageDeclarations = readFileSync(join(packageRoot, "dist/ports/container-image-preparation.d.ts"), "utf8");
    for (const name of ["imageName", "version", "registryImage"]) {
        assert.match(imageDeclarations, new RegExp(`${name}: string;`));
    }
    assert.match(imageDeclarations, /exists\(\): boolean;/);
    assert.match(imageDeclarations, /label\(imageName: string, key: string\): string \| null;/);
    assert.match(imageDeclarations, /qualify\(ref: string\): string;/);
    assert.match(imageDeclarations, /pull\(ref: string\): boolean;/);
    assert.match(imageDeclarations, /tag\(source: string, target: string\): undefined;/);
    assert.match(imageDeclarations, /reportStale\(label: string, version: string\): undefined;/);
    assert.match(imageDeclarations, /reportPull\(version: string\): undefined;/);
    for (const name of ["reportFallback", "reportFailure"]) {
        assert.match(imageDeclarations, new RegExp(`${name}\\(ref: string\\): undefined;`));
    }
    for (const name of ["reportBuildHint", "exitFailure"]) {
        assert.match(imageDeclarations, new RegExp(`${name}\\(\\): undefined;`));
    }
    assert.doesNotMatch(imageDeclarations, /Promise<|\?:|\): void;|\): never;/);
    const imageApplicationDeclarations = readFileSync(join(packageRoot, "dist/application/container-image-preparation.d.ts"), "utf8");
    assert.match(imageApplicationDeclarations, /createContainerImagePreparation\(ports: ContainerImagePreparationPorts\)/);
    assert.match(imageApplicationDeclarations, /run: \(request: ContainerImagePreparationRequest\) => undefined;/);
    const imageCompositionDeclarations = readFileSync(join(packageRoot, "dist/composition/container-image-preparation.d.ts"), "utf8");
    assert.match(imageCompositionDeclarations, /readonly registryImage: string;/);
    assert.match(imageCompositionDeclarations, /isImageExists\(\): boolean;/);
    assert.match(imageCompositionDeclarations, /getImageLabel\(imageName: string, key: string\): string \| null;/);
    assert.match(imageCompositionDeclarations, /qualifyImageRefForRuntime\(ref: string\): string;/);
    assert.match(imageCompositionDeclarations, /pullImage\(ref: string\): boolean;/);
    assert.match(imageCompositionDeclarations, /tagImage\(source: string, target: string\): void;/);
    assert.match(imageCompositionDeclarations, /createNativeContainerImagePreparation\(helpers: NativeContainerImagePreparationHelpers\)/);
    assert.match(imageCompositionDeclarations, /run: \(\) => undefined;/);
    assert.doesNotMatch(imageCompositionDeclarations, /Promise<|\?:/);
    assert.match(readFileSync(join(packageRoot, "dist/docker.d.ts"), "utf8"), /ensureImage\(\): void;/);
    run(process.execPath, ["--input-type=module", "-e", [
        "import assert from 'node:assert/strict';",
        `const core=await import(${JSON.stringify(core)});`,
        "if(typeof core.createDeviceBrokerServer!=='function')throw Error('broker export missing');",
        `const hyperV=await import(${JSON.stringify(hyperV)});`,
        "if(typeof hyperV.createHyperVWindowsClient!=='function')throw Error('Hyper-V export missing');",
        `const transport=await import(${JSON.stringify(transport)});`,
        "const asset=transport.verifiedOperationAsset();if(!asset.scriptSource)throw Error('PowerShell asset missing');",
        `const sessionDomain=await import(${JSON.stringify(sessionDomain)});`,
        `const sessionApplication=await import(${JSON.stringify(sessionApplication)});`,
        `const sessionFacade=await import(${JSON.stringify(sessionFacade)});`,
        "const record=JSON.stringify({version:2,pid:17,startToken:'windows:123'});",
        "assert.deepEqual(sessionDomain.sessionLockOwner(record),{pid:17,startToken:'windows:123'});",
        "assert.deepEqual(sessionDomain.sessionLockOwner(' 17 '),{pid:17});",
        "assert.equal(sessionDomain.sessionLockOwner('017'),null);",
        "const observed=sessionDomain.parseProcessStartObservations('17 FOUND:123\\r\\n18 MISSING\\n19 UNKNOWN',[17,18,19]);",
        "assert.deepEqual([...observed],[[17,{status:'found',token:'windows:123'}],[18,{status:'missing'}],[19,{status:'unknown'}]]);",
        "assert.equal(sessionFacade.sessionLockOwner,sessionDomain.sessionLockOwner);",
        "assert.equal(sessionFacade.parseProcessStartObservations,sessionDomain.parseProcessStartObservations);",
        "const unexpected=()=>{throw Error('unexpected native session probe');};",
        "const classify=sessionApplication.createSessionLockLiveness({getPlatform:unexpected,observeProcessStart:unexpected,probeLegacyProcess:unexpected});",
        "for(const classifyCached of [classify,sessionFacade.sessionLockLiveness]){",
        "  assert.equal(classifyCached(record,observed),'active');",
        "  assert.equal(classifyCached(record,new Map([[17,{status:'found',token:'windows:456'}]])),'stale');",
        "  assert.equal(classifyCached(record,new Map([[17,{status:'missing'}]])),'stale');",
        "  assert.equal(classifyCached(record,new Map([[17,{status:'present'}]])),'unknown');",
        "  assert.equal(classifyCached('invalid'),'unknown');",
        "}",
        "const windows=sessionApplication.createSessionLockLiveness({getPlatform:()=>'win32',observeProcessStart:()=>({status:'present'}),probeLegacyProcess:unexpected});",
        "assert.equal(windows('17'),'active');",
        "const posix=sessionApplication.createSessionLockLiveness({getPlatform:()=>'linux',observeProcessStart:unexpected,probeLegacyProcess:()=>{throw Object.assign(Error('missing'),{code:'ESRCH'});}});",
        "assert.equal(posix('17'),'stale');",
        `const claimsDomain=await import(${JSON.stringify(claimsDomain)});`,
        `const claimsApplication=await import(${JSON.stringify(claimsApplication)});`,
        `const claimsFacade=await import(${JSON.stringify(claimsFacade)});`,
        "assert.equal(claimsDomain.encodeSessionClaim(17,'windows:123'),record);",
        "assert.equal(claimsDomain.encodeSessionClaim(17,null),'17');",
        "const claims=new Map();let locked=false;let replacements=0;",
        "const claimsApi=claimsApplication.createSessionClaims({",
        "  ensureDirectory:()=>undefined,listEntries:()=>[...claims.keys()],",
        "  claimPath:name=>'/claims/'+name,claimName:path=>path.slice('/claims/'.length),",
        "  readClaim:name=>claims.get(name),writeClaim:(path,content)=>{assert.equal(locked,true);claims.set(path.slice('/claims/'.length),content);},",
        "  removeClaim:path=>{claims.delete(path.slice('/claims/'.length));},",
        "  createId:()=> 'own',currentPid:()=>17,startToken:()=> 'windows:123',",
        "  observeOwners:pids=>new Map(pids.map(pid=>[pid,pid===17?{status:'found',token:'windows:123'}:{status:'missing'}])),",
        "  classify,withLifecycleLock:(prefix,operation)=>{assert.equal(prefix,'project');locked=true;try{return operation();}finally{locked=false;}},",
        "});",
        "const ownClaim=claimsApi.createSessionLock('project');",
        "assert.equal(ownClaim,'/claims/project--own.lock');assert.equal(claims.get('project--own.lock'),record);",
        "claims.set('project--foreign.lock',JSON.stringify({version:2,pid:18,startToken:'windows:999'}));",
        "assert.deepEqual(claimsApi.getSessionLockClaimsForContainer('project'),['project--own.lock','project--foreign.lock']);",
        "assert.equal(claimsApi.hasOtherSessionClaims('project',ownClaim),true);",
        "assert.deepEqual(claimsApi.getActiveSessionsForContainer('project'),['project--own.lock']);",
        "assert.equal(claims.has('project--foreign.lock'),false);",
        "assert.equal(claimsApi.recreateContainerWithoutInterruptingSessions('project',ownClaim,()=>{assert.equal(locked,true);replacements++;}),true);",
        "assert.equal(replacements,1);",
        `const cleanupApplication=await import(${JSON.stringify(cleanupApplication)});`,
        `const cleanupPorts=await import(${JSON.stringify(cleanupPorts)});`,
        "assert.deepEqual(Object.keys(cleanupPorts),[]);",
        "const emptyContext={lockFile:null,projectPath:null,profile:undefined,toolName:null};",
        "const cleanupTrace=[];let cleanupLocked=false;let foreignClaim=false;",
        "const cleanupApi=cleanupApplication.createSessionCleanup({",
        "  projectId:path=>{cleanupTrace.push(['project',path]);return 'project';},",
        "  withLifecycleLock:(prefix,operation)=>{cleanupTrace.push(['lock',prefix]);cleanupLocked=true;try{return operation();}finally{cleanupLocked=false;cleanupTrace.push(['unlock',prefix]);}},",
        "  hasOtherClaims:(prefix,ownPath)=>{assert.equal(cleanupLocked,true);cleanupTrace.push(['raw',prefix,ownPath]);return foreignClaim;},",
        "  removeClaim:path=>{assert.equal(cleanupLocked,true);cleanupTrace.push(['remove',path]);return undefined;},",
        "  cleanupDevices:(path,timeout,profile)=>{assert.equal(cleanupLocked,true);cleanupTrace.push(['devices',path,timeout,profile]);return undefined;},",
        "  reportDeviceCleanupFailure:unexpected,",
        "  stopContainer:readId=>{assert.equal(cleanupLocked,true);assert.equal(typeof readId,'function');cleanupTrace.push(['stop',readId()]);return undefined;},",
        "});",
        "assert.deepEqual(cleanupApi.getCurrentSession(),emptyContext);cleanupApi.cleanupSession();assert.deepEqual(cleanupTrace,[]);",
        "cleanupApi.setSession('/claims/own.lock','/project','work','codex');cleanupApi.setSessionCleanupEnabled(true);cleanupApi.setSessionContainerId('captured-id');",
        "const cleanupSnapshot=cleanupApi.getCurrentSession();",
        "assert.deepEqual(cleanupSnapshot,{lockFile:'/claims/own.lock',projectPath:'/project',profile:'work',toolName:'codex'});",
        "assert.notEqual(cleanupSnapshot,cleanupApi.getCurrentSession());cleanupSnapshot.lockFile='outside';assert.equal(cleanupApi.getCurrentSession().lockFile,'/claims/own.lock');",
        "cleanupApi.cleanupSession();",
        "assert.deepEqual(cleanupTrace,[['project','/project'],['lock','project--p--work'],['raw','project--p--work','/claims/own.lock'],['devices','/project',5000,'work'],['stop','captured-id'],['remove','/claims/own.lock'],['unlock','project--p--work']]);",
        "assert.deepEqual(cleanupApi.getCurrentSession(),{...emptyContext,toolName:'codex'});",
        "cleanupTrace.length=0;cleanupApi.setSession('/claims/next.lock','/next');cleanupApi.cleanupSession();assert.deepEqual(cleanupTrace,[]);",
        "cleanupTrace.length=0;cleanupApi.clearSession();cleanupApi.setSession('/claims/denied.lock','/denied');cleanupApi.setSessionContainerId('preserved-id');cleanupApi.setSessionCleanupEnabled(false);cleanupApi.cleanupSession();",
        "assert.deepEqual(cleanupTrace,[['project','/denied'],['lock','project'],['raw','project','/claims/denied.lock'],['remove','/claims/denied.lock'],['unlock','project']]);cleanupTrace.length=0;",
        "cleanupApi.clearSession();assert.deepEqual(cleanupApi.getCurrentSession(),emptyContext);",
        "cleanupApi.setSession('/claims/foreign-own.lock','/foreign','','');cleanupApi.setSessionContainerId('must-not-stop');foreignClaim=true;cleanupApi.cleanupSession();",
        "assert.deepEqual(cleanupTrace,[['project','/foreign'],['lock','project'],['raw','project','/claims/foreign-own.lock'],['remove','/claims/foreign-own.lock'],['unlock','project']]);",
        "assert.deepEqual(cleanupApi.getCurrentSession(),{...emptyContext,toolName:''});",
        "cleanupApi.clearSession();cleanupTrace.length=0;foreignClaim=false;cleanupApi.setSession('/claims/reset.lock','/reset');cleanupApi.setSessionCleanupEnabled(true);cleanupApi.cleanupSession();",
        "assert.deepEqual(cleanupTrace,[['project','/reset'],['lock','project'],['raw','project','/claims/reset.lock'],['devices','/reset',5000,undefined],['remove','/claims/reset.lock'],['unlock','project']]);",
        "assert.deepEqual(cleanupApi.getCurrentSession(),{...emptyContext,toolName:'claude'});",
        "claimsFacade.clearSession();assert.deepEqual(claimsFacade.getCurrentSession(),emptyContext);",
        "for(const [profile,tool,expectedTool] of [[undefined,undefined,'claude'],['','',''],['work','codex','codex']]){",
        "  claimsFacade.setSession('/context.lock','/context',profile,tool);claimsFacade.setSessionContainerId('hidden-id');",
        "  const snapshot=claimsFacade.getCurrentSession();assert.deepEqual(snapshot,{lockFile:'/context.lock',projectPath:'/context',profile,toolName:expectedTool});",
        "  assert.notEqual(snapshot,claimsFacade.getCurrentSession());snapshot.lockFile='outside';assert.equal(claimsFacade.getCurrentSession().lockFile,'/context.lock');",
        "  claimsFacade.clearSession();assert.deepEqual(claimsFacade.getCurrentSession(),emptyContext);",
        "}",
        "const fs=await import('node:fs');const path=await import('node:path');",
        `const homeLayout=await import(${JSON.stringify(homeLayout)});`,
        "const claimDir=homeLayout.locksDir();",
        `assert.ok(path.relative(${JSON.stringify(temporary)},claimDir).split(path.sep)[0]!== '..' && !path.isAbsolute(path.relative(${JSON.stringify(temporary)},claimDir)));`,
        "fs.mkdirSync(claimDir,{recursive:true,mode:0o700});",
        "const rawClaim=path.join(claimDir,'distribution--foreign.lock');fs.writeFileSync(rawClaim,'unreadable-as-owner',{mode:0o600,flag:'wx'});",
        "try{assert.deepEqual(claimsFacade.getSessionLockClaimsForContainer('distribution'),['distribution--foreign.lock']);assert.equal(claimsFacade.hasOtherSessionClaims('distribution',path.join(claimDir,'distribution--own.lock')),true);assert.equal(fs.readFileSync(rawClaim,'utf8'),'unreadable-as-owner');}finally{fs.unlinkSync(rawClaim);}",
    ].join("\n")]);
    const lifecycleUrls = ["application/container-existing-lifecycle", "composition/container-existing-lifecycle", "docker"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyExistingLifecycle.toString()})(...${JSON.stringify(lifecycleUrls)});`]);
    const destructiveUrls = ["application/container-destructive-lifecycle", "composition/container-destructive-lifecycle", "docker"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyDestructiveLifecycle.toString()})(...${JSON.stringify(destructiveUrls)});`]);
    const createUrls = ["application/container-create-lifecycle", "ports/container-create-lifecycle", "composition/container-create-lifecycle", "docker"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyCreateLifecycle.toString()})(...${JSON.stringify(createUrls)});`]);
    const imageUrls = ["application/container-image-preparation", "ports/container-image-preparation", "composition/container-image-preparation", "docker"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyImagePreparation.toString()})(...${JSON.stringify(imageUrls)});`]);
    const handoffUrls = ["application/container-session-handoff", "ports/container-session-handoff", "docker"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifySessionHandoff.toString()})(...${JSON.stringify(handoffUrls)});`]);
    const ownershipApplicationUrl = pathToFileURL(join(packageRoot, "dist/application/session-ownership.js")).href;
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifySessionShutdownAuthorization.toString()})(${JSON.stringify(ownershipApplicationUrl)});`]);
    const readinessUrls = ["application/container-runtime-readiness", "ports/container-runtime-readiness", "docker"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyRuntimeReadiness.toString()})(...${JSON.stringify(readinessUrls)});`]);
    const execReadinessUrls = ["application/container-exec-readiness", "ports/container-exec-readiness"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyExecReadiness.toString()})(...${JSON.stringify(execReadinessUrls)});`]);
    const publicExecReadinessUrls = ["docker", "container-runtime"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyCompiledPublicExecReadiness.toString()})(...${JSON.stringify(publicExecReadinessUrls)});`]);
    const socketUrls = ["application/container-socket-access", "ports/container-socket-access", "docker", "container-runtime"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `const createOwnedImportRead = ${createOwnedImportRead.toString()}; await (${verifySocketAccess.toString()})(...${JSON.stringify(socketUrls)});`]);
    console.log("PASS socket distribution: compiled core and actual public facade, strict declarations, raw observations, native fences and warning/reset lifetime");
    const requestedToolApplication = pathToFileURL(join(packageRoot, "dist/application/requested-tool-setup.js")).href;
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyRequestedToolSetup.toString()})(${JSON.stringify(requestedToolApplication)});`]);
    const requestedToolFacadeSource = readFileSync(join(packageRoot, "dist/container-setup.js"), "utf8");
    assert.match(requestedToolFacadeSource, /import \{ createRequestedToolSetup \} from ["']\.\/application\/requested-tool-setup\.js["'];/);
    const requestedToolFacadeBody = requestedToolFacadeSource.match(/export function ensureTools\(containerName, activeTool\) \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(requestedToolFacadeBody, "compiled public ensureTools must be present");
    assert.match(requestedToolFacadeBody, /createRequestedToolSetup\(\{/);
    assert.match(requestedToolFacadeBody, /ensureClaudeLauncher: ensureClaudeInContainer/);
    assert.match(requestedToolFacadeBody, /ensureNpmTool,/);
    assert.match(requestedToolFacadeBody, /probeLauncher: \(target, path\) => spawnSync\(/);
    assert.match(requestedToolFacadeBody, /ensureCodexSandbox: ensureCodexBubblewrap/);
    assert.match(requestedToolFacadeBody, /\}\)\.ensure\(containerName, activeTool\);/);
    const toolLayoutUrls = ["domain/tool-layout", "tool-registry", "container-setup", "container-runtime"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    for (const first of ["registry", "setup"]) {
        run(process.execPath, ["--input-type=module", "-e",
            `const createOwnedImportRead = ${createOwnedImportRead.toString()}; await (${verifyToolRegistryLayout.toString()})(...${JSON.stringify(toolLayoutUrls)},${JSON.stringify(first)});`]);
    }
    console.log("PASS requested-tool setup distribution: compiled core success/timeout/throw identity, exact declarations and actual public facade wiring with fenced VALID/INSTALL execution in both import orders");
    const contract = join(packageRoot, "tool-layout-consumer.mts");
    writeFileSync(contract, [
        'import { CLAUDE_BIN_PATH as domain } from "./dist/domain/tool-layout.js";',
        'import { CLAUDE_BIN_PATH as publicPath, type ClaudeLayoutPaths } from "./dist/container-setup.js";',
        'import type { ToolDefinition, CredentialMount } from "./dist/tool-registry.js";',
        'const literal: "/home/ccc/.local/bin/claude" = publicPath;',
        'const shared: typeof domain = publicPath;',
        'declare const tool: ToolDefinition; declare const mount: CredentialMount; declare const layout: ClaudeLayoutPaths;',
        'const strings: string[] = [tool.binary, mount.hostDir, mount.containerDir, layout.bin];',
        '// @ts-expect-error Public declaration remains the existing literal.',
        'const wrong: typeof publicPath = "/other/claude";',
        '// @ts-expect-error Domain declaration cannot become numeric.',
        'const numeric: number = domain;',
        'void [literal, shared, strings, wrong, numeric];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", contract]);
    } finally { rmSync(contract); }
    console.log("PASS tool layout distribution: both fresh production import orders, metadata/identity, public setup commands, native fences and literal declaration consumer");
    const toolRegistryUrls = ["domain/tool-registry", "tool-registry"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `await (${verifyToolRegistryDomain.toString()})(...${JSON.stringify(toolRegistryUrls)});`]);
    const toolRegistryContract = join(packageRoot, "tool-registry-domain-consumer.mts");
    writeFileSync(toolRegistryContract, [
        'import { createDefaultToolCatalog, findToolByName, findDefaultTool, getAllCredentialMounts, getNpmTools, type ToolDefinition as DomainTool, type CredentialMount as DomainMount } from "./dist/domain/tool-registry.js";',
        'import { getToolByName, getDefaultTool, getAllTools, getAllCredentialMounts as publicMounts, getNpmTools as publicNpm, type ToolDefinition, type CredentialMount } from "./dist/tool-registry.js";',
        'declare module "./dist/tool-registry.js" { interface ToolDefinition { fixtureOptionalTool?: string; } interface CredentialMount { fixtureOptionalMount?: string; } }',
        'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
        'declare const tool: ToolDefinition; declare const domainTool: DomainTool; declare const mount: CredentialMount; declare const domainMount: DomainMount;',
        'const inward: DomainTool = tool; const outward: ToolDefinition = domainTool; const inwardMount: DomainMount = mount; const outwardMount: CredentialMount = domainMount;',
        'const catalog: DomainTool[] = createDefaultToolCatalog(); const publicCatalog: ToolDefinition[] = catalog;',
        'const minimal: DomainTool = { name: "custom", displayName: "Custom", binary: "custom", defaultFlags: [], credentialMounts: [], needsNodeRuntime: false, updateCommand: [], installCommand: "installer" };',
        'tool.defaultFlags.push("mutable"); tool.credentialMounts.push(domainMount); tool.credentialMounts[0].hostDir = "mutable"; domainTool.credentialMounts[0].containerDir = "/mutable"; domainTool.subcommands = ["command"];',
        'const optional: string[] | undefined = minimal.subcommandsAcceptingDefaultFlags;',
        'const current: ToolDefinition = getDefaultTool(); const toolField: string | undefined = current.fixtureOptionalTool;',
        'const nestedField: string | undefined = current.credentialMounts[0].fixtureOptionalMount; const projectedMount: CredentialMount = publicMounts()[0]; const mountField: string | undefined = projectedMount.fixtureOptionalMount;',
        'const exact: [Equal<ReturnType<typeof createDefaultToolCatalog>, DomainTool[]>, Equal<ReturnType<typeof findToolByName>, DomainTool | undefined>, Equal<ReturnType<typeof findDefaultTool>, DomainTool | undefined>, Equal<ReturnType<typeof getAllCredentialMounts>, DomainMount[]>, Equal<ReturnType<typeof getNpmTools>, Array<{cmd:string;pkg:string}>>, Equal<ReturnType<typeof getDefaultTool>, ToolDefinition>, Equal<ReturnType<typeof getToolByName>, ToolDefinition | undefined>, Equal<ReturnType<typeof getAllTools>, ToolDefinition[]>, Equal<ReturnType<typeof publicMounts>, CredentialMount[]>, Equal<ReturnType<typeof publicNpm>, Array<{cmd:string;pkg:string}>>] = [true,true,true,true,true,true,true,true,true,true];',
        '// @ts-expect-error Name selection requires explicit catalog and query.',
        'findToolByName();',
        '// @ts-expect-error The query remains required.',
        'findToolByName(catalog);',
        '// @ts-expect-error Query is a string.',
        'findToolByName(catalog, 1);',
        '// @ts-expect-error Catalog cannot be a tool name.',
        'findToolByName("claude", "claude");',
        '// @ts-expect-error Default selection requires catalog.',
        'findDefaultTool();',
        '// @ts-expect-error Credential projection requires catalog.',
        'getAllCredentialMounts();',
        '// @ts-expect-error Npm projection requires catalog.',
        'getNpmTools();',
        '// @ts-expect-error Factory does not accept a catalog.',
        'createDefaultToolCatalog(catalog);',
        '// @ts-expect-error Domain default can be missing.',
        'const required: DomainTool = findDefaultTool(catalog);',
        '// @ts-expect-error Public named lookup can be missing.',
        'const named: ToolDefinition = getToolByName("unknown");',
        '// @ts-expect-error Public default static type remains nonnull.',
        'const absent: undefined = getDefaultTool();',
        '// @ts-expect-error Factory remains synchronous.',
        'const asyncCatalog: Promise<DomainTool[]> = createDefaultToolCatalog();',
        '// @ts-expect-error Mounts retain their shape.',
        'const wrongMounts: DomainTool[] = getAllCredentialMounts(catalog);',
        '// @ts-expect-error Npm output fields remain strings.',
        'const wrongPackages: Array<{cmd:string;pkg:number}> = getNpmTools(catalog);',
        '// @ts-expect-error Optional subcommands are string arrays.',
        'domainTool.subcommands = [1];',
        '// @ts-expect-error Mount directory remains string.',
        'domainMount.hostDir = 1;',
        '// @ts-expect-error Required tool fields remain required.',
        'const incomplete: ToolDefinition = { name: "custom" };',
        'void [inward,outward,inwardMount,outwardMount,publicCatalog,minimal,optional,toolField,nestedField,mountField,exact,required,named,absent,asyncCatalog,wrongMounts,wrongPackages,incomplete];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", toolRegistryContract]);
    } finally { rmSync(toolRegistryContract); }
    console.log("PASS tool registry domain distribution: actual compiled factory/custom selection and legacy mutations, native fences, receivers/errors, old/new declarations and optional nested interface augmentation");
    const preferenceHome = mkdtempSync(join(temporary, "tool-preferences-home-"));
    const preferenceSmoke = spawnSync(process.execPath, ["--input-type=module", "-e", [
        `const detect = await import(${JSON.stringify(pathToFileURL(join(packageRoot, "dist/tool-detect.js")).href)});`,
        `const { getToolByName, getDefaultTool } = await import(${JSON.stringify(pathToFileURL(join(packageRoot, "dist/tool-registry.js")).href)});`,
        'const { strict: assert } = await import("node:assert");',
        'const { readFileSync, writeFileSync } = await import("node:fs");',
        'const { join } = await import("node:path");',
        'const config = join(process.env.HOME, ".ccc", "config.json");',
        'assert.equal(detect.getDefaultToolPreference(), null);',
        'assert.equal(detect.resolveTool({}), getDefaultTool());',
        'detect.setDefaultToolPreference("codex");',
        'writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), remote: { kept: true } }));',
        'detect.setDefaultToolPreference("gemini");',
        'assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { defaultTool: "gemini", remote: { kept: true } });',
        'assert.equal(detect.resolveTool({}), getToolByName("gemini"));',
        'assert.equal(detect.resolveTool({ CCC_TOOL: "opencode" }), getToolByName("opencode"));',
        'writeFileSync(config, "{ broken");',
        'assert.throws(() => detect.setDefaultToolPreference("codex"), /not a valid JSON object/);',
        'assert.equal(readFileSync(config, "utf8"), "{ broken");',
        'assert.equal(detect.resolveTool({}), getDefaultTool());',
    ].join("\n")], { cwd: temporary, env: { ...env, HOME: preferenceHome, USERPROFILE: preferenceHome },
        encoding: "utf8", timeout: 120000, windowsHide: true });
    assert.equal(preferenceSmoke.status, 0, String(preferenceSmoke.error || preferenceSmoke.stderr).slice(0, 2000));
    console.log("PASS tool preference distribution: compiled facade saves, preserves keys, refuses invalid config and resolves env/saved/default");
    const codexConfigUrls = ["application/codex-config-preparation", "ports/codex-config-preparation", "docker", "container-runtime"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `const createOwnedImportRead = ${createOwnedImportRead.toString()}; await (${verifyCodexConfigPreparation.toString()})(...${JSON.stringify(codexConfigUrls)});`]);
    console.log("PASS Codex config distribution: compiled core and actual public facade, strict declarations, commands and observation parity");
    await mcpSmoke(packageRoot, "device-lab-mcp");
}

try {
    run(process.execPath, ["--test", join(root, "scripts/fixtures/owned-import-read.test.mjs")], root);
    run(process.execPath, ["--test", join(root, "scripts/tests/workspace-windows-lx-links.test.mjs")], root);
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("Run this verification through npm so npm_execpath is available.");
    // Exercise incremental cleanup and packaging in an isolated checkout. Never
    // seed or assemble active dist artifacts while another suite is using them.
    const fixture = join(temporary, "checkout");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    mkdirSync(fixture);
    for (const path of new Set(["package.json", "README.md", "LICENSE", "packages", ...manifest.files])) {
        const source = join(root, path);
        if (!existsSync(source)) continue;
        const destination = join(fixture, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination, { recursive: true,
            filter: candidate => !relative(source, candidate).split(sep).includes("node_modules") });
    }
    const obsolete = join(fixture, "dist/x11-mcp");
    mkdirSync(obsolete, { recursive: true });
    writeFileSync(join(obsolete, "server.mjs"), "throw Error('obsolete X11 bundle survived');\n");
    const preserved = join(fixture, "dist/incremental-preservation.txt");
    writeFileSync(preserved, "unrelated generated output\n");
    const deviceLabBundle = readFileSync(join(fixture, "dist/device-lab-mcp/server.mjs"));
    assembleWorkspaceRuntime(fixture);
    assert.equal(existsSync(obsolete), false, "incremental assembly retained the obsolete X11 bundle");
    assert.equal(readFileSync(preserved, "utf8"), "unrelated generated output\n");
    assert.deepEqual(readFileSync(join(fixture, "dist/device-lab-mcp/server.mjs")), deviceLabBundle);
    rmSync(preserved);
    const report = JSON.parse(run(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary], fixture));
    const reports = Array.isArray(report) ? report : Object.values(report);
    assert.equal(reports.length, 1, "expected one packed workspace distribution");
    const [packedReport] = reports;
    const filename = packedReport?.filename;
    assert.ok(typeof filename === "string" && /^[A-Za-z0-9._-]+\.tgz$/.test(filename));
    assert.ok(Array.isArray(packedReport.files), "npm pack did not report package files");
    assert.ok(packedReport.files.every(({ path }) => !/^(?:dist\/)?x11-mcp(?:\/|$)/.test(path)),
        "npm package contains standalone X11 artifacts");
    run(process.platform === "win32" ? "tar.exe" : "tar", ["-xzf", join(temporary, filename), "-C", temporary]);
    const packed = join(temporary, "package");
    await smoke(packed);
    const installed = join(temporary, "unix-install");
    const installer = pathToFileURL(join(packed, "scripts/install.js")).href;
    run(process.execPath, ["--input-type=module", "-e",
        `const {materializeUnixInstallPayload}=await import(${JSON.stringify(installer)});materializeUnixInstallPayload(${JSON.stringify(packed)},${JSON.stringify(installed)});`]);
    await smoke(installed);
    console.log("PASS workspace distribution: obsolete X11 output removed; extracted npm package and materialized install CLI, broker, Hyper-V assets, Device Lab MCP, session liveness, claims, cleanup, existing, explicit destructive and fresh creation container lifecycle, image preparation, container session handoff and runtime readiness core/facade and declarations; exec readiness core and compiled public guarded startProjectContainer retry success/exhaustion preservation");
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
