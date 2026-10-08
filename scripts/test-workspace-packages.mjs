import assert from "node:assert/strict";
import ts from "typescript";
import { createRequire, isBuiltin } from "node:module";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { assembleWorkspaceRuntime } from "./workspace-build.mjs";
import { createOwnedImportRead } from "./fixtures/owned-import-read.mjs";

// Independent source/command evidence captured before the installation extraction.
const CONTAINER_INSTALLATION_BASELINE = {"sourceBaseline":"4d0e62552bcecb54fb5549eff27af174ef644784","commandBaseline":"7422ce7979f5aada6d7c6ef3121195e9bd1137f7","assetHashes":{"shellQuote":"f618b522b616c35e586580d6c0c46ec623b3d58d6767585db1b75aa25ddbf505","boundedContainerMutation":"18048b628a24e45960fec8423217d6de97bb56321a7138986838f4eb53085a9a","boundedShortContainerMutation":"918ed03213458d39ed4e06aff0a6e24db25cf8bec7a9ef3ae4f711d4d5639d5f","buildClaudeProbeScript":"1845f4543e4b624c69bf508a3df74d1195557e990501fef3d4170de4affa4c6f","reportProbeNotes":"3c54c0b219cadda72089ceb3beea5a1fcc58b333ad4606164686962b076a7231","sanitizeForTerminal":"161a85de2d2280671c89d938bd61919876d65521a76429f6dfab508d93ae06b9","probeDiagnostic":"233a519d33f56b49b9dd9500864f4a1b3a64d4efb53c5dc94384d06aaafe2e48","buildClaudeLauncherReportCommand":"2eea4844b16d09dc607f6ee6424acd9ab87c59bfd661d9eb670104276d7a2d11"},"cases":{"claude-valid":{"commands":1,"hashes":["c777e0cb7546a142b3357bee03bcb591ec594bd630d3e7b80f117f567ec5b5da"],"logs":[["removed synthetic-entry"]],"progress":[]},"claude-restored":{"commands":1,"hashes":["c777e0cb7546a142b3357bee03bcb591ec594bd630d3e7b80f117f567ec5b5da"],"logs":[["Reusing claude 1.2.3 from the shared volume."]],"progress":[]},"claude-install":{"commands":3,"hashes":["c777e0cb7546a142b3357bee03bcb591ec594bd630d3e7b80f117f567ec5b5da","c37ecc501223af86545385a1a4293b302927d49d5e6181cc5cfbc2cf27122c27","c777e0cb7546a142b3357bee03bcb591ec594bd630d3e7b80f117f567ec5b5da"],"logs":[["cannot remove synthetic-entry"],["Installing claude (first run)..."]],"progress":[]},"npm-present":{"commands":2,"hashes":["6d4ad72cb4a9e1df665b35a388b9f025d7d1f035f0f0fde9508d982a2ed2039b","4577147c4b0d4bdd337bb8c8a1f5d9b0d26418b26e6990fd56f30b4e8ebd5c61"],"logs":[],"progress":[]},"npm-ready":{"commands":4,"hashes":["6d4ad72cb4a9e1df665b35a388b9f025d7d1f035f0f0fde9508d982a2ed2039b","39c43d19a35dafc7cf0c5a9795c435278622024b3bef0ddae2be0d3ae63558de","1883f6446f152a9fba326c476fc87293a48a8caeb7903eb61629da805461a0ab","4577147c4b0d4bdd337bb8c8a1f5d9b0d26418b26e6990fd56f30b4e8ebd5c61"],"logs":[],"progress":[]},"npm-missing":{"commands":8,"hashes":["6d4ad72cb4a9e1df665b35a388b9f025d7d1f035f0f0fde9508d982a2ed2039b","39c43d19a35dafc7cf0c5a9795c435278622024b3bef0ddae2be0d3ae63558de","450ca03c8724b358c49a552453da1a44e74445db5365168078be53940b00d2a6","3c40343d7c390da6a121eb084fe42b3ce3f8de2e8808da772fe37687f5f0eeca","cc9ef57a74d06dd6c0b1398881ecd042ef67e2cc60526d028b28c69f3a32e21e","c5a83e34740e71f28d49a718c678f3b9c71015a28ccf965a706b44e016b807a1","1883f6446f152a9fba326c476fc87293a48a8caeb7903eb61629da805461a0ab","4577147c4b0d4bdd337bb8c8a1f5d9b0d26418b26e6990fd56f30b4e8ebd5c61"],"logs":[["Installing gemini..."]],"progress":[]},"bubble-present":{"commands":3,"hashes":["1cf28527b8201aea2443944aebd2957bf98aa23240d0b4976e3ce2bde1a9bcac","d0501c3cfbc15c69a58c2d542e48ec61bfc6cc0ede8da3f7c8e6230f7336cc05","094cb7f35aad22e0afb98fdb07128f62a408d125c16bd4e75f12df7d5418a4a9"],"logs":[],"progress":[]},"bubble-missing":{"commands":6,"hashes":["1cf28527b8201aea2443944aebd2957bf98aa23240d0b4976e3ce2bde1a9bcac","d0501c3cfbc15c69a58c2d542e48ec61bfc6cc0ede8da3f7c8e6230f7336cc05","094cb7f35aad22e0afb98fdb07128f62a408d125c16bd4e75f12df7d5418a4a9","7a88b052b2e426eff06226ef55eb9ce026a45ccca9892ca654b669c5b855a467","fa26aa46d9c62d4a802952e20903fc0214d92c90737adee4f114b0ee0c7476b1","094cb7f35aad22e0afb98fdb07128f62a408d125c16bd4e75f12df7d5418a4a9"],"logs":[["Installing bubblewrap for Codex..."]],"progress":[]},"uv-present":{"commands":1,"hashes":["5e6f76ef271a0189abfbb6218efc1e63bf05c4dc8f9846e3ce0d96fb4da2b625"],"logs":[],"progress":[]},"uv-missing":{"commands":2,"hashes":["5e6f76ef271a0189abfbb6218efc1e63bf05c4dc8f9846e3ce0d96fb4da2b625","7577f852f3f8994eb65d99ce7525de730109c1a9226b69cd23c6fd1538932215"],"logs":[],"progress":["\u001b[2m\u25b8 Installing uv (one-time, ~30-60s)...\u001b[0m\n"]}}};

// Independent hashes captured from accepted 9322c7e6 before the credential extraction.
const HOST_CREDENTIAL_ASSET_BASELINE = {
    "baseline": "9322c7e69a357f2a8b07296ea632110387ac8948",
    "hashes": {
        "sshDefault": "fd51e763f1cfffb14fb5d8dee11a37e82fe2de4b84587251b8739648e3ad0875",
        "sshFalse": "fd51e763f1cfffb14fb5d8dee11a37e82fe2de4b84587251b8739648e3ad0875",
        "sshTrue": "c0572abc56af6a2d15e2b9b67312c2e1a1c03051191bcf668a3160070651e79f",
        "signing": "1e01e43d18f169911673c4a63b0b915c4cd1ae264aaca8c017e1748c41e4a5bb",
        "python": "d5939c35f33717ca7d7452cce7025a0632a21523a61b657b7feec29616d30ffd"
    },
    "names": {
        "ssh": "sshCredentialCopyShell",
        "signing": "gitSigningKeyRewriteShell"
    },
    "arities": {
        "ssh": 0,
        "signing": 0
    }
};

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
    const fenceHome=mkdtempSync(join(temporary,'mcp-wave-fence-'));
    const preload=join(fenceHome,'fence.cjs'), effects=join(fenceHome,'effects.log'), armed=join(fenceHome,'armed');
    writeFileSync(effects,'');
    writeFileSync(preload, `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
const effects=${JSON.stringify(effects)},home=${JSON.stringify(fenceHome)};
const append=fs.appendFileSync,exists=fs.existsSync;
function deny(kind){append(effects,kind+'\\n');throw new Error('Unallocated packaged MCP effect:'+kind);}
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=()=>deny('process:'+key);
for(const key of ['connect','createConnection'])net[key]=()=>deny('network:'+key);
net.Socket.prototype.connect=()=>deny('socket');require('node:tls').connect=()=>deny('tls');
for(const key of ['request','get']){require('node:http')[key]=()=>deny('http');require('node:https')[key]=()=>deny('https');}
for(const key of ['existsSync','statSync','lstatSync','readdirSync','readFileSync','openSync']){const original=fs[key];fs[key]=function(selected,...args){if(exists(home+'/armed')&&String(selected).startsWith(home+'/.ccc'))return deny('inventory:'+key);return original.call(this,selected,...args);};}
globalThis.fetch=()=>deny('fetch');require('node:module').syncBuiltinESMExports();`);
    const child = spawn(process.execPath, ['--require',preload,join(packageRoot, `dist/${serverName}/server.mjs`)], {
        cwd: fenceHome, env: {...env,HOME:fenceHome,USERPROFILE:fenceHome}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
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
        if(serverName==='device-lab-mcp') {
            writeFileSync(armed,'armed');
            const call=async (name,args)=>{const response=await request('tools/call',{name,arguments:args});assert.equal(response.isError,true);return JSON.parse(response.content[0].text);};
            const missing=await call('delete',{deviceId:'android-shipping-fixture',detail:true});
            assert.equal(missing.policy.error,'destructive-action-confirmation-required');
            assert.deepEqual(missing.policy.actions,['device-delete']);
            const invalid=await call('delete',{deviceId:'android-shipping-fixture',confirmDestructive:'true',detail:true});
            assert.equal(invalid.error,'delete confirmDestructive must be a boolean'); assert.equal(Object.hasOwn(invalid,'policy'),false);
            const inherited=await call('run_flow',{confirmDestructive:true,steps:[{tool:'clear_app_data',arguments:{deviceId:'android-shipping-fixture',appId:'example.app'}}]});
            assert.equal(inherited.error,'run_flow does not support confirmDestructive');
            for(const stopOnError of [true,false]) {
                const result=await call('run_flow',{stopOnError,detail:true,steps:[
                    {tool:'clear_app_data',arguments:{deviceId:'android-shipping-fixture',appId:'example.app'}},
                    {tool:'unsupported-shipping-tool'}]});
                assert.equal(result.ok,false); assert.equal(result.results.length,stopOnError?1:2);
                assert.deepEqual(result.results.map(step=>step.index),stopOnError?[0]:[0,1]);
                assert.equal(result.results[0].content[0].value.policy.error,'destructive-action-confirmation-required');
                if(stopOnError)assert.equal(result.stoppedAt,0);
                else assert.match(result.results[1].error,/does not allow step tool/);
            }
            assert.equal(readFileSync(effects,'utf8'),'','packaged MCP must not cross native/network/inventory fence');
        }
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

async function verifyCodexConfigPreparation(applicationUrl, portsUrl, facadeUrl, runtimeUrl, orderedUrl) {
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
        const { createOrderedCodexConfigPreparation } = await import(orderedUrl);
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
        const orderedTrace = [];
        let mappedUid = 0;
        const orderedPorts = {
            resolveConfig(profile) { assert.equal(this, orderedPorts); orderedTrace.push(["resolve", profile]); return "resolved-config"; },
            hasHostIdentity() { orderedTrace.push("identity"); return true; },
            inspectParent(config) { assert.equal(config,"resolved-config"); orderedTrace.push("parent"); return { uid: 1001, isDirectory() { return true; } }; },
            inspectConfig(config) { assert.equal(config,"resolved-config"); orderedTrace.push("config"); return { nlink: 1, isFile() { return true; } }; },
            currentHostUid() { orderedTrace.push("host-uid"); return 1001; },
            mappedContainerUid(target) { assert.equal(target,"outer-target"); orderedTrace.push("mapped-uid"); return String(++mappedUid); },
        };
        for (const name of ["probeDirectory","repairDirectory","verifyDirectory","probeConfig","repairConfig","verifyConfig"]) {
            orderedPorts[name] = function (target, config, uid) {
                assert.equal(this,orderedPorts); assert.equal(target,"outer-target"); assert.equal(config,"resolved-config");
                orderedTrace.push([name,uid]); return { status: name.startsWith("probe") ? 1 : 0 };
            };
        }
        const ordered = createOrderedCodexConfigPreparation(orderedPorts);
        assert.deepEqual(orderedTrace,[]);
        for (let invocation = 1; invocation <= 2; invocation++) {
            orderedTrace.length = 0;
            assert.equal(ordered.prepare("outer-target","work"),undefined);
            assert.deepEqual(orderedTrace,[["resolve","work"],["probeDirectory",undefined],"identity","parent","host-uid","config","mapped-uid",
                ["repairDirectory",String(invocation)],["verifyDirectory",undefined],["probeConfig",undefined],"identity","parent","host-uid","config",
                ["repairConfig",String(invocation)],["verifyConfig",undefined]]);
        }
        const blockedTrace = [];
        const blockedPorts = { ...orderedPorts,
            resolveConfig(profile) { assert.equal(this,blockedPorts); assert.equal(profile,"work"); return "resolved-config"; },
            probeDirectory: () => ({ status: 1 }), hasHostIdentity: () => false,
            mappedContainerUid: () => { blockedTrace.push("uid"); throw new Error("forbidden uid"); },
            repairDirectory: () => { blockedTrace.push("repair"); throw new Error("forbidden root repair"); } };
        const blocked = createOrderedCodexConfigPreparation(blockedPorts);
        assert.throws(() => blocked.prepare("outer-target","work"),/host user identity is unavailable/);
        assert.deepEqual(blockedTrace,[]);
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
    const credentialTrace = [];
    const credentialWarnings = [];
    let credentialStatuses = { ssh: 0, copy: 0, install: 0 };
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
            const path = fakePath(selected);
            if (path === hostPath.join(home, ".gitconfig")) return true;
            if (path === hostPath.join(home, ".ssh")) return false;
            return false;
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
            credentialTrace.push("ssh");
            return result(credentialStatuses.ssh);
        }
        if (args[0] === "exec" && args[1] === "--user" && args[2] === "root") {
            assert.deepEqual(args, ["exec", "--user", "root", id, "sh", "-c",
                "set -e; cp /tmp/ccc-host-gitconfig /home/ccc/.gitconfig; "
                + "git config --file /home/ccc/.gitconfig --add safe.directory '*'; "
                + docker.gitSigningKeyRewriteShell()
                + "; chown ccc:ccc /home/ccc/.gitconfig; rm -f /tmp/ccc-host-gitconfig",
                "ccc-signing-key-rewrite", "/home/ccc/.gitconfig",
                hostPath.join(home, ".ssh").replace(/\\/g, "/").replace(/\/+$/, ""), "/tmp/.ssh-copy"]);
            assert.deepEqual(options, { stdio: "ignore" });
            credentialTrace.push("git-install");
            return result(credentialStatuses.install);
        }
        if (args[0] === "exec") {
            assert.equal(args[1], id);
            assert.ok(["sha256sum"].includes(args[2]), "unknown helper execution must fail closed");
            return result();
        }
        if (args[0] === "cp") {
            if (args[1] === hostPath.join(home, ".gitconfig")) {
                assert.deepEqual(args, ["cp", hostPath.join(home, ".gitconfig"), `${id}:/tmp/ccc-host-gitconfig`]);
                assert.deepEqual(options, { stdio: "ignore" });
                credentialTrace.push("git-copy");
                return result(credentialStatuses.copy);
            }
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
    console.log = console.warn = () => {};
    console.error = function (...args) {
        assert.equal(this, console);
        if (String(args[0]).includes("SSH credentials") || String(args[0]).includes("host .gitconfig")) credentialWarnings.push(args[0]);
    };
    delete process.env.DEBUG; delete process.env.SSH_AUTH_SOCK;
    syncBuiltinESMExports();
    runtime._setRuntimeInfoForTest({ runtime: "docker", flavor: "docker-native", remote: false, dockerDesktop: false });
    // Build the exact native run contract once using this same compiled public API.
    docker.startProjectContainer(project, () => {});
    assert.deepEqual(credentialTrace, ["ssh", "git-copy", "git-install"], "fresh verified creation routes through both private refresh wrappers");
    existing = true;
    const success = ["allocate:4", "now:0", "now:0", `probe:${id}:5000`, "now:10", "sleep:75", "now:85", `probe:${id}:5000`, "now:95", "sleep:75", "now:170", `probe:${id}:5000`];
    for (const scenario of [
        { available: true, ssh: 0, copy: 0, install: 0, expected: ["ssh", "git-copy", "git-install"], warnings: [] },
        { available: true, ssh: 1, copy: 0, install: 0, expected: ["ssh", "git-copy", "git-install"], warnings: [] },
        { available: true, ssh: 0, copy: 1, install: 0, expected: ["ssh", "git-copy"], warnings: ["[ccc] WARNING: failed to copy host .gitconfig into container"] },
        { available: true, ssh: 0, copy: 0, install: 1, expected: ["ssh", "git-copy", "git-install"], warnings: ["[ccc] WARNING: failed to install host .gitconfig inside container"] },
        { available: false, ssh: 0, copy: 0, install: 0, expected: [], warnings: [] },
    ]) {
        const { available } = scenario;
        credentialStatuses = scenario;
        credentialTrace.length = 0; credentialWarnings.length = 0;
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
        assert.deepEqual(credentialTrace, scenario.expected);
        assert.deepEqual(credentialWarnings, scenario.warnings);
    }
}

async function verifySessionShutdownAuthorization(applicationUrl) {
    const assert = (await import("node:assert/strict")).default;
    const childProcess = await import("node:child_process");
    const net = await import("node:net");
    let unexpectedEffects = 0;
    const deny = () => { unexpectedEffects++; throw new Error("unexpected compiled guardian native/network effect"); };
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess.default[name] = deny;
    for (const name of ["connect", "createConnection"]) net.default[name] = deny;
    net.default.Socket.prototype.connect = deny;
    (await import("node:tls")).default.connect = deny;
    for (const protocol of ["node:http", "node:https"]) {
        const native = (await import(protocol)).default;
        native.request = native.get = deny;
    }
    globalThis.fetch = deny;
    (await import("node:module")).syncBuiltinESMExports();
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
    for (const rejects of [false, true]) {
        const trace = [];
        let settle;
        const failure = new Error("owned pending cleanup rejection");
        const pending = new Promise((resolve, reject) => { settle = () => rejects ? reject(failure) : resolve(); });
        const guardian = createSessionOwnershipGuardian({
            validate: () => {}, send: async () => {},
            rollback: () => { throw new Error("authorized captured-ID cleanup must not roll back"); },
            cleanup: (b, r, selected, runtime) => {
                assert.deepEqual(b, binding); assert.deepEqual(r, receipt);
                assert.equal(selected, id); assert.equal(runtime, "podman");
                trace.push("cleanup"); return pending;
            },
            finish: status => { trace.push(["finish", status]); },
        });
        await guardian.receive({ type: "init", binding, receipt });
        await guardian.receive({ type: "update", sequence: 1, containerId: id, runtime: "podman", cleanupEnabled: true });
        const disconnected = guardian.disconnect();
        // Attach rejection observation before releasing the controlled cleanup.
        const outcome = rejects ? assert.rejects(disconnected, error => error === failure) : disconnected;
        const duplicate = guardian.disconnect();
        const lateFrame = guardian.receive({ type: "release", sequence: 2 });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(trace, ["cleanup"], "compiled guardian must await cleanup before finishing");
        settle();
        await outcome;
        await duplicate;
        await lateFrame;
        await guardian.disconnect();
        assert.deepEqual(trace, ["cleanup", ["finish", rejects ? 1 : 0]], "duplicate terminal events must have no effect");
    }
    assert.equal(unexpectedEffects, 0, "compiled guardian proof must not attempt native/network effects");
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
    const { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
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
        const beforeRemoval = ["repo-a", "repo-b"].map(name => {
            const repository = join(multiRoot, name);
            return { head: git(["rev-parse", "HEAD"], repository), refs: git(["show-ref"], repository),
                config: readFileSync(join(repository, ".git", "config"), "utf8"),
                contents: readFileSync(join(repository, "owned.txt"), "utf8") };
        });
        assert.deepEqual(facade.removeWorkspace(multiRoot, "multi-topic"), { removed: ["plain.txt", "repo-a", "repo-b"], errors: [] });
        assert.equal(existsSync(multi.workspacePath), false);
        for (const [index, name] of ["repo-a", "repo-b"].entries()) {
            const repository = join(multiRoot, name);
            assert.deepEqual({ head: git(["rev-parse", "HEAD"], repository), refs: git(["show-ref"], repository),
                config: readFileSync(join(repository, ".git", "config"), "utf8"),
                contents: readFileSync(join(repository, "owned.txt"), "utf8") }, beforeRemoval[index]);
            assert.equal(git(["worktree", "list", "--porcelain"], repository).includes(multi.workspacePath), false);
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
}

async function verifyHomeMigrationDelivery(applicationUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const fs = await import("node:fs"), path = await import("node:path");
    const { createHomeLayoutMigration } = await import(applicationUrl);
    const facade = await import(facadeUrl);
    const legacy = new Set(["claude", "codex"]), reported = new Set(), trace = [], receipts = [];
    const config = { remote: { one: "existing", keep: true } };
    const ports = {
        homeExists: () => true, readReportedConflicts: () => reported,
        defaultProfileExists: () => false, defaultProfileMarkerExists: () => false,
        profileNameExists: () => false, legacyEntryExists: entry => legacy.has(entry), targetEntryExists: () => false,
        startupSlotExists: slot => { trace.push(`preflight:${slot.namespace}/${slot.name}`); return false; },
        clipboardPortIsRegular: () => true,
        listLegacyRemoteNames: () => ["one.json", "two.json", "bad.json", "ignored.txt"],
        legacyRemoteDirectoryIsEmpty: () => false, remoteEntryKey: name => `remote/${name}`,
        readLegacyRemoteText: name => ({ "one.json": "1", "two.json": "[1,2]", "bad.json": "{" })[name],
        acquireMigrationLock: now => { assert.equal(now, 42); trace.push("claim"); return true; },
        releaseMigrationLock: () => { trace.push("release-migration"); },
        ensureRuntimeDirectory: () => { trace.push("mkdir"); },
        claimStartupSlot: () => { const receipt = receipts.length === 0 ? 0 : Symbol("receipt"); receipts.push(receipt); return receipt; },
        releaseStartupReceipt: receipt => { assert.equal(receipt, receipts[trace.filter(item => item === "release-startup").length]); trace.push("release-startup"); },
        renameDefaultProfile: () => assert.fail("no reserved profile"), ensureDefaultProfileDirectory: () => { trace.push("profile"); },
        moveEntry: entry => { legacy.delete(entry); trace.push(`move:${entry}`); },
        updateConfig: mutate => { assert.equal(mutate(config), undefined); trace.push("publish"); },
        removeLegacyRemoteFile: name => { assert.equal(trace.includes("publish"), true); trace.push(`unlink:${name}`); },
        removeEmptyLegacyRemoteDirectory: () => {}, recordReportedConflicts: value => { assert.equal(value, reported); trace.push("conflicts"); },
        hasLiveSessions: () => false, hasContainerMounts: () => false, currentTime: () => 42,
        report: notice => { assert.equal(notice.kind, "invalid-remote"); assert.equal(notice.name, "bad.json"); },
    };
    const migrate = createHomeLayoutMigration(ports);
    assert.deepEqual(trace, []);
    assert.deepEqual(migrate(), { status: "migrated", moved: ["claude", "codex", "remote/one.json", "remote/two.json"], failed: [] });
    assert.deepEqual(config.remote, { one: "existing", keep: true, two: [1, 2] });
    assert.deepEqual([...reported], ["remote/bad.json"]);
    assert.deepEqual(trace.slice(-6), ["release-startup", "release-startup", "release-startup", "release-startup", "conflicts", "release-migration"]);
    assert.equal(receipts[0], 0);
    const fixture = fs.mkdtempSync(path.join(process.cwd(), "home-migration-"));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CCC_HOME: process.env.CCC_HOME };
    try {
        const fixtureHome = path.join(fixture, ".ccc"); fs.mkdirSync(fixtureHome);
        process.env.HOME = fixture; process.env.USERPROFILE = fixture; process.env.CCC_HOME = fixtureHome;
        for (const name of ["claude", "codex", "remote"]) fs.mkdirSync(path.join(fixtureHome, name));
        const credentials = "fixture credential bytes\n", token = "fixture clipboard token\n";
        fs.writeFileSync(path.join(fixtureHome, "codex", "auth.json"), credentials);
        fs.writeFileSync(path.join(fixtureHome, "clipboard.port"), token);
        fs.writeFileSync(path.join(fixtureHome, "remote", "one.json"), "1");
        fs.writeFileSync(path.join(fixtureHome, "remote", "two.json"), "true");
        fs.writeFileSync(path.join(fixtureHome, "remote", "bad.json"), "{");
        fs.writeFileSync(path.join(fixtureHome, "config.json"), JSON.stringify({ remote: { one: "existing" } }));
        const before = fs.lstatSync(path.join(fixtureHome, "clipboard.port"));
        const warnings = [], options = { hasLiveSessions: () => false, hasContainerMounts: () => false,
            warn: message => warnings.push(message), retireLegacyClipboard: () => assert.fail("deprecated callback") };
        const result = facade.migrateHomeLayout(options);
        assert.equal(result.status, "migrated"); assert.deepEqual(result.failed, []);
        assert.equal(fs.readFileSync(path.join(fixtureHome, "profiles/default/codex/auth.json"), "utf8"), credentials);
        assert.equal(fs.readFileSync(path.join(fixtureHome, "run/clipboard.port"), "utf8"), token);
        const after = fs.lstatSync(path.join(fixtureHome, "run/clipboard.port"));
        assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixtureHome, "config.json"), "utf8")).remote, { one: "existing", two: true });
        assert.equal(fs.existsSync(path.join(fixtureHome, "remote/bad.json")), true);
        assert.equal(warnings.length, 1); assert.match(warnings[0], /not valid JSON/);
        assert.deepEqual(facade.migrateHomeLayout(options), { status: "not-needed" });
    } finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        fs.rmSync(fixture, { recursive: true, force: true });
    }
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
    const workspace = { opaque: "workspace" };
    let copied = { opaque: "copied" }, symbolProofs = false;
    const prepared = new Map(), registrations = new Map(), trace = [];
    const copyFailure = new Error("owned copy fixture failure");
    let mode = "success";
    const create = createMultiWorkspaceCreation({
        observeBranch: () => "none",
        prepareAddition: child => { const token = { opaque: child.repositoryPath }; prepared.set(child.repositoryPath, token); return token; },
        addPrepared: child => {
            const token = symbolProofs ? Symbol(child.repositoryPath) : { opaque: child.repositoryPath }; registrations.set(child.repositoryPath, token);
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
    trace.length = 0; symbolProofs = true; copied = Symbol("copied identity");
    assert.throws(() => create(request), error => error === copyFailure);
    assert.deepEqual(trace, ["remove:source/two", "branch:source/two", "remove:source/one", "branch:source/one", "copy:workspace/plain-a", "root"]);
    assert.throws(() => createMultiWorkspaceCreation({}), TypeError);
}

async function verifyMultiRemovalDelivery(applicationUrl) {
    const assert = (await import("node:assert/strict")).default;
    const { createMultiWorkspaceRemoval } = await import(applicationUrl);
    const request = { repositoryPath: "source", destinationPath: "workspace", branch: "topic", options: undefined };
    const workspace = Symbol("workspace"), identity = Symbol("entry"), registration = Symbol("registration");
    const entries = [{ name: "repo", path: "source/repo", isGitRepo: true }, { name: "copy", path: "source/copy", isGitRepo: false }];
    const paths = new Set(["workspace", "workspace/repo", "workspace/copy"]), trace = [];
    let failRepository = false;
    const ports = {
        scanSource: actual => { assert.equal(actual, request); return entries; },
        destinationPath: (_actual, name) => `workspace/${name}`,
        pathExists: path => paths.has(path),
        assertWorkspaceIdentity: (actual, proof) => { assert.equal(actual, request); assert.equal(proof, workspace); trace.push("assert"); },
        worktreeMatches: () => true,
        unmanagedPathRefusal: () => assert.fail("owned worktree"),
        captureWorktreeIdentity: () => identity,
        captureRegistration: (actual, source, destination, proof) => { assert.equal(actual, request); assert.equal(source, "source/repo"); assert.equal(destination, "workspace/repo"); assert.equal(proof, identity); trace.push("registration"); return registration; },
        removeRegisteredEntry: (actual, _source, destination, proof, receipt, force) => { assert.equal(actual, request); assert.equal(proof, identity); assert.equal(receipt, registration); assert.equal(force, false); if (failRepository) throw new Error("refused"); paths.delete(destination); trace.push("repo"); },
        scanWorkspace: () => [],
        captureCopiedIdentity: () => identity,
        quarantineCopiedEntry: (actual, destination, proof) => { assert.equal(actual, request); assert.equal(proof, identity); paths.delete(destination); trace.push("copy"); },
        remainingNames: () => [],
        quarantineWorkspace: (actual, proof) => { assert.equal(actual, request); assert.equal(proof, workspace); trace.push("root"); },
        relayEntryError: (name, _destination, error) => `${name}:${error.message}`,
    };
    const remove = createMultiWorkspaceRemoval(ports);
    assert.deepEqual(trace, []);
    assert.deepEqual(remove(request, workspace), { removed: ["repo", "copy"], errors: [] });
    assert.deepEqual(trace, ["assert", "registration", "repo", "assert", "copy", "assert", "root"]);
    paths.add("workspace/repo"); paths.add("workspace/copy"); trace.length = 0; failRepository = true;
    assert.deepEqual(remove(request, workspace), { removed: ["copy"], errors: ["repo:refused"] });
    assert.equal(paths.has("workspace/repo"), true); assert.equal(trace.at(-1), "assert"); assert.equal(trace.includes("root"), false);
    const forceRequest = { ...request, options: { force: true } };
    const force = createMultiWorkspaceRemoval({ ...ports, scanSource: () => [], assertWorkspaceIdentity: () => {},
        remainingNames: () => ["foreign"], scanWorkspace: () => [{ name: "foreign", path: "workspace/foreign", isGitRepo: true }],
        quarantineWorkspace: () => assert.fail("foreign repository must survive") });
    assert.deepEqual(force(forceRequest, workspace), { removed: [], errors: ["Workspace ownership changed before deletion (foreign)."] });
}

async function verifyUnifiedRemovalDelivery(applicationUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const fs = await import("node:fs"), path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { createUnifiedWorkspaceRemoval } = await import(applicationUrl);
    const request = { repositoryPath: "source", destinationPath: "workspace", branch: "topic", options: undefined };
    const identity = Symbol("directory"), receipt = Symbol("registration"), quarantine = Symbol("quarantine");
    let dirty = false, force = false;
    const trace = [];
    const clean = { kind: "observed", readContent: () => "" };
    const ports = {
        scanSource: actual => { assert.equal(actual, request); return []; },
        destinationPath: () => assert.fail("no nested entries"), pathExists: () => true,
        captureSourceIdentity: () => assert.fail("no nested source"), captureDestinationFence: () => assert.fail("no nested fence"),
        assertWorkspaceIdentity: (actual, proof) => { assert.equal(actual, request); assert.equal(proof, identity); },
        assertSourceIdentity: () => assert.fail("no nested source"), assertDestinationFence: () => assert.fail("no nested fence"),
        metadataExists: () => false, metadataKind: () => "worktree", unreachableRecordedPath: () => null,
        isTrackedGitlink: () => false, inspectNestedStatus: () => clean, worktreeMatches: () => true,
        pathContent: () => "empty", unmanagedPathRefusal: () => "unmanaged", unreadablePathRefusal: () => "unreadable",
        captureDirectoryIdentity: () => identity,
        captureRegistration: (actual, source, destination, proof) => {
            assert.equal(actual, request); assert.equal(source, "source"); assert.equal(destination, "workspace");
            assert.equal(proof, identity); trace.push("registration"); return receipt;
        },
        removeRegisteredNested: () => assert.fail("no nested removal"), relayEntryError: () => assert.fail("no entry error"),
        assertRootOwnership: () => {}, inspectRootBranch: () => ({ failed: false, observedBranch: "topic" }),
        inspectRootStatus: (_actual, entries, target, mode) => {
            assert.deepEqual(entries, []); trace.push(`${target.kind}:${mode}`);
            if (target.kind === "quarantined") {
                assert.equal(target.root, quarantine);
                return { kind: "observed", readContent: () => dirty ? "changed" : "" };
            }
            return clean;
        },
        workspaceName: () => "workspace", sourceName: () => "source",
        removeRegisteredRoot: (actual, proof, registration, veto) => {
            assert.equal(actual, request); assert.equal(proof, identity); assert.equal(registration, receipt);
            assert.equal(veto === undefined, force); trace.push("root"); veto?.(quarantine);
        },
    };
    const remove = createUnifiedWorkspaceRemoval(ports);
    assert.deepEqual(trace, []);
    assert.deepEqual(remove(request, identity), { removed: ["source"], errors: [] });
    assert.deepEqual(trace.slice(-4), ["registration", "root", "quarantined:ordinary", "quarantined:ignored"]);
    dirty = true;
    assert.deepEqual(remove(request, identity), { removed: [], errors: ["root worktree changed during removal, use --force to delete it"] });
    force = true; request.options = { force: true }; trace.length = 0;
    assert.deepEqual(remove(request, identity), { removed: ["source"], errors: [] });
    assert.equal(trace.some(value => value.startsWith("quarantined:")), false);
    assert.throws(() => createUnifiedWorkspaceRemoval({}), TypeError);

    const facade = await import(facadeUrl);
    const fixture = fs.mkdtempSync(path.join(process.cwd(), "unified-removal-"));
    const git = (cwd, ...args) => {
        const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10000, windowsHide: true });
        assert.equal(result.status, 0, String(result.error || result.stderr)); return result.stdout;
    };
    try {
        const source = path.join(fixture, "source"), nested = path.join(source, "nested");
        fs.mkdirSync(nested, { recursive: true });
        for (const directory of [source, nested]) {
            git(directory, "init"); git(directory, "config", "user.name", "Fixture");
            git(directory, "config", "user.email", "fixture@example.invalid");
            git(directory, "config", "commit.gpgsign", "false");
            fs.writeFileSync(path.join(directory, "tracked.txt"), "preserved source bytes\n");
            git(directory, "add", "."); git(directory, "commit", "-m", "fixture");
        }
        const created = facade.createWorkspace(source, "topic");
        const snapshots = [source, nested].map(directory => ({
            refs: git(directory, "show-ref"), head: git(directory, "rev-parse", "HEAD"),
            config: fs.readFileSync(path.join(directory, ".git/config")),
            bytes: fs.readFileSync(path.join(directory, "tracked.txt")),
        }));
        const result = facade.removeWorkspace(source, "topic");
        assert.deepEqual(result, { removed: ["nested", "source"], errors: [] });
        assert.equal(fs.existsSync(created.workspacePath), false);
        for (const [index, directory] of [source, nested].entries()) {
            assert.equal(git(directory, "show-ref"), snapshots[index].refs);
            assert.equal(git(directory, "rev-parse", "HEAD"), snapshots[index].head);
            assert.deepEqual(fs.readFileSync(path.join(directory, ".git/config")), snapshots[index].config);
            assert.deepEqual(fs.readFileSync(path.join(directory, "tracked.txt")), snapshots[index].bytes);
            assert.equal(git(directory, "worktree", "list", "--porcelain").includes(created.workspacePath), false);
        }
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}

async function verifyVersionFileScanningDelivery(domainUrl, applicationUrl, presentationUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const fs = await import("node:fs"), path = await import("node:path");
    const { syncBuiltinESMExports } = await import("node:module");
    const domain = await import(domainUrl), application = await import(applicationUrl);
    const presentation = await import(presentationUrl), facade = await import(facadeUrl);
    const entry = (name, directory) => ({ name, isDirectory() { assert.equal(this.name, name); return directory; }, isFile() { assert.equal(this.name, name); return !directory; } });
    const reads = [], ignored = new Set();
    const scan = application.createVersionFileScanner({
        listDirectoryEntries: directory => directory === "base" ? [entry("sub", true), entry(".node-version", false)] : [entry("go.mod", false)],
        observeFileByteSize: () => 3,
        readVersionFileText: file => { reads.push(file); return file.endsWith("go.mod") ? "go 1.23" : "22"; },
        childPath: (directory, name) => `${directory}/${name}`,
        sourcePath: (base, file) => file.slice(base.length + 1),
    }, ignored);
    assert.deepEqual(reads, []);
    const request = { baseDirectory: "base", directory: "base", depth: 0, maxDepth: 3 };
    assert.deepEqual([...scan(request)], [["sub/go.mod", "go 1.23"], [".node-version", "22"]]);
    ignored.add("sub"); reads.length = 0;
    assert.deepEqual([...scan(request)], [[".node-version", "22"]]);
    assert.deepEqual(reads, ["base/.node-version"]);
    assert.throws(() => application.createVersionFileScanner({}, new Set()), TypeError);
    assert.deepEqual(domain.extractVersionHints(new Map([[".node-version", "v22\r\n"], ["package.json", '{"engines":{"node":">=24"}}']])),
        [{ tool: "node", version: "22", source: ".node-version" }]);
    assert.deepEqual(domain.extractVersionHints(new Map([["sub\\.node-version", "22"]])), []);
    const sdk = { fixture: true };
    assert.deepEqual(domain.extractVersionHints(new Map([["global.json", JSON.stringify({ sdk: { version: sdk } })]])),
        [{ tool: "dotnet", version: sdk, source: "global.json" }]);
    const content = "x".repeat(2001);
    assert.equal(presentation.formatScannedFiles(new Map([["one", content]])),
        `Detected version files:\n\n=== one ===\n${"x".repeat(2000)}\n... (truncated, use Read tool for full content)\n\n`);
    assert.equal(presentation.formatVersionHints([{ tool: "node", version: "22", source: ".node-version" }]),
        'Pre-extracted versions:\n  node = "22" (from .node-version)\n\n');
    assert.equal(facade.scanVersionFiles.length, 1);
    const fixture = fs.mkdtempSync(path.join(process.cwd(), "version-scanning-"));
    const originalRead = fs.default.readFileSync;
    try {
        fs.mkdirSync(path.join(fixture, "nested"));
        fs.mkdirSync(path.join(fixture, "node_modules"));
        fs.mkdirSync(path.join(fixture, ".hidden"));
        fs.writeFileSync(path.join(fixture, ".node-version"), "22\n");
        fs.writeFileSync(path.join(fixture, "nested/go.mod"), "module fixture\ngo 1.23\n");
        fs.writeFileSync(path.join(fixture, "node_modules/package.json"), "{}");
        fs.writeFileSync(path.join(fixture, ".hidden/package.json"), "{}");
        fs.writeFileSync(path.join(fixture, "Cargo.toml"), "é".repeat(51200));
        fs.writeFileSync(path.join(fixture, "package.json"), "é".repeat(51200) + "x");
        const native = facade.scanVersionFiles(fixture);
        assert.equal(native.get(".node-version"), "22\n");
        assert.equal(native.get(path.join("nested", "go.mod")), "module fixture\ngo 1.23\n");
        assert.equal(native.get("Cargo.toml"), "é".repeat(51200));
        assert.equal(native.has("package.json"), false);
        assert.equal(native.size, 3);
        assert.equal(facade.scanVersionFiles(fixture, fixture, 0, 0).has(path.join("nested", "go.mod")), false);
        assert.deepEqual([...facade.scanVersionFiles(path.join(fixture, "missing"))], []);
        const failedPath = path.join(fixture, ".node-version");
        let injected = 0;
        fs.default.readFileSync = function (...args) {
            if (args[0] === failedPath) { injected++; throw new Error("private fixture read failure"); }
            return originalRead.apply(this, args);
        };
        syncBuiltinESMExports();
        const partial = facade.scanVersionFiles(fixture);
        assert.equal(injected, 1, "actual compiled facade reached the single named native read fault");
        assert.equal(partial.has(".node-version"), false);
        assert.equal(partial.get(path.join("nested", "go.mod")), "module fixture\ngo 1.23\n");
        assert.equal(partial.get("Cargo.toml"), native.get("Cargo.toml"));
        assert.equal(partial.size, 2);
    } finally {
        fs.default.readFileSync = originalRead; syncBuiltinESMExports();
        fs.rmSync(fixture, { recursive: true, force: true });
    }
}

async function verifyHostCredentialRefreshDelivery(applicationUrl, adapterUrl, materialUrl, facadeUrl, pythonUrl, baseline) {
    const assert = (await import("node:assert/strict")).default;
    const cp = (await import("node:child_process")).default;
    const fs = (await import("node:fs")).default, os = (await import("node:os")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const { createHash } = await import("node:crypto");
    const path = await import("node:path");
    const { createHostCredentialRefresh } = await import(applicationUrl);
    const { createNativeHostCredentialRefreshPorts } = await import(adapterUrl);
    const material = await import(materialUrl), facade = await import(facadeUrl), python = await import(pythonUrl);
    const hash = value => createHash("sha256").update(value).digest("hex");
    for (const actual of [material, facade]) {
        assert.equal(hash(actual.sshCredentialCopyShell()), baseline.hashes.sshDefault);
        assert.equal(hash(actual.sshCredentialCopyShell(false)), baseline.hashes.sshFalse);
        assert.equal(hash(actual.sshCredentialCopyShell(true)), baseline.hashes.sshTrue);
        assert.equal(hash(actual.gitSigningKeyRewriteShell()), baseline.hashes.signing);
        assert.equal(actual.sshCredentialCopyShell.name, baseline.names.ssh); assert.equal(actual.sshCredentialCopyShell.length, baseline.arities.ssh);
        assert.equal(actual.gitSigningKeyRewriteShell.name, baseline.names.signing); assert.equal(actual.gitSigningKeyRewriteShell.length, baseline.arities.signing);
    }
    assert.equal(facade.sshCredentialCopyShell, material.sshCredentialCopyShell);
    assert.equal(facade.gitSigningKeyRewriteShell, material.gitSigningKeyRewriteShell);
    assert.equal(hash(python.SSH_KNOWN_HOSTS_PROVENANCE_SCRIPT), baseline.hashes.python);
    assert.throws(() => createHostCredentialRefresh({}), TypeError);
    const original = { spawnSync: cp.spawnSync, existsSync: fs.existsSync, homedir: os.homedir, error: console.error };
    const target = "a".repeat(64), trace = [];
    let mode = "success", selected = "docker", expectedCommand, homes = 0;
    const home = path.resolve(process.cwd(), "synthetic-credential-home");
    const observe = status => ({ get status() { trace.push(`status:${status}`); return status; },
        get error() { assert.fail("native error must remain unread"); }, get stdout() { assert.fail("stdout must remain unread"); }, get stderr() { assert.fail("stderr must remain unread"); } });
    try {
        os.homedir = () => { homes++; trace.push("home"); return home; };
        fs.existsSync = selectedPath => {
            assert.ok([path.join(home, ".ssh"), path.join(home, ".gitconfig")].includes(selectedPath));
            trace.push(selectedPath.endsWith(".gitconfig") ? "git-exists" : "ssh-exists");
            return mode !== "absent";
        };
        console.error = function (message) { assert.equal(this, console); trace.push(message); };
        cp.spawnSync = (command, args, options) => {
            assert.equal(command, expectedCommand); assert.deepEqual(options, { stdio: "ignore" });
            if (args[0] === "cp") {
                assert.deepEqual(args, ["cp", path.join(home, ".gitconfig"), `${target}:/tmp/ccc-host-gitconfig`]);
                trace.push("copy"); selected = "changed-after-capture";
                return observe(mode === "copy-fail" ? 1 : 0);
            }
            if (args[1] === "--user") {
                assert.deepEqual(args.slice(0, 6), ["exec", "--user", "root", target, "sh", "-c"]);
                assert.ok(args[6].includes(material.gitSigningKeyRewriteShell()));
                assert.deepEqual(args.slice(7), ["ccc-signing-key-rewrite", "/home/ccc/.gitconfig",
                    path.join(home, ".ssh").replace(/\\/g, "/").replace(/\/+$/, ""), "/tmp/.ssh-copy"]);
                trace.push("install"); return observe(mode === "install-fail" ? null : 0);
            }
            assert.deepEqual(args, ["exec", target, "sh", "-c", material.sshCredentialCopyShell(true),
                "ccc-ssh-copy", "/home/ccc/.ssh", "/tmp/.ssh-copy"]);
            trace.push("ssh"); return observe(mode === "success" ? 0 : undefined);
        };
        syncBuiltinESMExports();
        for (const cli of ["docker", "podman"]) {
            trace.length = 0; homes = 0; mode = "success"; selected = cli;
            const ports = createNativeHostCredentialRefreshPorts(() => { trace.push("runtime"); expectedCommand = selected; return selected; });
            assert.deepEqual(trace, []);
            const app = createHostCredentialRefresh(ports);
            assert.equal(app.refreshSsh(target), undefined);
            assert.deepEqual(trace, ["home", "runtime", "ssh", "status:0"]);
            trace.length = 0; homes = 0;
            app.syncGit(target);
            assert.deepEqual(trace, ["home", "git-exists", "runtime", "home", "copy", "status:0", "install", "status:0"]); assert.equal(homes, 2);
        }
        for (const scenario of ["absent", "copy-fail", "install-fail"]) {
            mode = scenario; selected = "docker"; trace.length = 0;
            const app = createHostCredentialRefresh(createNativeHostCredentialRefreshPorts(() => { trace.push("runtime"); expectedCommand = selected; return selected; }));
            if (mode === "install-fail") {
                app.syncGit(target);
                assert.equal(trace.at(-1), "[ccc] WARNING: failed to install host .gitconfig inside container");
            } else {
                app.syncGit(target);
                if (mode === "absent") assert.deepEqual(trace, ["home", "git-exists"]);
                else { assert.equal(trace.includes("install"), false); assert.equal(trace.at(-1), "[ccc] WARNING: failed to copy host .gitconfig into container"); }
            }
        }
        for (const scenario of ["absent", "ssh-fail-present"]) {
            mode = scenario; selected = "docker"; trace.length = 0;
            const app = createHostCredentialRefresh(createNativeHostCredentialRefreshPorts(() => { trace.push("runtime"); expectedCommand = selected; return selected; }));
            app.refreshSsh(target);
            assert.deepEqual(trace.slice(0, 5), ["home", "runtime", "ssh", "status:undefined", "ssh-exists"]);
            if (scenario === "absent") assert.equal(trace.length, 5);
            else assert.equal(trace.at(-1), "[ccc] WARNING: failed to refresh copied SSH credentials inside container");
        }
    } finally {
        cp.spawnSync = original.spawnSync; fs.existsSync = original.existsSync; os.homedir = original.homedir; console.error = original.error; syncBuiltinESMExports();
    }
}

async function verifyHostCredentialPathsDelivery(applicationUrl, facadeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const fs = await import("node:fs"), os = (await import("node:os")).default;
    const path = await import("node:path");
    const { syncBuiltinESMExports } = await import("node:module");
    const { createHostCredentialPaths } = await import(applicationUrl);
    const trace = [];
    let container = "docker", vitest;
    const ports = {
        readContainerEnvironment: () => { trace.push("container"); return container; },
        readVitestEnvironment: () => { trace.push("vitest"); return vitest; },
        claudeProfilePath: profile => { trace.push(["claude", profile]); return "claude-host"; },
        codexProfilePath: profile => { trace.push(["codex", profile]); return "codex-host"; },
        homeDirectory: () => { trace.push("home"); return "home"; },
        joinHostPath: (base, relative) => { trace.push(["join", base, relative]); return `${base}/${relative}`; },
        createDirectory: (selected, options) => { trace.push(["mkdir", selected, options]); return undefined; },
        packageParentPath: selected => { trace.push(["parent", selected]); return "/home/ccc/.codex"; },
        packageBasename: selected => { trace.push(["basename", selected]); return "packages"; },
    };
    const app = createHostCredentialPaths(ports, "/home/ccc/.codex/packages");
    assert.deepEqual(trace, []);
    const mount = { hostDir: ".codex", containerDir: "/home/ccc/.codex" };
    assert.equal(app.resolveCredentialHostPath(mount), mount.containerDir);
    assert.deepEqual(trace, ["container", "vitest"]);
    container = undefined; trace.length = 0;
    assert.equal(app.ensureCredentialHostDir(mount, "work"), "codex-host");
    assert.deepEqual(trace, [["codex", "work"], ["mkdir", "codex-host", { recursive: true, mode: 448 }],
        ["parent", "/home/ccc/.codex/packages"], ["basename", "/home/ccc/.codex/packages"],
        ["join", "codex-host", "packages"], ["mkdir", "codex-host/packages", { recursive: true, mode: 448 }]]);
    const failure = Symbol("second-directory");
    let made = 0;
    const partial = createHostCredentialPaths({ ...ports, createDirectory: () => { if (++made === 2) throw failure; } }, "/home/ccc/.codex/packages");
    assert.throws(() => partial.ensureCredentialHostDir(mount, "work"), value => value === failure);
    assert.equal(made, 2);
    assert.throws(() => createHostCredentialPaths({}, "packages"), TypeError);

    const fixture = fs.mkdtempSync(path.join(process.cwd(), "credential-paths-"));
    const saved = { home: os.homedir, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
        container: process.env.container, VITEST: process.env.VITEST, VITEST_ONLY_FIXTURE: process.env.VITEST_ONLY_FIXTURE };
    try {
        os.homedir = () => fixture; process.env.HOME = fixture; process.env.USERPROFILE = fixture;
        delete process.env.container; delete process.env.VITEST; delete process.env.VITEST_ONLY_FIXTURE;
        syncBuiltinESMExports();
        const facade = await import(facadeUrl);
        assert.equal(facade.resolveCredentialHostPath.length, 2); assert.equal(facade.ensureCredentialHostDir.length, 2);
        assert.equal(facade.resolveCredentialHostPath.name, "resolveCredentialHostPath");
        assert.equal(facade.ensureCredentialHostDir.name, "ensureCredentialHostDir");
        const selected = facade.ensureCredentialHostDir(mount, "work");
        assert.equal(selected, path.join(fixture, ".ccc/profiles/work/codex"));
        assert.equal(fs.statSync(selected).isDirectory(), true);
        assert.equal(fs.statSync(path.join(selected, "packages")).isDirectory(), true);
        if (process.platform !== "win32") {
            assert.equal(fs.statSync(selected).mode & 511, 448); assert.equal(fs.statSync(path.join(selected, "packages")).mode & 511, 448);
            fs.chmodSync(selected, 493); facade.ensureCredentialHostDir(mount, "work");
            assert.equal(fs.statSync(selected).mode & 511, 493, "existing permissions are not reset");
        }
        process.env.container = "docker";
        assert.equal(facade.resolveCredentialHostPath(mount), "/home/ccc/.codex");
        process.env.VITEST = "";
        assert.equal(facade.resolveCredentialHostPath(mount), "/home/ccc/.codex", "resolver checks exact VITEST truthiness");
        assert.equal(facade.resolveCredentialHostPath(mount, "work"), selected, "helper sees the empty VITEST key");
        delete process.env.VITEST;
        assert.equal(facade.resolveCredentialHostPath(mount, "work"), path.join(fixture, ".codex"), "Codex helper mounted branch precedes named profile using live home");
        process.env.VITEST_ONLY_FIXTURE = "1";
        assert.equal(facade.resolveCredentialHostPath(mount), "/home/ccc/.codex", "resolver does not enumerate VITEST_* keys");
        assert.equal(facade.resolveCredentialHostPath(mount, "work"), selected, "helper does enumerate VITEST_* keys");
    } finally {
        os.homedir = saved.home;
        for (const key of ["HOME", "USERPROFILE", "container", "VITEST", "VITEST_ONLY_FIXTURE"]) {
            if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
        syncBuiltinESMExports(); fs.rmSync(fixture, { recursive: true, force: true });
    }
}

async function verifyCodexHostAccessDelivery(applicationUrl, facadeUrl, runtimeUrl) {
    const assert = (await import("node:assert/strict")).default;
    const fs = (await import("node:fs")).default;
    const cp = (await import("node:child_process")).default;
    const os = (await import("node:os")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const path = await import("node:path");
    const originals = [];
    const replace = (owner, name, value) => { originals.push([owner, name, owner[name]]); owner[name] = value; };
    const uid = Object.getOwnPropertyDescriptor(process, "getuid");
    const forbidden = () => { throw new Error("unexpected Codex host access native effect"); };
    const importRead = await createOwnedImportRead(new URL("./", facadeUrl), new URL("./packages/device-lab/package.json", facadeUrl), "host access fixture");
    try {
        replace(fs, "readFileSync", importRead.read);
        replace(os, "homedir", () => path.resolve("codex-host-access-fixture"));
        for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) replace(cp, name, forbidden);
        syncBuiltinESMExports();
        const { createCodexHostAccessRestoration } = await import(applicationUrl);
        const facade = await import(facadeUrl);
        const runtime = await import(runtimeUrl);
        const layout = await import(new URL("./utils.js", facadeUrl));
        const acl = await import(new URL("./codex-config-acl.js", facadeUrl));
        importRead.close();
        for (const [name, value] of Object.entries(fs)) if (typeof value === "function") replace(fs, name, forbidden);
        for (const [name, value] of Object.entries(fs.promises)) if (typeof value === "function") replace(fs.promises, name, forbidden);
        const trace = [], warnings = [];
        let accessCount = 0, denied = false, repairStatus = 0, recheckFails = false;
        const config = layout.getCodexConfigFile("work");
        replace(fs, "accessSync", (selected, mode) => {
            assert.equal(selected, config); assert.equal(mode, fs.constants.R_OK | fs.constants.W_OK);
            trace.push("access");
            if (++accessCount === 1 && denied) throw { code: "EACCES" };
            if (accessCount === 2 && recheckFails) throw new Error("recheck-denied");
        });
        replace(fs, "lstatSync", selected => {
            trace.push(selected === config ? "config" : "parent");
            assert.ok(selected === config || selected === path.dirname(config));
            return { uid: 1001, isDirectory() { return true; }, isFile() { return true; }, get nlink() { throw new Error("unexpected host nlink read"); } };
        });
        replace(console, "warn", function (message) { assert.equal(this, console); warnings.push(message); });
        Object.defineProperty(process, "getuid", { configurable: true, value: function () { assert.equal(this, process); return 1001; } });
        const target = "pinned target;$(ignored)";
        replace(cp, "spawnSync", (command, args, options) => {
            assert.equal(command, "docker"); assert.deepEqual(options, { encoding: "utf-8", timeout: 15000 });
            if (args[1] === target) {
                assert.deepEqual(args, ["exec", target, "sh", "-c", "id -u"]);
                trace.push("uid"); runtime._setRuntimeInfoForTest({ runtime: "podman" });
                return { status: 0, stdout: "2001\n" };
            }
            assert.deepEqual(args, ["exec", "--user", "root", target, "sh", "-c",
                `timeout -k 2s 10s sh -c '${acl.codexConfigFileAclScript("2001").replace(/'/g, `'"'"'`)}'`]);
            trace.push("repair"); return { status: repairStatus, stderr: "repair-denied" };
        });
        syncBuiltinESMExports();
        assert.equal(facade.restoreCodexConfigHostOwnership.length, 2);
        assert.equal(facade.restoreCodexConfigHostOwnership.name, "restoreCodexConfigHostOwnership");
        assert.equal(facade.restoreCodexConfigHostOwnership(target, "work"), undefined);
        assert.deepEqual(trace, ["access"]);
        for (const failure of ["none", "repair", "recheck"]) {
            trace.length = 0; warnings.length = 0; accessCount = 0; denied = true;
            repairStatus = failure === "repair" ? 1 : 0; recheckFails = failure === "recheck";
            runtime._setRuntimeInfoForTest({ runtime: "docker" });
            assert.equal(facade.restoreCodexConfigHostOwnership(target, "work"), undefined);
            assert.deepEqual(trace, ["access", "parent", "config", "uid", "repair", ...(failure === "repair" ? [] : ["access"])]);
            assert.equal(warnings.length, failure === "none" ? 0 : 1);
            if (warnings.length) assert.ok(warnings[0].includes(config) && warnings[0].includes(failure === "repair" ? "repair-denied" : "recheck-denied"));
        }
        let touched = false;
        const core = createCodexHostAccessRestoration({ resolveConfig: () => "absent", accessConfig: () => { throw { code: "ENOENT" }; },
            hasHostIdentity: () => { touched = true; return true; } });
        assert.equal(core.restore("target"), undefined); assert.equal(touched, false);
    } finally {
        if (uid) Object.defineProperty(process, "getuid", uid); else delete process.getuid;
        for (const [owner, name, original] of originals.reverse()) owner[name] = original;
        syncBuiltinESMExports();
    }
}

async function verifyHomeResolutionConfigDelivery(pathsUrl, configUrl, facadeUrl) {
    const assert=(await import("node:assert/strict")).default;
    const fs=(await import("node:fs")).default, os=(await import("node:os")).default;
    const path=(await import("node:path")).default;
    const {syncBuiltinESMExports}=await import("node:module");
    const {createHomeLayoutPaths}=await import(pathsUrl);
    const {createCccConfig}=await import(configUrl);
    const events=[], existing=new Set();
    const entries=["claude","claude.json","codex"];
    const ports={homeDirectory(){events.push("home");return "home";},joinHostPath(...parts){events.push(["join",...parts]);return parts.join("/");},
        entryExists(selected){events.push(["exists",selected]);return existing.has(selected);},
        createDirectory(selected,options){events.push(["mkdir",selected,options]);return undefined;},
        writeMarker(selected,data,options){events.push(["marker",selected,data,options]);return undefined;}};
    const layout=createHomeLayoutPaths(ports,"default",".ccc-default-profile",entries);
    assert.deepEqual(events,[]);
    assert.equal(layout.profileCodexDir("work"),"home/.ccc/profiles/work/codex");
    assert.equal(events.some(value=>Array.isArray(value)&&value[0]==="exists"),false);
    existing.add("home/.ccc/claude");events.length=0;
    assert.equal(layout.profileCodexDir(),"home/.ccc/codex","other legacy entry keeps absent requested entry legacy");
    existing.add("home/.ccc/profiles/default/.ccc-default-profile");
    assert.equal(layout.profileCodexDir(),"home/.ccc/profiles/default/codex");
    existing.add("home/.ccc/codex");assert.equal(layout.profileCodexDir(),"home/.ccc/codex");
    existing.add("home/.ccc/profiles/default/codex");assert.equal(layout.profileCodexDir(),"home/.ccc/profiles/default/codex");
    existing.add("home/.ccc/run/clipboard.port");existing.add("home/.ccc/locks");
    assert.equal(layout.clipboardPortFile(),"home/.ccc/run/clipboard.port");
    existing.add("home/.ccc/clipboard.port");assert.equal(layout.clipboardPortFile(),"home/.ccc/clipboard.port");
    existing.delete("home/.ccc/profiles/default/.ccc-default-profile");events.length=0;
    assert.equal(layout.ensureDefaultProfileDir(),undefined);
    assert.deepEqual(events.filter(value=>Array.isArray(value)&&["mkdir","marker"].includes(value[0])),[
        ["mkdir","home/.ccc/profiles/default",{recursive:true,mode:448}],
        ["marker","home/.ccc/profiles/default/.ccc-default-profile","",{mode:384}]]);
    let bytes='{"kept":true}',pid=1,temporary;
    const trace=[];
    const configPorts={resolveConfigPath(){trace.push("path");return "config";},resolveHomePath(){trace.push("home");return "home";},
        createDirectory(selected,options){assert.equal(selected,"home");assert.deepEqual(options,{recursive:true,mode:448});trace.push("mkdir");return undefined;},
        fileExists(selected){assert.equal(selected,"config");trace.push("exists");return true;},readText(){trace.push("read");return bytes;},
        processId(){trace.push("pid");return pid;},writeText(selected,data,options){assert.deepEqual(options,{mode:384});trace.push("write");temporary=[selected,data];return undefined;},
        replaceFile(from,to){trace.push("rename");assert.deepEqual([from,to],["config.2.tmp","config"]);bytes=temporary[1];return undefined;}};
    const config=createCccConfig(configPorts);assert.deepEqual(trace,[]);assert.deepEqual(config.read(),{kept:true});trace.length=0;
    assert.equal(config.update(value=>{trace.push("mutate");value.added=1;pid=2;return Promise.resolve();}),undefined);
    assert.deepEqual(trace,["path","home","mkdir","exists","read","mutate","pid","write","rename"]);
    assert.equal(bytes,'{\n  "kept": true,\n  "added": 1\n}');
    bytes="broken";trace.length=0;assert.throws(()=>config.update(()=>{throw new Error("unexpected mutation");}),/not a valid JSON object/);
    assert.deepEqual(trace,["path","home","mkdir","exists","read"]);

    const fixture=fs.mkdtempSync(path.join(process.cwd(),"home-resolution-"));
    const savedHome=os.homedir, savedJoin=path.join, savedMkdir=fs.mkdirSync;
    const saved=[];
    const replace=(owner,name,value)=>{saved.push([owner,name,owner[name]]);owner[name]=value;};
    const owned=selected=>assert.ok(typeof selected==="string"&&(selected===fixture||selected.startsWith(fixture+path.sep)),"outside private home fixture");
    try {
        os.homedir=()=>fixture;syncBuiltinESMExports();
        const native=await import(facadeUrl);
        // Real builtin mutation during argument evaluation distinguishes the
        // historical selected callee from a delayed native-wrapper lookup.
        os.homedir=()=>{path.join=()=>"unexpected delayed join";syncBuiltinESMExports();return fixture;};
        syncBuiltinESMExports();
        assert.equal(native.cccHome(),savedJoin(fixture,".ccc"));
        path.join=savedJoin;os.homedir=()=>fixture;syncBuiltinESMExports();
        let homeReads=0;
        const mkdirFailure=new Error("unexpected delayed mkdir");
        os.homedir=()=>{if(++homeReads===2){fs.mkdirSync=()=>{throw mkdirFailure;};syncBuiltinESMExports();}return fixture;};
        syncBuiltinESMExports();
        native.updateCccConfig(value=>{value.bindingProof=true;});
        assert.throws(()=>native.updateCccConfig(()=>{}),value=>value===mkdirFailure);
        fs.mkdirSync=savedMkdir;os.homedir=()=>fixture;syncBuiltinESMExports();
        fs.unlinkSync(native.configFile());

        for(const name of ["accessSync","existsSync","lstatSync","statSync","mkdirSync","readFileSync","writeFileSync","renameSync","unlinkSync","rmdirSync","readdirSync"]){
            const original=fs[name];replace(fs,name,(...args)=>{owned(args[0]);if(name==="renameSync")owned(args[1]);return original(...args);});
        }
        syncBuiltinESMExports();
        const home=path.join(fixture,".ccc"), legacy=path.join(home,"claude");
        fs.mkdirSync(legacy,{recursive:true});
        assert.equal(native.profileCodexDir(),path.join(home,"codex"));
        assert.equal(native.ensureDefaultProfileDir(),undefined);
        const marker=path.join(home,"profiles/default/.ccc-default-profile");assert.equal(fs.readFileSync(marker,"utf8"),"");
        assert.equal(native.profileCodexDir(),path.join(home,"profiles/default/codex"));
        native.updateCccConfig(value=>{value.kept=true;});
        const selected=native.configFile();assert.equal(fs.readFileSync(selected,"utf8"),'{\n  "kept": true\n}');
        assert.deepEqual(native.readCccConfig(),{kept:true});
        const selectedWriter=fs.writeFileSync, writerFailure=new Error("unexpected delayed writer");
        native.updateCccConfig(value=>{value.toJSON=()=>{fs.writeFileSync=()=>{throw writerFailure;};syncBuiltinESMExports();return {kept:true,captured:true};};});
        assert.deepEqual(native.readCccConfig(),{kept:true,captured:true});
        assert.throws(()=>native.updateCccConfig(()=>{}),value=>value===writerFailure);
        fs.writeFileSync=selectedWriter;syncBuiltinESMExports();

        if(process.platform!=="win32"){assert.equal(fs.statSync(selected).mode&511,384);assert.equal(fs.statSync(marker).mode&511,384);}
        fs.writeFileSync(selected,"malformed");assert.deepEqual(native.readCccConfig(),{});
        assert.throws(()=>native.updateCccConfig(()=>{}),/not a valid JSON object/);assert.equal(fs.readFileSync(selected,"utf8"),"malformed");
        fs.writeFileSync(selected,'{"kept":true}');
        const failure=new Error("private rename failure");replace(fs,"renameSync",(from,to)=>{owned(from);owned(to);throw failure;});syncBuiltinESMExports();
        assert.throws(()=>native.updateCccConfig(value=>{value.next=2;}),value=>value===failure);
        assert.equal(fs.readFileSync(selected,"utf8"),'{"kept":true}');
        assert.equal(fs.readFileSync(`${selected}.${process.pid}.tmp`,"utf8"),'{\n  "kept": true,\n  "next": 2\n}');
        for(const name of ["cccHome","profilesDir","defaultProfileDir","runDir","locksDir","clipboardFilesDir","helperBinDir","clipboardStateDir","clipboardPortFile","clipboardStartingLock","configFile","legacyRemoteConfigDir","ensureDefaultProfileDir","readCccConfig"]){assert.equal(native[name].name,name);assert.equal(native[name].length,0);}
        for(const name of ["profileClaudeDir","profileClaudeJsonFile","profileCodexDir","updateCccConfig"]){assert.equal(native[name].name,name);assert.equal(native[name].length,1);}
    } finally {
        for(const [owner,name,original] of saved.reverse())owner[name]=original;
        os.homedir=savedHome;path.join=savedJoin;fs.mkdirSync=savedMkdir;syncBuiltinESMExports();fs.rmSync(fixture,{recursive:true,force:true});
    }
}

async function verifyContainerInstallationDelivery(applicationUrl, setupUrl, registryUrl, runtimeUrl, baseline) {
    const assert=(await import("node:assert/strict")).default;
    const cp=(await import("node:child_process")).default, os=(await import("node:os")).default;
    const {createHash}=await import("node:crypto");
    const {syncBuiltinESMExports}=await import("node:module");
    const originals=[];const replace=(owner,name,value)=>{originals.push([owner,name,owner[name]]);owner[name]=value;};
    const forbidden=()=>{throw new Error("unexpected native installation fixture execution");};
    let outcomes=[],calls=[],logs=[],progress=[];
    try {
        for(const name of ["spawn","spawnSync","exec","execSync","execFile","execFileSync","fork"])replace(cp,name,forbidden);
        replace(cp,"spawnSync",(...args)=>{calls.push(args);assert.ok(outcomes.length,"unexpected additional command");return outcomes.shift();});
        replace(os,"homedir",()=>process.env.HOME);
        replace(console,"log",function(...args){assert.equal(this,console);logs.push(args);});
        replace(process.stderr,"write",function(text){assert.equal(this,process.stderr);progress.push(text);return true;});
        syncBuiltinESMExports();
        const {createContainerToolInstallation}=await import(applicationUrl);
        const setup=await import(setupUrl),registry=await import(registryUrl),runtime=await import(runtimeUrl);
        const opaque=Symbol("opaque");const touched=[];
        const core=createContainerToolInstallation({prepareClaudeProbe:()=>{touched.push("prepare");return opaque;},captureClaudeProbe:()=>function(target,handle){assert.equal(target,"target");assert.equal(handle,opaque);touched.push("probe");return {status:0,stdout:"VALID"};},reportProbeNotes:(_stderr,seen)=>{assert.ok(seen instanceof Set);touched.push("notes");return undefined;}});
        assert.deepEqual(touched,[]);assert.equal(core.ensureClaude("target"),undefined);assert.deepEqual(touched,["prepare","probe","notes"]);
        const target="asset-target",success={status:0,stdout:"",stderr:""};
        function capture(name,invoke,steps){
            calls=[];logs=[];progress=[];outcomes=steps.map(value=>({...success,...value}));runtime._setRuntimeInfoForTest({runtime:"docker"});
            assert.equal(invoke(),undefined);assert.equal(outcomes.length,0);
            const actual={commands:calls.length,hashes:calls.map(call=>createHash("sha256").update(JSON.stringify(call)).digest("hex")),logs,progress};
            assert.deepEqual(actual,baseline[name],name+" old emitted native command/output parity");
        }
        capture("claude-valid",()=>setup.ensureClaudeInContainer(target),[{stdout:"VALID",stderr:"removed synthetic-entry\n"}]);
        capture("claude-restored",()=>setup.ensureClaudeInContainer(target),[{stdout:"RESTORED 1.2.3",stderr:""}]);
        capture("claude-install",()=>setup.ensureClaudeInContainer(target),[{stdout:"INSTALL",stderr:"cannot remove synthetic-entry\n"},{},{stdout:"VALID",stderr:"cannot remove synthetic-entry\n"}]);
        const gemini=registry.getToolByName("gemini"),codex=registry.getToolByName("codex");assert.ok(gemini&&codex);
        capture("npm-present",()=>setup.ensureTools(target,gemini),[{},{}]);
        capture("npm-ready",()=>setup.ensureTools(target,gemini),[{stdout:"gemini"},{stdout:"READY"},{},{}]);
        capture("npm-missing",()=>setup.ensureTools(target,gemini),[{stdout:"gemini"},{stdout:"MISSING"},{},{},{},{},{},{}]);
        capture("bubble-present",()=>setup.ensureTools(target,codex),[{},{},{}]);
        capture("bubble-missing",()=>setup.ensureTools(target,codex),[{},{},{status:42},{},{},{}]);
        capture("uv-present",()=>setup.ensureUvAvailable(target),[{}]);
        capture("uv-missing",()=>setup.ensureUvAvailable(target),[{status:1},{}]);
        const claude=registry.getToolByName("claude");assert.ok(claude);
        const installDescriptor=Object.getOwnPropertyDescriptor(claude,"installCommand");
        const spawnDescriptor=Object.getOwnPropertyDescriptor(cp,"spawnSync");
        try {
            const selectedCalls=[],redirectedCalls=[];let installReads=0;
            const redirected=function(...args){assert.equal(this,undefined);redirectedCalls.push(args);return {...success,stdout:"VALID"};};
            cp.spawnSync=function(...args){
                assert.equal(this,undefined);selectedCalls.push(args);
                return {...success,stdout:selectedCalls.length===1?"INSTALL":""};
            };
            syncBuiltinESMExports();
            Object.defineProperty(claude,"installCommand",{configurable:installDescriptor.configurable,enumerable:installDescriptor.enumerable,get(){
                installReads++;cp.spawnSync=redirected;syncBuiltinESMExports();return "synthetic-install-command";
            }});
            runtime._setRuntimeInfoForTest({runtime:"docker"});
            assert.equal(setup.ensureClaudeInContainer(target),undefined);
            assert.equal(installReads,1);assert.equal(selectedCalls.length,2);assert.equal(redirectedCalls.length,1);
            assert.deepEqual(selectedCalls[1],["docker",["exec",target,"sh","-c","timeout -k 5s 285s sh -c 'synthetic-install-command'"],{stdio:"inherit",timeout:300_000}]);
            assert.deepEqual(redirectedCalls[0],selectedCalls[0],"the subsequent Claude confirmation must observe the replacement binding");
        } finally {
            Object.defineProperty(claude,"installCommand",installDescriptor);
            Object.defineProperty(cp,"spawnSync",spawnDescriptor);syncBuiltinESMExports();
        }
        const findDescriptor=Object.getOwnPropertyDescriptor(Array.prototype,"find");
        const logDescriptor=Object.getOwnPropertyDescriptor(console,"log");
        const npmDefinitions=registry.getNpmTools();const changedDefinitions=[];
        try {
            let armed=false,loggerReplacements=0,selectedDefinitions=0;
            const redirectedLogs=[];
            const redirectedLog=function(...args){assert.equal(this,console);redirectedLogs.push(args);};
            Object.defineProperty(Array.prototype,"find",{...findDescriptor,value:function(...args){
                const selected=Reflect.apply(findDescriptor.value,this,args);
                if(this.length===npmDefinitions.length&&this.every((entry,index)=>
                    entry!==null&&typeof entry==="object"&&Object.keys(entry).length===2&&
                    Object.hasOwn(entry,"cmd")&&Object.hasOwn(entry,"pkg")&&
                    entry.cmd===npmDefinitions[index].cmd&&entry.pkg===npmDefinitions[index].pkg)&&selected?.cmd===gemini.name){
                    selectedDefinitions++;
                    const descriptor=Object.getOwnPropertyDescriptor(selected,"cmd");changedDefinitions.push([selected,descriptor]);
                    Object.defineProperty(selected,"cmd",{configurable:descriptor.configurable,enumerable:descriptor.enumerable,get(){
                        if(armed){armed=false;loggerReplacements++;console.log=redirectedLog;}
                        return descriptor.value;
                    }});
                }
                return selected;
            }});
            calls=[];logs=[];progress=[];outcomes=Array.from({length:8},()=>({...success}));
            outcomes[0].stdout="gemini";
            Object.defineProperty(outcomes[1],"stdout",{configurable:true,enumerable:true,get(){armed=true;return "MISSING";}});
            runtime._setRuntimeInfoForTest({runtime:"docker"});
            assert.equal(setup.ensureTools(target,gemini),undefined);
            assert.equal(outcomes.length,0);assert.equal(calls.length,8);
            assert.equal(selectedDefinitions,1);assert.equal(loggerReplacements,1);assert.equal(armed,false);
            assert.deepEqual(logs,[["Installing gemini..."]],"the logger selected before interpolation retains its console receiver");
            assert.deepEqual(redirectedLogs,[],"interpolation must not redirect the Installing message");
            outcomes=[{...success,stdout:"RESTORED 1.2.3"}];
            assert.equal(setup.ensureClaudeInContainer(target),undefined);assert.equal(outcomes.length,0);
            assert.deepEqual(redirectedLogs,[["Reusing claude 1.2.3 from the shared volume."]],"a later log capture must observe the replacement logger");
        } finally {
            for(const[definition,descriptor]of changedDefinitions)Object.defineProperty(definition,"cmd",descriptor);
            Object.defineProperty(Array.prototype,"find",findDescriptor);
            Object.defineProperty(console,"log",logDescriptor);
        }
        assert.equal(setup.ensureClaudeInContainer.length,1);assert.equal(setup.ensureUvAvailable.length,1);assert.equal(setup.ensureTools.length,2);
        assert.equal("ensureNpmTool" in setup,false);assert.equal("ensureCodexBubblewrap" in setup,false);
    } finally {for(const[owner,name,original]of originals.reverse())owner[name]=original;syncBuiltinESMExports();}
}

async function verifyClipboardBridgeDelivery(payloadArgument, homeArgument, mode = "operations", failingFile = "") {
    const {default: assert} = await import("node:assert/strict");
    const {default: fs} = await import("node:fs");
    const {default: os} = await import("node:os");
    const {default: childProcess} = await import("node:child_process");
    const {syncBuiltinESMExports} = await import("node:module");
    const {createHash} = await import("node:crypto");
    const {createServer, request} = await import("node:http");
    const {join, resolve, relative} = await import("node:path");
    const {pathToFileURL} = await import("node:url");
    const {EventEmitter} = await import("node:events");
    const {PassThrough, Writable} = await import("node:stream");
    for (const name of ["exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = () => { throw new Error("Unallocated clipboard native execution"); };
    assert(payloadArgument && homeArgument, "Explicit payload and private HOME are required");
    const payload = resolve(payloadArgument);
    const home = resolve(homeArgument);
    const dist = join(payload, "dist");
    const files = [
        "clipboard-server.js", "domain/clipboard/snapshot.js", "domain/clipboard/text-write.js",
        "domain/clipboard/server-lifecycle.js", "application/clipboard/snapshot.js",
        "application/clipboard/text-write.js", "application/clipboard/server-lifecycle.js",
    ];
    const originalReadFile = fs.readFileSync;
    function expectedVersion() {
        const hash = createHash("sha256").update("ccc-clipboard-policy-v1\0");
        for (const file of files) {
            const content = originalReadFile(join(dist, file), "utf8");
            hash.update(file).update("\0").update(String(Buffer.byteLength(content, "utf8")))
                .update("\0").update(content).update("\0");
        }
        return hash.digest("hex").slice(0, 12);
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    os.homedir = () => home;
    for (const key of ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP"]) process.env[key] = home;
    let readFailure = mode === "hash-read-failure";
    const hashReads = [];
    fs.readFileSync = (file, ...args) => {
        const logical = typeof file === "string" ? relative(dist, file).replaceAll("\\", "/") : "";
        if (files.includes(logical)) {
            hashReads.push(logical);
            if (readFailure && logical === failingFile) throw Object.assign(new Error("Fixture hash read unavailable"), { code: "EACCES" });
        }
        return originalReadFile(file, ...args);
    };
    let clipboardText = Buffer.from("old private text");
    let clipboardImage = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    let bindObservation = "none";
    let spawnDaemon;
    const nativeWrites = [];
    childProcess.spawnSync = (_command, args) => {
        if (args[0] === "ps") return { status: bindObservation === "unknown" ? 1 : 0, stdout: "", stderr: "" };
        if (args.includes("TARGETS")) return { status: 0, stdout: Buffer.from(clipboardImage ? "image/png\nUTF8_STRING\n" : "UTF8_STRING\n") };
        if (args.includes("-t")) {
            const type = args[args.indexOf("-t") + 1];
            return { status: type === "image/png" && clipboardImage ? 0 : 1, stdout: type === "image/png" ? clipboardImage ?? Buffer.alloc(0) : Buffer.alloc(0) };
        }
        if (args.includes("-o")) return { status: 0, stdout: clipboardText };
        throw new Error("Unexpected native synchronous command in standalone fixture");
    };
    childProcess.spawn = (command, args, options) => {
        if (args[1] === "--serve") {
            assert.equal(command, process.execPath);
            assert.deepEqual(args, [join(dist, "clipboard-server.js"), "--serve"]);
            assert.deepEqual(options, { detached: true, stdio: "ignore", windowsHide: true });
            assert(spawnDaemon, "Explicit private daemon publication fixture is required");
            spawnDaemon();
            return { unref() { daemonUnrefs += 1; } };
        }
        assert.equal(command, "xclip");
        assert.deepEqual(args, ["-selection", "clipboard", "-in", "-target", "UTF8_STRING"]);
        assert.deepEqual(options, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        const input = [];
        const child = Object.assign(new EventEmitter(), { stdin: null, stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
        child.stdin = new Writable({
            write(chunk, _encoding, done) { input.push(Buffer.from(chunk)); done(); },
            final(done) {
                done();
                queueMicrotask(() => {
                    clipboardText = Buffer.concat(input);
                    clipboardImage = null;
                    nativeWrites.push(clipboardText);
                    child.emit("exit", 0, null);
                    child.emit("close", 0, null);
                });
            },
        });
        return child;
    };
    syncBuiltinESMExports();

    // Existing native runtime test seam supplies a fixed Docker fact. The actual
    // clipboard bind-user adapter still evaluates our private native observations.
    const runtime = await import(pathToFileURL(join(dist, "container-runtime.js")).href);
    runtime._setRuntimeInfoForTest({ runtime: "docker", flavor: "docker-native", version: "0.0.0",
        socketPath: "/private-fixture.sock", rootless: false, remote: false, dockerDesktop: false });
    const mod = await import(pathToFileURL(join(dist, "clipboard-server.js")).href);
    assert.equal(mod.writeClipboardText.name, "writeClipboardText");
    assert.equal(mod.writeClipboardText.length, 2);
    assert.equal(mod.writeClipboardText.constructor.name, "AsyncFunction");
    assert.equal(mod.ensureClipboardServer.name, "ensureClipboardServer");
    assert.equal(mod.ensureClipboardServer.length, 0);
    assert.equal(mod.ensureClipboardServer.constructor.name, "AsyncFunction");
    assert.equal(mod.stopClipboardServerIfLast.constructor.name, "Function");
    assert.equal(mod.retireClipboardServerFromPortFile.constructor.name, "Function");
    const servers = [];
    let daemonUnrefs = 0;
    const token = "private-delivery-token";
    async function http(port, path, method = "GET", body, bearer = token) {
        return new Promise((done, reject) => {
            const req = request({ hostname: "127.0.0.1", port, path, method, headers: {
                ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
                "Content-Type": "text/plain;charset=utf-8",
            } }, response => {
                const chunks = [];
                response.on("data", chunk => chunks.push(chunk));
                response.on("end", () => done({ status: response.statusCode, body: Buffer.concat(chunks) }));
                response.on("error", reject);
            });
            req.on("error", reject);
            req.end(body);
        });
    }
    async function bridge(platform = "unsupported", bearer = token) {
        const instance = mod.createClipboardServer(bearer, platform);
        servers.push(instance.server);
        return instance.start("127.0.0.1");
    }
    function publish(port, bearer) {
        const root = join(home, ".ccc", "run");
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const file = join(root, "clipboard.port");
        fs.writeFileSync(file, `${port}:${bearer}`, { mode: 0o600 });
        return file;
    }
    async function peer() {
        const peerToken = "private-legacy-delivery-token";
        const calls = [];
        const server = createServer((req, response) => {
            calls.push({ path: req.url, auth: req.headers.authorization });
            if (req.headers.authorization !== `Bearer ${peerToken}`) { response.writeHead(401).end(); return; }
            if (req.url === "/shutdown") { response.writeHead(200).end("acknowledged"); return; }
            response.end(JSON.stringify({ service: "ccc-clipboard", valid: true, version: "legacy" }));
        });
        servers.push(server);
        const port = await new Promise(done => server.listen(0, "127.0.0.1", () => done(server.address().port)));
        const portFile = publish(port, peerToken);
        return { port, peerToken, portFile, calls };
    }
    try {
        const port = await bridge();
        const version = JSON.parse((await http(port, "/health")).body).version;
        assert.equal(version, readFailure ? "unknown" : expectedVersion());
        if (!readFailure) assert.deepEqual(hashReads, files);
        assert.deepEqual(JSON.parse((await http(port, "/health", "GET", undefined, "wrong-token")).body), { service: "ccc-clipboard" });
        if (mode === "hash-read-failure") {
            assert(files.includes(failingFile), "A literal hash file is required");
            readFailure = false;
            assert.equal(JSON.parse((await http(port, "/health")).body).version, "unknown");
        } else if (mode === "capture") {
            fs.appendFileSync(join(dist, files[2]), "\n// private post-import policy mutation\n");
            assert.equal(JSON.parse((await http(port, "/health")).body).version, version);
            assert.notEqual(expectedVersion(), version);
        } else if (mode === "operations") {
            const snapshotCore = await import(pathToFileURL(join(dist, "application/clipboard/snapshot.js")).href);
            const writeCore = await import(pathToFileURL(join(dist, "application/clipboard/text-write.js")).href);
            const lifecycleCore = await import(pathToFileURL(join(dist, "application/clipboard/server-lifecycle.js")).href);
            const state = snapshotCore.createClipboardSnapshotState();
            let clock = 10, captures = 0;
            const opaque = Object.freeze({ length: 3, opaque: true }), rawRead = Symbol("raw clipboard read");
            const forbidden = () => { throw new Error("Unallocated inward clipboard capability"); };
            const ports = { now: () => clock, readChangeMarker: async () => "m",
                readWindowsCapture: async () => { captures++; return { marker: "m", targets: ["image/png"], text: null, imagePng: opaque, imageBmp: null }; },
                readDarwinFrame: forbidden, parseDarwinCapture: forbidden, readDarwinLegacyImage: forbidden,
                readDarwinLegacyText: forbidden, readDarwinPngpaste: forbidden, parseAppleScriptImage: forbidden,
                readDarwinFileReferenceData: forbidden, readLinuxUriData: forbidden, decodeText: forbidden,
                parseFileUriList: forbidden, parseImagePathText: forbidden, readTargets: forbidden,
                readText: forbidden, readImage: forbidden, readImageFile: forbidden, copyImageFile: forbidden, createReadError: () => rawRead };
            const read = snapshotCore.createClipboardSnapshotReader(ports, state);
            const initial = await read("windows"); assert.equal(initial.imagePng, opaque);
            clock = 1000; assert.equal(await read("windows"), initial); assert.equal(captures, 1);
            let publishCapture;
            ports.readWindowsCapture = () => { captures++; return new Promise(done => { publishCapture = done; }); };
            const pending = read("windows", true); await Promise.resolve(); await Promise.resolve();
            snapshotCore.invalidateClipboardCache(state);
            ports.readWindowsCapture = async () => { captures++; return { marker: "m", targets: ["image/png"], text: null, imagePng: opaque, imageBmp: null }; };
            publishCapture({ marker: "m", targets: [], text: null, imagePng: null, imageBmp: null });
            assert.equal((await pending).imagePng, opaque); assert.equal(captures, 3);
            ports.readWindowsCapture = async () => { throw rawRead; };
            await assert.rejects(read("windows", true), value => value === rawRead);
            ports.readWindowsCapture = async () => ({ marker: "wrong", targets: [], text: null, imagePng: null, imageBmp: null });
            await assert.rejects(read("windows", true), value => value === rawRead);
            ports.readWindowsCapture = async () => ({ marker: "m", targets: [], text: null, imagePng: null, imageBmp: null });
            clock = 2000; const negative = await read("windows", true);
            clock = 2199; assert.equal(await read("windows"), negative);
            clock = 2200; assert.notEqual(await read("windows"), negative);
            const fallbackTrace = [], copied = Object.freeze({ length: 4, copied: true });
            const fallback = snapshotCore.buildImageFileClipboardFallbackFromPaths(["one", "two"], selected => { fallbackTrace.push(["read", selected]); return null; }, selected => { fallbackTrace.push(["copy", selected]); return selected === "two" ? copied : null; });
            assert.equal(fallback.text, copied); assert.deepEqual(fallbackTrace, [["read", "one"], ["read", "two"], ["copy", "one"], ["copy", "two"]]);
            const writer = {}, timer = {}, events = []; let exit;
            const writePorts = { encodeText: text => Buffer.from(text), decodeText: bytes => bytes.toString(),
                prepareWriter: bytes => bytes, launchWriter: () => { assert.equal(state.cache, null); return writer; },
                scheduleTimeout: (_callback, ms) => { assert.equal(ms, 5000); return timer; },
                cancelReadTimer: selected => { assert.equal(selected, timer); events.push("clear"); return undefined; },
                onWriterError: () => undefined, onWriterExit: (selected, callback) => { assert.equal(selected, writer); exit = callback; return undefined; },
                onInputError: () => undefined, endInput: () => undefined, killWriter: () => undefined };
            const write = writeCore.createClipboardTextWriter(writePorts, state), generation = state.generation;
            const writing = write("private text", "windows"); assert.equal(state.generation, generation + 1); exit(0); await writing;
            assert.deepEqual(events, ["clear"]); assert.equal(state.generation, generation + 2);
            await assert.rejects(write("nul\0text", "windows"), /Invalid clipboard text/);
            const failedWrite = writeCore.createClipboardTextWriter({ ...writePorts, launchWriter() { throw rawRead; } }, state);
            const beforeFailure = state.generation; await assert.rejects(failedWrite("text", "windows"), value => value === rawRead);
            assert.equal(state.generation, beforeFailure + 2);
            const lock = {}, releases = [];
            const life = lifecycleCore.createClipboardServerLifecycle({ readPortFile: () => ({ port: 123, token: "opaque" }),
                portFilePath: () => "private-port", startupLockPath: () => "private-lock", tryAcquireStartupLock: () => lock,
                recoverDeadStartupLock: () => false, releaseStartupLock: selected => { assert.equal(selected, lock); releases.push(selected); return undefined; },
                checkHealth: async () => ({ alive: true, version: "old" }), requestShutdown: async () => { throw rawRead; },
                portMayHaveBindUsers: () => false, warnUpgradeDeferred: forbidden, now: () => 0,
                sleep: forbidden, daemonScriptPath: forbidden, launchDaemon: forbidden, unrefDaemon: forbidden }, "current");
            await assert.rejects(life.ensureClipboardServer(), value => value === rawRead); assert.deepEqual(releases, [lock]);
            const x11 = await bridge("linux-x11");
            const targets = await http(x11, "/clipboard/targets");
            assert.equal(targets.status, 200);
            assert.match(targets.body.toString(), /image\/png/);
            assert.deepEqual((await http(x11, "/clipboard/image/png")).body, clipboardImage);
            const text = Buffer.from("  한글 😀 ' \"\r\nprivate sample\n\n");
            assert.equal((await http(x11, "/clipboard/text", "POST", text)).status, 204);
            assert.deepEqual(nativeWrites, [text]);
            assert.deepEqual((await http(x11, "/clipboard/text")).body, text);
            assert.equal((await http(x11, "/clipboard/image/png")).status, 204);
            publish(port, token);
            assert.equal(await mod.ensureClipboardServer(), port);
            assert.equal(daemonUnrefs, 0);
            const legacy = await peer();
            const oldBytes = originalReadFile(legacy.portFile, "utf8");
            const inode = fs.statSync(legacy.portFile).ino;
            bindObservation = "unknown";
            assert.equal(await mod.ensureClipboardServer(), legacy.port);
            assert.equal(mod.retireClipboardServerFromPortFile(legacy.portFile), undefined);
            assert.equal(mod.stopClipboardServerIfLast(false), undefined);
            assert.equal(legacy.calls.filter(call => call.path === "/shutdown").length, 0);
            assert.equal(originalReadFile(legacy.portFile, "utf8"), oldBytes);
            assert.equal(fs.statSync(legacy.portFile).ino, inode);
            bindObservation = "none";
            let successor = 0;
            spawnDaemon = () => {
                void bridge("unsupported", "private-successor-delivery-token").then(next => {
                    successor = next;
                    publish(next, "private-successor-delivery-token");
                });
            };
            assert.equal(await mod.ensureClipboardServer(), successor);
            assert.notEqual(successor, legacy.port);
            assert.equal(daemonUnrefs, 1);
            assert.equal(legacy.calls.filter(call => call.path === "/shutdown").length, 1);
            assert(legacy.calls.every(call => call.auth === `Bearer ${legacy.peerToken}`));
            assert.equal(fs.statSync(legacy.portFile).ino, inode);
            // Retire a controlled HTTP peer; the real bridge's shutdown exits its
            // owner and is deliberately not invoked by this in-process consumer.
            const retiring = await peer();
            assert.equal(mod.stopClipboardServerIfLast(true), undefined);
            assert.equal(mod.retireClipboardServerFromPortFile(retiring.portFile), undefined);
            const deadline = Date.now() + 1000;
            while (!retiring.calls.some(call => call.path === "/shutdown")) {
                assert(Date.now() < deadline, "Private retirement request was not observed");
                await new Promise(done => setTimeout(done, 10));
            }
            assert(fs.existsSync(retiring.portFile));
        } else assert.equal(mode, "hash");
        console.log(JSON.stringify({ mode, version, policyFiles: files.length, nativeWrites: nativeWrites.length, daemonUnrefs }));
    } finally {
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise(done => server.close(() => done()));
        }
    }
}

// Current declaration contracts retain the negative asynchronous capability sites.
const REVIEWED_WAVE_DECLARATION_CONSUMERS = [
    [
        "container-launch-arguments",
        "import { createContainerLaunchArguments, createContainerMountArguments } from \"./dist/application/container-launch-arguments.js\";\nimport type { BindMountArgumentOptions, ContainerLaunchOptions, LaunchRuntimeFacts } from \"./dist/domain/container-launch-arguments.js\";\nimport type { ContainerLaunchArgumentPorts, ContainerMountArgumentPorts } from \"./dist/ports/container-launch-arguments.js\";\nimport type { DockerRunArgsOptions, LabRunnerRunConfig } from \"./dist/docker.js\";\nimport type { ContainerIdentity } from \"./dist/container-identity.js\";\n\nfunction contracts(launchPorts: ContainerLaunchArgumentPorts<ContainerIdentity>, mountPorts: ContainerMountArgumentPorts, options: DockerRunArgsOptions, lab: LabRunnerRunConfig) {\n    const inward: ContainerLaunchOptions<ContainerIdentity> = options;\n    const launch = createContainerLaunchArguments(launchPorts), mounts = createContainerMountArguments(mountPorts);\n    const args: string[] = launch.buildRunArgs(inward);\n    args.push(\"mutable\"); options.credentialMounts.push({ hostPath: \"/source\", containerPath: \"/target\" }); lab.kvmGroupId = 0;\n    const bindOptions: BindMountArgumentOptions = { readonly: true, sourceNamespace: \"daemon\" };\n    mounts.bindMountArgs(\"/source\", \"/target\", bindOptions).push(\"mutable\");\n    // @ts-expect-error Captured runtime facts are synchronous.\n    createContainerMountArguments({ ...mountPorts, readRuntimeInfo: async () => mountPorts.readRuntimeInfo() });\n    // @ts-expect-error Native capture must return an executable, not its result.\n    createContainerLaunchArguments({ ...launchPorts, captureExistsSync: () => true });\n    // @ts-expect-error Client and daemon are the only supported source namespaces.\n    mounts.bindMountArgs(\"/source\", \"/target\", { sourceNamespace: \"unknown\" });\n    // @ts-expect-error A foreign identity cannot replace the native caller's opaque identity.\n    launch.buildRunArgs({ ...inward, identity: \"foreign\" });\n    // @ts-expect-error Original mount collections remain mutable.\n    const immutable: ContainerLaunchOptions<ContainerIdentity> = { ...inward, credentialMounts: [] as readonly { hostPath: string; containerPath: string }[] };\n    void immutable;\n    return args;\n}\n\n"
    ],
    [
        "codex-launch",
        "import { createCodexLaunchPreparation } from \"./dist/application/tool-session/codex-launch.js\";\nimport { prepareCodexLaunch, isInteractiveCodexCommand, type CodexLaunchPreparation } from \"./dist/codex-launch.js\";\nimport type { CodexLaunchPorts } from \"./dist/ports/tool-session/codex-launch.js\";\nimport type { spawnSync } from \"node:child_process\";\nfunction contract(ports: CodexLaunchPorts<symbol>) {\n    const app = createCodexLaunchPreparation(ports);\n    const result: CodexLaunchPreparation = app.prepare([\"codex\"]);\n    const facade: (runtime: string, prefix: readonly string[], command: readonly string[], runner?: typeof spawnSync) => CodexLaunchPreparation = prepareCodexLaunch;\n    result.command.push(\"mutable\");\n    // @ts-expect-error Every semantic capability is required.\n    createCodexLaunchPreparation({});\n    // @ts-expect-error Preparation remains synchronous.\n    const asyncResult: Promise<CodexLaunchPreparation> = app.prepare([\"codex\"]);\n    // @ts-expect-error Native capabilities are readonly.\n    ports.prepareStart = () => Symbol(\"other\");\n    // @ts-expect-error Observation is synchronous.\n    const invalid: CodexLaunchPorts<symbol>[\"probeDaemonExecutable\"] = async () => ({ status: 0, signal: null, stdout: \"\", stderr: \"\" });\n    void [facade, asyncResult, invalid];\n}\nvoid contract;\n"
    ],
    [
        "codex-resume",
        "import { createCodexResumeRecovery } from \"./dist/application/tool-session/codex-resume-recovery.js\";\nimport type { CodexResumeObservation, CodexResumeRecoveryPlan } from \"./dist/domain/tool-session/codex-resume.js\";\nimport type { CodexResumeRecoveryPorts } from \"./dist/ports/tool-session/codex-resume-recovery.js\";\nimport type { CodexResumeRecoveryPlan as PublicPlan } from \"./dist/codex-resume-recovery-runtime.js\";\nimport type { ResumeProcessResult } from \"./dist/codex-resume-process.js\";\n\nfunction compileContracts(ports: CodexResumeRecoveryPorts<object, string, (message: string) => void>) {\n    const run = createCodexResumeRecovery(ports);\n    const plan: PublicPlan = { command: [\"codex\"], retry: [\"codex\"], config: [] };\n    plan.command.push(\"resume\"); plan.retry[0] = \"codex\"; plan.config = [\"-c=x\"];\n    const inward: CodexResumeRecoveryPlan = plan;\n    const result: Promise<number> = run(inward, {}, \"opaque-home\", () => {});\n    void result;\n    const { dispose: omitted, ...incomplete } = ports; void omitted;\n    // @ts-expect-error Disposal is a required operation capability.\n    createCodexResumeRecovery(incomplete);\n    // @ts-expect-error Operation ports cannot acquire native default services through mutation.\n    ports.probeTerminal = async () => ({ code: 0, output: \"\", stderr: \"\", overflow: false, signal: null });\n    // @ts-expect-error There is no arbitrary native process executor port.\n    ports.run([\"codex\"], { timeoutMs: 1 });\n    // @ts-expect-error Public plans retain string array element types.\n    plan.command.push(1);\n}\nvoid compileContracts;\n\nfunction nativeObservationCompatibility(result: ResumeProcessResult): CodexResumeObservation { return result; }\nvoid nativeObservationCompatibility;\n\n"
    ],
    [
        "codex-clipboard-attachment",
        "import { createCodexClipboardImageAttachment } from \"./dist/application/tool-session/codex-clipboard-image.js\";\nimport type { CodexClipboardImageAttachmentPorts } from \"./dist/ports/tool-session/codex-clipboard-image.js\";\nimport { buildCodexClipboardImageRelativePath, injectCodexClipboardImageArgs,\n    maybeAttachCodexClipboardImage, readClipboardImagePng, type ClipboardImageAttachmentResult } from \"./dist/codex-clipboard-image.js\";\n\nfunction contracts(ports: CodexClipboardImageAttachmentPorts<{ image: true }>, mutable: string[], readonlyArgs: readonly string[]) {\n    const app = createCodexClipboardImageAttachment(ports);\n    const pending: Promise<ClipboardImageAttachmentResult> = app.maybeAttachCodexClipboardImage(\"project\", mutable, { enabled: false });\n    const facade: Promise<ClipboardImageAttachmentResult> = maybeAttachCodexClipboardImage(\"project\", mutable, {\n        enabled: true, clipboardUrl: \"url\", clipboardToken: \"token\", timestamp: 1, readImage: async () => Buffer.alloc(0),\n    });\n    const native: Promise<Buffer | null> = readClipboardImagePng(\"url\", \"token\");\n    const relative: string = buildCodexClipboardImageRelativePath(1);\n    const injected: string[] = injectCodexClipboardImageArgs(mutable, relative);\n    injected.push(\"mutable\");\n    // @ts-expect-error Explicit required ports cannot be omitted.\n    createCodexClipboardImageAttachment();\n    // @ts-expect-error Native reader selection is required.\n    createCodexClipboardImageAttachment({ now: ports.now, relativePath: ports.relativePath,\n        imagePath: ports.imagePath, ensureDirectory: ports.ensureDirectory, writeImage: ports.writeImage });\n    // @ts-expect-error Filesystem publication must be callable.\n    createCodexClipboardImageAttachment({ ...ports, writeImage: false });\n    // @ts-expect-error Relative path joining is synchronous.\n    createCodexClipboardImageAttachment({ ...ports, relativePath: async () => \"path\" });\n    // @ts-expect-error The opaque image type is preserved.\n    app.maybeAttachCodexClipboardImage(\"project\", mutable, { enabled: true, readImage: async () => \"bytes\" });\n    // @ts-expect-error Public arguments retain the mutable array contract.\n    maybeAttachCodexClipboardImage(\"project\", readonlyArgs, { enabled: false });\n    // @ts-expect-error Public injection retains the mutable array contract.\n    injectCodexClipboardImageArgs(readonlyArgs, relative);\n    // @ts-expect-error Attachment retains its async result.\n    const sync: ClipboardImageAttachmentResult = maybeAttachCodexClipboardImage(\"project\", mutable, { enabled: false });\n    // @ts-expect-error Native reader remains Buffer-specific.\n    maybeAttachCodexClipboardImage(\"project\", mutable, { enabled: true, readImage: async () => new Uint8Array() });\n    // @ts-expect-error Timestamp remains required and numeric.\n    buildCodexClipboardImageRelativePath(\"1\");\n    void [pending, facade, native, injected, sync];\n}\nvoid contracts;\n\n"
    ],
    [
        "workspace-dispatch",
        "import { createWorkspaceCreationDispatch, createWorkspaceRemovalDispatch } from \"./dist/application/workspace/dispatch.js\";\nimport type { WorkspaceCreationDispatchPorts, WorkspaceRemovalDispatchPorts } from \"./dist/ports/workspace/dispatch.js\";\nimport type { WorktreeResult } from \"./dist/domain/workspace/creation-result.js\";\nimport type { RemoveResult } from \"./dist/domain/workspace/removal-result.js\";\n\nfunction contracts(create: WorkspaceCreationDispatchPorts, remove: WorkspaceRemovalDispatchPorts<object, string>) {\n    const made: WorktreeResult = createWorkspaceCreationDispatch(create).createWorkspace(\"source\", \"branch\");\n    const removed: RemoveResult = createWorkspaceRemovalDispatch(remove).removeWorkspace(\"source\", \"branch\", { force: true });\n    made.created.push({ name: \"repo\", branch: \"branch\", action: \"worktree-new\" }); removed.errors.push(\"mutable\");\n    // @ts-expect-error Required creation effects have no native defaults.\n    createWorkspaceCreationDispatch();\n    // @ts-expect-error Required removal effects have no native defaults.\n    createWorkspaceRemovalDispatch();\n    // @ts-expect-error Selected callee is required.\n    createWorkspaceCreationDispatch({ ...create, createMulti: undefined });\n    // @ts-expect-error Native identity observation stays synchronous.\n    createWorkspaceRemovalDispatch({ ...remove, destinationExists: async () => true });\n    // @ts-expect-error Branch must remain a string.\n    createWorkspaceCreationDispatch(create).createWorkspace(\"source\", 1);\n    // @ts-expect-error Admission remains synchronous.\n    const pending: Promise<RemoveResult> = createWorkspaceRemovalDispatch(remove).removeWorkspace(\"source\", \"branch\");\n    void pending;\n}\nvoid contracts;\n\n"
    ],
    [
        "workspace-repair-nested",
        "import { createNestedWorkspaceRepair } from \"./dist/application/workspace/repair-nested.js\";\nimport type { NestedWorkspaceRepairPorts } from \"./dist/ports/workspace/repair-nested.js\";\nimport type { WorkspaceRepairAuthority } from \"./dist/domain/workspace/repair-authority.js\";\nimport type { WorktreeRepoResult } from \"./dist/domain/workspace/creation-result.js\";\n\nfunction contracts(ports: NestedWorkspaceRepairPorts<WorkspaceRepairAuthority>) {\n    const repaired: WorktreeRepoResult[] = createNestedWorkspaceRepair(ports).repairWorkspace(\"source\", \"workspace\", \"branch\");\n    repaired.push({ name: \"mutable\", branch: \"branch\", action: \"worktree-new\" });\n    // @ts-expect-error No production native defaults.\n    createNestedWorkspaceRepair();\n    // @ts-expect-error Required source authority cannot be missing.\n    createNestedWorkspaceRepair({ ...ports, captureNestedRepositoryIdentity: undefined });\n    // @ts-expect-error Inventory remains synchronous.\n    createNestedWorkspaceRepair({ ...ports, scanUnifiedNestedRepositories: async () => [] });\n    // @ts-expect-error Public repair remains synchronous.\n    const pending: Promise<WorktreeRepoResult[]> = createNestedWorkspaceRepair(ports).repairWorkspace(\"source\", \"workspace\", \"branch\");\n    void pending;\n}\nvoid contracts;\n"
    ],
    [
        "workspace-repair-root",
        "import { createRootWorkspaceRepair } from \"./dist/application/workspace/repair-root.js\";\nimport type { RootWorkspaceRepairPorts } from \"./dist/ports/workspace/repair-root.js\";\nimport type { WorkspaceRepairAuthority } from \"./dist/domain/workspace/repair-authority.js\";\n\nfunction contracts(ports: RootWorkspaceRepairPorts<WorkspaceRepairAuthority>) {\n    const result: boolean = createRootWorkspaceRepair(ports).handleWorkspaceRootOwnership(\"workspace\", \"source\", \"branch\", \"inspect\");\n    // @ts-expect-error Recovery cannot select production defaults.\n    createRootWorkspaceRepair();\n    // @ts-expect-error Exact publication/rollback capability is required.\n    createRootWorkspaceRepair({ ...ports, normalizeWorktreeMetadataFile: undefined });\n    // @ts-expect-error Native observation remains synchronous.\n    createRootWorkspaceRepair({ ...ports, pathExistsStrict: async () => false });\n    // @ts-expect-error Inspection does not return a Promise.\n    const pending: Promise<boolean> = result;\n    // @ts-expect-error Modes retain their existing exact values.\n    createRootWorkspaceRepair(ports).handleWorkspaceRootOwnership(\"workspace\", \"source\", \"branch\", \"force\");\n    void pending;\n}\nvoid contracts;\n"
    ],
    [
        "workspace-repair-broken",
        "import { createBrokenWorkspaceRepair } from \"./dist/application/workspace/repair-broken.js\";\nimport type { BrokenWorkspaceRepairPorts } from \"./dist/ports/workspace/repair-broken.js\";\nimport type { WorkspaceRepairAuthority } from \"./dist/domain/workspace/repair-authority.js\";\nimport type { WorktreeRepoResult } from \"./dist/domain/workspace/creation-result.js\";\n\nfunction contracts(ports: BrokenWorkspaceRepairPorts<WorkspaceRepairAuthority>) {\n    const result: WorktreeRepoResult | null = createBrokenWorkspaceRepair(ports).fixBrokenWorktreeSanitized(\"source\", \"workspace\", \"repo\", \"branch\", true, {});\n    if (result) result.name = \"mutable\";\n    // @ts-expect-error No ambient native defaults.\n    createBrokenWorkspaceRepair();\n    // @ts-expect-error Compensation capability is required.\n    createBrokenWorkspaceRepair({ ...ports, rollbackQuarantinedPath: undefined });\n    // @ts-expect-error Preserved-content observation is synchronous.\n    createBrokenWorkspaceRepair({ ...ports, readDirectoryEntries: async () => [] });\n    // @ts-expect-error Confirmation remains boolean.\n    createBrokenWorkspaceRepair(ports).fixBrokenWorktreeSanitized(\"source\", \"workspace\", \"repo\", \"branch\", \"yes\", {});\n    // @ts-expect-error Repair retains its synchronous result.\n    const pending: Promise<WorktreeRepoResult | null> = result;\n    void pending;\n}\nvoid contracts;\n"
    ],
    [
        "broker-observations",
        "import { readFileSync } from \"node:fs\";\nimport { resolve } from \"node:path\";\nimport type { BrokerServicePorts, LifecyclePreviewPorts, MetadataObservationPorts, ProviderPlanObservation } from \"./dist/packages/device-lab/dist/device-lab/ports/broker-observation.js\";\nimport type { LifecyclePreviewRequest } from \"./dist/packages/device-lab/dist/device-lab/domain/broker-observation-command-plan.js\";\n\nfunction requiredSynchronousContracts(metadata: MetadataObservationPorts,\n    service: BrokerServicePorts<object, \"status\", { supported: boolean; definitionPath: string | null }, { ownerId: string } | null, object, { mode: string; provider: string }, object>,\n    preview: LifecyclePreviewPorts<LifecyclePreviewRequest, object, unknown, unknown, ProviderPlanObservation, { ok: true; port: number } | { ok: false }>) {\n    const metadataCopy: MetadataObservationPorts = { ...metadata,\n        // @ts-expect-error A metadata query cannot return an asynchronous observation.\n        read: async () => [],\n    };\n    const serviceCopy: typeof service = { ...service,\n        // @ts-expect-error A status query must be synchronous and have required result facts.\n        query: async () => ({ mode: \"observed\", provider: \"service\" }),\n    };\n    const previewCopy: typeof preview = { ...preview,\n        // @ts-expect-error Native provider intent evidence cannot be a Promise.\n        existingPlan: async () => ({ mode: \"intent\", provider: \"native\" }),\n    };\n    const { read: omitted, ...incomplete } = metadata; void omitted;\n    // @ts-expect-error There is no default owner state reader.\n    const missing: MetadataObservationPorts = incomplete;\n    // @ts-expect-error There is no arbitrary native process executor in preview.\n    preview.run({ executable: \"provider\", args: [] });\n    void [metadataCopy, serviceCopy, previewCopy, missing];\n}\nvoid requiredSynchronousContracts;\n\n"
    ],
    [
        "codex-state-ownership",
        "import { createCodexStateOwnershipMigration } from \"./dist/application/credentials/codex-state-ownership.js\";\nimport type { CodexStateOwnershipPorts } from \"./dist/ports/credentials/codex-state-ownership.js\";\nimport type { CodexStatePrincipal, PreviousCodexStateContainer } from \"./dist/domain/credentials/codex-state-ownership.js\";\nimport type * as Native from \"./dist/codex-state-ownership.js\";\nfunction contracts(ports: CodexStateOwnershipPorts, previous: PreviousCodexStateContainer, principal: CodexStatePrincipal, native: typeof Native) {\n    const app = createCodexStateOwnershipMigration(ports);\n    const done: undefined = app.run(previous, \"image\", principal);\n    const publicDone: void = native.prepareCodexStateOwnership(previous, \"image\", principal);\n    const optionalUid: number | undefined = ports.effectiveUid();\n    // @ts-expect-error Factory requires explicit capabilities.\n    createCodexStateOwnershipMigration();\n    // @ts-expect-error Missing managed root.\n    createCodexStateOwnershipMigration({ ...ports, managedRoot: undefined });\n    // @ts-expect-error Missing native effect.\n    createCodexStateOwnershipMigration({ ...ports, migrate: undefined });\n    // @ts-expect-error Noncallable observation.\n    createCodexStateOwnershipMigration({ ...ports, directory: 0 });\n    // @ts-expect-error No native argv contract enters the core.\n    ports.run([\"docker\", \"chown\"]);\n    // @ts-expect-error Host facts are synchronous.\n    createCodexStateOwnershipMigration({ ...ports, runtime: async () => ports.runtime() });\n    // @ts-expect-error Optional principal facts are synchronous.\n    createCodexStateOwnershipMigration({ ...ports, effectiveUid: async () => 1000 });\n    // @ts-expect-error Directory observations cannot be promises.\n    createCodexStateOwnershipMigration({ ...ports, directory: async path => ports.directory(path) });\n    // @ts-expect-error Old account observation must be a string.\n    createCodexStateOwnershipMigration({ ...ports, previousAccount: () => 1000 });\n    // @ts-expect-error Effect must complete synchronously.\n    createCodexStateOwnershipMigration({ ...ports, migrate: async () => undefined });\n    // @ts-expect-error Permissive void does not prove completion.\n    createCodexStateOwnershipMigration({ ...ports, migrate: (): void => {} });\n    // @ts-expect-error Native effect cannot return an outcome.\n    createCodexStateOwnershipMigration({ ...ports, migrate: () => \"okay\" });\n    // @ts-expect-error Receipt identities are the original strings, not numeric coercions.\n    ports.migrate(\"root\", \"image\", \"1\", \"2\", \"3\", \"4\", { dev: 1, ino: \"2\" });\n    // @ts-expect-error Identity is required.\n    app.run(previous, \"image\");\n    // @ts-expect-error Image input must be a string.\n    app.run(previous, 1, principal);\n    // @ts-expect-error Source proof remains a Boolean callback.\n    app.run(previous, \"image\", principal, undefined, async () => true);\n    // @ts-expect-error Application is synchronous.\n    const pending: Promise<void> = app.run(previous, \"image\", principal);\n    // @ts-expect-error Existing public void cannot become strict undefined.\n    const stricter: undefined = native.prepareCodexStateOwnership(previous, \"image\", principal);\n    void [done, publicDone, optionalUid, pending, stricter];\n}\nvoid contracts;\n"
    ],
    [
        "lab-state-ownership",
        "import type { SpawnSyncReturns } from \"node:child_process\";\nimport { createLabStateOwnershipPreparation } from \"./dist/application/container/lab-state-ownership.js\";\nimport type { LabOwnershipHelperScope, LabStateCommandObservation, LabStateOwnershipObservation, LabStatePrincipal } from \"./dist/domain/container/lab-state-ownership.js\";\nimport type { LabStateOwnershipPorts } from \"./dist/ports/container/lab-state-ownership.js\";\nimport { prepareLabStateOwnership } from \"./dist/lab-state-ownership.js\";\nimport type { ContainerIdentity } from \"./dist/container-identity.js\";\n\nfunction compileContracts(ports: LabStateOwnershipPorts, scope: LabOwnershipHelperScope, principal: LabStatePrincipal, native: SpawnSyncReturns<string>, full: ContainerIdentity) {\n    const app = createLabStateOwnershipPreparation(ports);\n    const result: undefined = app.run(\"volume\", \"image\", principal, \"old\");\n    const publicResult: void = prepareLabStateOwnership(\"volume\", \"image\", full);\n    const listed: LabStateCommandObservation = ports.listVolumeNames();\n    const applied: LabStateOwnershipObservation = ports.applyOwnership(scope, \"volume\", \"image\", principal, { kind: \"verify\" });\n    createLabStateOwnershipPreparation({ ...ports, listVolumeNames: () => native, applyOwnership: () => native });\n    void [result, publicResult, listed, applied];\n    // @ts-expect-error Explicit ports are required.\n    createLabStateOwnershipPreparation();\n    // @ts-expect-error Undefined supplies no native defaults.\n    createLabStateOwnershipPreparation(undefined);\n    // @ts-expect-error Normalization must be synchronous.\n    createLabStateOwnershipPreparation({ ...ports, normalizeImageId: async () => \"image\" });\n    // @ts-expect-error Listing must be synchronous.\n    createLabStateOwnershipPreparation({ ...ports, listVolumeNames: async () => native });\n    // @ts-expect-error Users must be synchronous.\n    createLabStateOwnershipPreparation({ ...ports, observeVolumeUsers: async () => native });\n    // @ts-expect-error Scope capture must be synchronous.\n    createLabStateOwnershipPreparation({ ...ports, captureHelperScope: async () => scope });\n    // @ts-expect-error Account observation must be synchronous.\n    createLabStateOwnershipPreparation({ ...ports, observePreviousAccount: async () => native });\n    // @ts-expect-error Ownership returns consumed synchronous facts, not a Promise.\n    createLabStateOwnershipPreparation({ ...ports, applyOwnership: async () => ({ status: 0 }) });\n    // @ts-expect-error The consumed final result cannot be discarded as void.\n    createLabStateOwnershipPreparation({ ...ports, applyOwnership: (): void => {} });\n    // @ts-expect-error The consumed final result cannot be discarded as undefined.\n    createLabStateOwnershipPreparation({ ...ports, applyOwnership: () => undefined });\n    // @ts-expect-error Required primitive cannot be omitted.\n    createLabStateOwnershipPreparation({ normalizeImageId: ports.normalizeImageId, listVolumeNames: ports.listVolumeNames, observeVolumeUsers: ports.observeVolumeUsers, captureHelperScope: ports.captureHelperScope, observePreviousAccount: ports.observePreviousAccount });\n    // @ts-expect-error Required primitive must be callable.\n    createLabStateOwnershipPreparation({ ...ports, applyOwnership: {} });\n    // @ts-expect-error Scope cannot be fabricated structurally from argv.\n    createLabStateOwnershipPreparation({ ...ports, captureHelperScope: () => [\"run\", \"--rm\"] });\n    // @ts-expect-error Scope requires trusted native evidence.\n    ports.observePreviousAccount({}, \"image\");\n    // @ts-expect-error A string is not a scope.\n    ports.observePreviousAccount(\"run\", \"image\");\n    // @ts-expect-error Observation status remains number or null.\n    createLabStateOwnershipPreparation({ ...ports, listVolumeNames: () => ({ status: \"0\", stdout: \"volume\" }) });\n    // @ts-expect-error Command stdout is required.\n    createLabStateOwnershipPreparation({ ...ports, listVolumeNames: () => ({ status: 0 }) });\n    // @ts-expect-error Final status is required.\n    createLabStateOwnershipPreparation({ ...ports, applyOwnership: () => ({ error: undefined }) });\n    // @ts-expect-error Final status remains number or null.\n    createLabStateOwnershipPreparation({ ...ports, applyOwnership: () => ({ status: undefined }) });\n    // @ts-expect-error Generic shell/argv is not an ownership intent.\n    ports.applyOwnership(scope, \"volume\", \"image\", principal, { kind: \"exec\", argv: [\"rm\"] });\n    // @ts-expect-error Migration needs both proven prior numeric principals.\n    ports.applyOwnership(scope, \"volume\", \"image\", principal, { kind: \"migrate\", oldUid: 1 });\n    // @ts-expect-error Principals are numeric.\n    app.run(\"volume\", \"image\", { uid: \"1\", gid: 2 });\n    // @ts-expect-error Preparation requires image and principal.\n    app.run(\"volume\");\n    // @ts-expect-error Preparation is synchronous.\n    const promise: Promise<undefined> = app.run(\"volume\", \"image\", principal);\n    // @ts-expect-error Successful preparation has no boolean result.\n    const success: boolean = app.run(\"volume\", \"image\", principal);\n    // @ts-expect-error Public full ContainerIdentity contract remains required.\n    prepareLabStateOwnership(\"volume\", \"image\", principal);\n    // @ts-expect-error Public return remains void.\n    const publicPromise: Promise<void> = prepareLabStateOwnership(\"volume\", \"image\", full);\n    void [promise, success, publicPromise];\n}\nvoid compileContracts;\n\n"
    ],
    [
        "clipboard-snapshot",
        "import { createClipboardSnapshotReader, createClipboardSnapshotState, invalidateClipboardCache } from \"./dist/application/clipboard/snapshot.js\";\nimport type { ClipboardSnapshot, ClipboardSnapshotState } from \"./dist/domain/clipboard/snapshot.js\";\nimport type { ClipboardSnapshotPorts } from \"./dist/ports/clipboard/snapshot.js\";\n\ntype Bytes = { readonly length: number; readonly opaque: unique symbol };\ntype Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\ntype Assert<T extends true> = T;\ntype State = Assert<Equal<ReturnType<typeof createClipboardSnapshotState<Bytes>>, ClipboardSnapshotState<Bytes>>>;\ntype NoByteMethods = Assert<Equal<keyof import(\"./dist/domain/clipboard/snapshot.js\").ClipboardBytes, \"length\">>;\nconst contracts: [State, NoByteMethods] = [true, true]; void contracts;\nfunction compileContracts(ports: ClipboardSnapshotPorts<Bytes>, bytes: Bytes) {\n    const state = createClipboardSnapshotState<Bytes>(); const read = createClipboardSnapshotReader(ports, state);\n    const promise: Promise<ClipboardSnapshot<Bytes>> = read(\"linux-wayland\", true);\n    const effect: undefined = invalidateClipboardCache(state);\n    const opaque: Bytes | null = state.cache?.imagePng ?? bytes;\n    void [promise, effect, opaque];\n    // @ts-expect-error State is explicit and shared by the composition root.\n    createClipboardSnapshotReader(ports);\n    // @ts-expect-error Native marker reads are asynchronous.\n    createClipboardSnapshotReader({ ...ports, readChangeMarker: () => \"marker\" }, state);\n    // @ts-expect-error A complete native snapshot workflow cannot replace target facts.\n    createClipboardSnapshotReader({ ...ports, readTargets: async () => [] }, state);\n    // @ts-expect-error File-copy effects retain synchronous byte results.\n    createClipboardSnapshotReader({ ...ports, copyImageFile: async () => bytes }, state);\n    // @ts-expect-error Concrete bytes stay opaque and cannot silently become strings.\n    createClipboardSnapshotReader({ ...ports, readText: () => \"text\" }, state);\n    // @ts-expect-error Native read failures must supply the concrete error factory.\n    createClipboardSnapshotReader({ ...ports, createReadError: undefined }, state);\n    // @ts-expect-error Snapshot platform is a closed public union.\n    read(\"freebsd\");\n    // @ts-expect-error No force flag string normalization occurs.\n    read(\"darwin\", \"true\");\n    // @ts-expect-error Cached-read API remains asynchronous.\n    const synchronous: ClipboardSnapshot<Bytes> = read(\"windows\");\n    // @ts-expect-error Cache invalidation must finish synchronously.\n    const asynchronous: Promise<undefined> = invalidateClipboardCache(state);\n    void [synchronous, asynchronous];\n}\nvoid compileContracts;\n"
    ],
    [
        "clipboard-write",
        "import { createClipboardTextWriter } from \"./dist/application/clipboard/text-write.js\";\nimport { createClipboardSnapshotState } from \"./dist/application/clipboard/snapshot.js\";\nimport type { ClipboardTextWritePorts } from \"./dist/ports/clipboard/text-write.js\";\nimport type { writeClipboardText as publicWrite } from \"./dist/clipboard-server.js\";\n\ntype Bytes = { readonly length: number; readonly opaque: \"bytes\" };\ntype Prepared = { readonly opaque: \"prepared\" }; type Writer = { readonly opaque: \"writer\" }; type Timer = { readonly opaque: \"timer\" };\ntype Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\ntype Assert<T extends true> = T;\ntype PublicShape = Assert<Equal<typeof publicWrite, (text: string, plat: import(\"./dist/domain/clipboard/snapshot.js\").ClipboardPlatform) => Promise<void>>>;\nconst publicShape: PublicShape = true; void publicShape;\nfunction compileContracts(ports: ClipboardTextWritePorts<Bytes, Prepared, Writer, Timer>) {\n    const state = createClipboardSnapshotState<Bytes>(); const write = createClipboardTextWriter(ports, state);\n    const result: Promise<void> = write(\"text\", \"darwin\"); const clear: undefined = ports.cancelReadTimer({ opaque: \"timer\" });\n    void [result, clear];\n    // @ts-expect-error Shared state must be supplied.\n    createClipboardTextWriter(ports);\n    // @ts-expect-error Text remains a required string.\n    write(3, \"windows\");\n    // @ts-expect-error Platform remains required.\n    write(\"text\");\n    // @ts-expect-error Supported platform union is closed.\n    write(\"text\", \"freebsd\");\n    // @ts-expect-error Launching the opaque writer is synchronous.\n    createClipboardTextWriter({ ...ports, launchWriter: async () => ({ opaque: \"writer\" } as const) }, state);\n    // @ts-expect-error Timer cancellation cannot return void.\n    createClipboardTextWriter({ ...ports, cancelReadTimer: (): void => {} }, state);\n    // @ts-expect-error Timer cancellation cannot return a Promise.\n    createClipboardTextWriter({ ...ports, cancelReadTimer: async () => undefined }, state);\n    // @ts-expect-error Writer registration cannot be asynchronous.\n    createClipboardTextWriter({ ...ports, onWriterError: async () => undefined }, state);\n    // @ts-expect-error Input registration cannot be asynchronous.\n    createClipboardTextWriter({ ...ports, onInputError: async () => undefined }, state);\n    // @ts-expect-error Writer termination cannot be asynchronous.\n    createClipboardTextWriter({ ...ports, killWriter: async () => undefined }, state);\n    // @ts-expect-error End input is an ignored synchronous effect, never an adoption boundary.\n    createClipboardTextWriter({ ...ports, endInput: async () => undefined }, state);\n    // @ts-expect-error Opaque timers do not accept native numeric IDs.\n    ports.cancelReadTimer(3);\n    // @ts-expect-error Writer and preparation receipts cannot be interchanged.\n    ports.endInput({ opaque: \"prepared\" }, { opaque: \"writer\" });\n    // @ts-expect-error Write returns the original named async Promise rather than void.\n    const synchronous: void = write(\"text\", \"linux-x11\"); void synchronous;\n}\nvoid compileContracts;\n"
    ],
    [
        "clipboard-lifecycle",
        "import { createClipboardServerLifecycle } from \"./dist/application/clipboard/server-lifecycle.js\";\nimport type { ClipboardServerLifecyclePorts } from \"./dist/ports/clipboard/server-lifecycle.js\";\nimport type { ensureClipboardServer, stopClipboardServerIfLast, retireClipboardServerFromPortFile } from \"./dist/clipboard-server.js\";\n\ntype Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\ntype Assert<T extends true> = T;\ntype PublicEnsure = Assert<Equal<typeof ensureClipboardServer, () => Promise<number>>>;\ntype PublicStop = Assert<Equal<typeof stopClipboardServerIfLast, (hasOtherActiveSessions: boolean) => void>>;\ntype PublicRetire = Assert<Equal<typeof retireClipboardServerFromPortFile, (portFile: string) => void>>;\nconst publicShapes: [PublicEnsure, PublicStop, PublicRetire] = [true, true, true]; void publicShapes;\nfunction compileContracts(ports: ClipboardServerLifecyclePorts<{ lock: true }, { child: true }>) {\n    const app = createClipboardServerLifecycle(ports, \"literal-version\");\n    const ready: Promise<number> = app.ensureClipboardServer(); const stop: void = app.stopClipboardServerIfLast(false);\n    const retire: void = app.retireClipboardServerFromPortFile(\"raw-port\"); const release: undefined = ports.releaseStartupLock({ lock: true });\n    void [ready, stop, retire, release];\n    // @ts-expect-error Server version is supplied at composition import time.\n    createClipboardServerLifecycle(ports);\n    // @ts-expect-error Release is an ignored synchronous effect, not void.\n    createClipboardServerLifecycle({ ...ports, releaseStartupLock: (): void => {} }, \"version\");\n    // @ts-expect-error Release cannot adopt a Promise.\n    createClipboardServerLifecycle({ ...ports, releaseStartupLock: async () => undefined }, \"version\");\n    // @ts-expect-error Unref cannot adopt a Promise.\n    createClipboardServerLifecycle({ ...ports, unrefDaemon: async () => undefined }, \"version\");\n    // @ts-expect-error Warning remains a synchronous ignored effect.\n    createClipboardServerLifecycle({ ...ports, warnUpgradeDeferred: async () => undefined }, \"version\");\n    // @ts-expect-error Native file observation is synchronous.\n    createClipboardServerLifecycle({ ...ports, readPortFile: async () => null }, \"version\");\n    // @ts-expect-error Lock observations are synchronous.\n    createClipboardServerLifecycle({ ...ports, tryAcquireStartupLock: async () => null }, \"version\");\n    // @ts-expect-error Health is asynchronous and authenticated.\n    createClipboardServerLifecycle({ ...ports, checkHealth: () => ({ alive: true }) }, \"version\");\n    // @ts-expect-error Health requires token and address.\n    ports.checkHealth(123);\n    // @ts-expect-error Daemon launch cannot hide an asynchronous whole workflow.\n    createClipboardServerLifecycle({ ...ports, launchDaemon: async () => ({ child: true } as const) }, \"version\");\n    // @ts-expect-error Stop must receive an explicit caller observation.\n    app.stopClipboardServerIfLast();\n    // @ts-expect-error No string truth-value coercion occurs.\n    app.stopClipboardServerIfLast(\"false\");\n    // @ts-expect-error Retirement preserves a string explicit path.\n    app.retireClipboardServerFromPortFile(null);\n    // @ts-expect-error Retirement does not return a Promise.\n    const adopted: Promise<void> = app.retireClipboardServerFromPortFile(\"path\"); void adopted;\n}\nvoid compileContracts;\n"
    ]
];

async function verifyReviewedWorkspaceDelivery(payload, fixtures) {
    const {default: assert} = await import("node:assert/strict");
    const cp = (await import("node:child_process")).default;
    const {syncBuiltinESMExports} = await import("node:module");
    const {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} = await import("node:fs");
    const {basename, dirname, join, resolve} = await import("node:path");
    const {pathToFileURL} = await import("node:url");
    mkdirSync(fixtures, {recursive:true});
    const nativeSpawnSync = cp.spawnSync;
    for (const name of ["spawn", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[name] = () => { throw new Error("Unallocated workspace native execution"); };
    cp.spawnSync = (command, args, options) => {
        assert.equal(command, "git");
        if (typeof options.cwd === "string") {
            assert.ok(resolve(options.cwd).startsWith(resolve(fixtures) + "/"), "Git must remain in private fixture repositories");
        } else {
            assert.deepEqual([args[0], ...args.slice(2)], ["--git-dir", "worktree", "list", "--porcelain"]);
            assert.equal(typeof args[1], "string");
            assert.ok(resolve(args[1]).startsWith(resolve(fixtures) + "/"), "Git registry must remain inside private fixtures");
        }
        return nativeSpawnSync(command, args, {...options, timeout:20000});
    };
    syncBuiltinESMExports();
    const spawnSync = (...args) => cp.spawnSync(...args);
    assert.equal(existsSync(join(payload, 'node_modules')), false);
    mkdirSync(fixtures, { recursive: true });
    const module = name => import(pathToFileURL(join(payload, 'dist', `${name}.js`)).href);
    const facade = await module('worktree');
    const dispatch = await module('application/workspace/dispatch');
    const nestedCore = await module('application/workspace/repair-nested');
    const rootCore = await module('application/workspace/repair-root');
    const brokenCore = await module('application/workspace/repair-broken');


    function git(repository, args) {
        assert.ok(resolve(repository).startsWith(`${resolve(fixtures)}/`));
        const result = spawnSync('git', args, { cwd: repository, env: process.env, encoding: 'utf8' });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, `${repository}: git ${args.join(' ')}: ${result.stderr}`);
        return result.stdout;
    }
    function init(repository) {
        mkdirSync(repository, { recursive: true });
        git(repository, ['init', '--initial-branch=main']);
        git(repository, ['config', 'user.name', 'Persistent QA']);
        git(repository, ['config', 'user.email', 'qa@example.invalid']);
        git(repository, ['config', 'commit.gpgsign', 'false']);
        writeFileSync(join(repository, 'tracked.txt'), 'committed bytes\n');
        writeFileSync(join(repository, '.gitignore'), 'ignored.bin\n');
        git(repository, ['add', '.']);
        git(repository, ['commit', '-m', 'initial']);
    }
    function metadata(workspace) {
        const text = readFileSync(join(workspace, '.git'), 'utf8');
        const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
        assert.ok(match, text);
        return resolve(workspace, match[1].trim());
    }
    // Compile-time closure is exercised separately; these are actual compiled core calls.
    const created = { workspacePath: '/workspace', created: [], copied: [] };
    let mode = true;
    const creationTrace = [];
    const creation = dispatch.createWorkspaceCreationDispatch({
        validateBranch(value) { creationTrace.push(['validate', value]); },
        resolveSource(value) { creationTrace.push(['resolve', value]); return '/source'; },
        workspacePath() { return '/workspace'; },
        enclosingRepository() { return null; }, warnEnclosing() { throw Error('unused warning'); },
        sourceHasGitMetadata() { return mode; },
        createUnified(request) { creationTrace.push(['unified', request]); return created; },
        createMulti(request) { creationTrace.push(['multi', request]); return created; },
    });
    assert.equal(creation.createWorkspace('raw', 'branch'), created);
    mode = false;
    assert.equal(creation.createWorkspace('raw', 'branch'), created);
    assert.equal(creationTrace[2][0], 'unified');
    assert.equal(creationTrace[5][0], 'multi');
    const removalIdentity = {};
    const removalOptions = { force: true };
    const removed = { removed: ['root'], errors: [] };
    const removal = dispatch.createWorkspaceRemovalDispatch({
        validateBranch() {}, resolveSource() { return '/source'; }, workspacePath() { return '/workspace'; },
        destinationExists() { return true; }, assertRequestedBranch() {},
        observeUnreachableRepositories(_path, output) { output.push('/unreachable'); },
        observePathContent(path) { return { path, bytes: 'preserve' }; },
        formatUnmanagedRefusal(path, content) { assert.equal(path, content.path); return `preserve ${path}`; },
        captureWorkspaceIdentity() { return removalIdentity; }, sourceHasGitMetadata() { return true; },
        removeUnified(request, identity) { assert.equal(request.options, removalOptions); assert.equal(identity, removalIdentity); return removed; },
        removeMulti() { throw Error('unused multi'); },
    });
    assert.deepEqual(removal.removeWorkspace('raw', 'branch'), { removed: [], errors: ['preserve /unreachable'] });
    assert.equal(removal.removeWorkspace('raw', 'branch', removalOptions), removed);
    const nestedTrace = [];
    assert.deepEqual(nestedCore.createNestedWorkspaceRepair({
        resolve(value) { nestedTrace.push(value); return value; }, hasGitMetadata() { return false; },
    }).repairWorkspace('source', 'workspace', 'branch'), []);
    assert.deepEqual(nestedTrace, ['source']);
    const rootReasons = [];
    assert.equal(rootCore.createRootWorkspaceRepair({ isValidWorktree() { return true; } })
        .handleWorkspaceRootOwnership('workspace', 'source', 'branch', 'confirmed', reason => rootReasons.push(reason)), false);
    assert.deepEqual(rootReasons, ['workspace registration is already valid']);
    assert.throws(() => brokenCore.createBrokenWorkspaceRepair({}).fixBrokenWorktreeSanitized('source', 'workspace', 'repo', 'branch', false, {}), /Explicit confirmation/);
    assert.equal(brokenCore.createBrokenWorkspaceRepair({
        resolve(value) { return value; }, assertWorkspaceRootOwnership() {}, primarySourceRepositoryForWorktree() { return null; },
        scanUnifiedNestedRepositories() { return []; },
    }).fixBrokenWorktreeSanitized('source', 'workspace', 'absent', 'branch', true, {}), null);
    console.log('PASS compiled cores: dispatch unified/multi/refusal/strict force/opaque identity; nested early return; root valid-registration refusal; broken confirmation/missing-repository');

    const source = join(fixtures, 'source');
    const child = join(source, 'frontend');
    init(source); init(child);
    const branch = 'qa/shipping';
    const sourceHead = git(source, ['rev-parse', 'HEAD']);
    const childHead = git(child, ['rev-parse', 'HEAD']);
    const sourceConfig = readFileSync(join(source, '.git/config'));
    const childConfig = readFileSync(join(child, '.git/config'));
    assert.throws(() => facade.createWorkspace(source, '../escape'), /cannot contain/);
    assert.throws(() => facade.removeWorkspace(source, '-bad'), /cannot start/);
    const result = facade.createWorkspace(source, branch);
    assert.equal(result.workspacePath, facade.getWorkspacePath(source, branch));
    assert.deepEqual(result.created.map(entry => entry.name), [basename(source), 'frontend']);
    assert.deepEqual(result.copied, []);
    const workspace = result.workspacePath;
    const destination = join(workspace, 'frontend');
    assert.equal(facade.isValidWorktree(workspace, source), true);
    assert.equal(facade.isValidWorktree(destination, child), true);

    git(child, ['worktree', 'remove', '--force', destination]);
    mkdirSync(destination);
    assert.deepEqual(facade.repairWorkspace(source, workspace, branch).map(entry => entry.name), ['frontend']);
    assert.equal(facade.isValidWorktree(destination, child), true);
    console.log('PASS public facade createWorkspace and repairWorkspace: private real-Git unified root/nested addition and empty destination repair');

    let management = metadata(workspace);
    writeFileSync(join(management, 'gitdir'), `${join(fixtures, 'unreachable-root', '.git')}\n`);
    assert.equal(facade.repairWorkspaceRootOwnership(workspace, source, branch), true);
    assert.equal(readFileSync(join(management, 'gitdir'), 'utf8').trim(), join(workspace, '.git'));
    writeFileSync(join(workspace, 'tracked.txt'), 'preserved tracked changes\n');
    writeFileSync(join(workspace, 'untracked.txt'), 'preserved untracked\n');
    writeFileSync(join(workspace, 'ignored.bin'), 'preserved ignored\n');
    const preserved = ['tracked.txt', 'untracked.txt', 'ignored.bin'].map(name => [name, readFileSync(join(workspace, name))]);
    const oldLink = readFileSync(join(workspace, '.git'));
    rmSync(management, { recursive: true, force: true });
    assert.equal(facade.canRecreateMissingWorkspaceRootRegistration(workspace, source, branch), true);
    assert.equal(facade.repairWorkspaceRootOwnership(workspace, source, branch), false);
    assert.deepEqual(readFileSync(join(workspace, '.git')), oldLink);
    const failureReasons = [];
    assert.equal(facade.repairWorkspaceRootOwnership(workspace, source, branch, {
        confirmedMissingRegistration: true, reportFailure: reason => failureReasons.push(reason),
    }), true, failureReasons.join('\n'));
    for (const [name, bytes] of preserved) assert.deepEqual(readFileSync(join(workspace, name)), bytes);
    assert.equal(facade.isValidWorktree(workspace, source), true);
    management = metadata(workspace);
    assert.equal(readFileSync(join(management, 'gitdir'), 'utf8').trim(), join(workspace, '.git'));
    console.log('PASS public root repair: stale backpointer, missing-registration inspection/decline/confirmed publication, tracked/untracked/ignored bytes preserved');

    git(child, ['worktree', 'remove', '--force', destination]); mkdirSync(destination);
    writeFileSync(join(destination, 'wip.txt'), 'preserved broken content\n');
    assert.throws(() => facade.fixBrokenWorktree(source, workspace, 'frontend', branch), /Explicit confirmation/);
    assert.equal(readFileSync(join(destination, 'wip.txt'), 'utf8'), 'preserved broken content\n');
    assert.equal(facade.fixBrokenWorktree(source, workspace, 'frontend', branch, true).name, 'frontend');
    assert.equal(facade.isValidWorktree(destination, child), true);
    assert.equal(readFileSync(join(destination, 'wip.txt'), 'utf8'), 'preserved broken content\n');
    git(child, ['worktree', 'remove', '--force', destination]); mkdirSync(destination);
    writeFileSync(join(destination, 'tracked.txt'), 'conflicting broken bytes\n');
    writeFileSync(join(destination, 'wip.txt'), 'preserved conflict marker\n');
    assert.throws(() => facade.fixBrokenWorktree(source, workspace, 'frontend', branch, true), /conflict/i);
    assert.equal(readFileSync(join(destination, 'tracked.txt'), 'utf8'), 'conflicting broken bytes\n');
    assert.equal(readFileSync(join(destination, 'wip.txt'), 'utf8'), 'preserved conflict marker\n');
    rmSync(join(destination, 'tracked.txt'));
    assert.equal(facade.fixBrokenWorktree(source, workspace, 'frontend', branch, true).name, 'frontend');
    git(child, ['worktree', 'remove', '--force', destination]); mkdirSync(destination);
    writeFileSync(join(destination, 'late.txt'), 'committed replacement\n');
    const sentinel = new Error('private late-cleanup sentinel');
    let cleanupReads = 0;
    let backupPath;
    assert.throws(() => facade.fixBrokenWorktree(source, workspace, 'frontend', branch, true, {
        get removeMergedBackup() {
            cleanupReads += 1;
            return function(path) { assert.equal(this, undefined); backupPath = path; throw sentinel; };
        },
    }), value => value === sentinel);
    assert.equal(cleanupReads, 1);
    assert.equal(facade.isValidWorktree(destination, child), true);
    assert.equal(readFileSync(join(destination, 'late.txt'), 'utf8'), 'committed replacement\n');
    assert.ok(existsSync(backupPath));
    console.log('PASS public broken repair: confirmation refusal, preservation merge, conflict rollback, late single cleanup getter/bare callback; committed replacement survives late error');

    assert.deepEqual(facade.removeWorkspace(source, branch, { force: true }).errors, []);
    assert.equal(existsSync(workspace), false);
    assert.equal(git(source, ['rev-parse', 'HEAD']), sourceHead);
    assert.equal(git(child, ['rev-parse', 'HEAD']), childHead);
    assert.equal(git(source, ['rev-parse', `refs/heads/${branch}`]), sourceHead);
    assert.equal(git(child, ['rev-parse', `refs/heads/${branch}`]), childHead);
    assert.deepEqual(readFileSync(join(source, '.git/config')), sourceConfig);
    assert.deepEqual(readFileSync(join(child, '.git/config')), childConfig);
    console.log('PASS public removal: nested-before-root force removal; source HEAD, branch refs and Git config preserved');
}

async function verifyReviewedToolSessionDelivery(payload) {
    const { default: assert } = await import("node:assert/strict");
    const { default: cp } = await import("node:child_process");
    const { syncBuiltinESMExports } = await import("node:module");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { createHash } = await import("node:crypto");
    let nativeCalls = 0;
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
        cp[name] = () => { nativeCalls++; throw new Error("Unallocated tool-session native execution"); };
    }
    syncBuiltinESMExports();
    const module = name => import(pathToFileURL(join(payload, "dist", name + ".js")).href);
    const runtime = await module("container-runtime");
    const docker = await module("docker");
    const mountsCore = await module("application/container-launch-arguments");
    const launchCore = await module("application/tool-session/codex-launch");
    const launch = await module("codex-launch");
    const resumeCore = await module("application/tool-session/codex-resume-recovery");
    const resume = await module("codex-resume-recovery");
    const resumeRuntime = await module("codex-resume-recovery-runtime");
    const attachmentCore = await module("application/tool-session/codex-clipboard-image");
    const attachment = await module("codex-clipboard-image");
    assert.equal(nativeCalls, 0, "imports must not discover or launch a native runtime");
    let facts = { runtime: "docker", flavor: "docker-native", rootless: false, remote: false };
    const mountPorts = { readRuntimeInfo: () => facts, readRuntimeName: () => facts.runtime,
        readSelinuxRelabelMode: () => "force", observeSelinuxEnforcing: () => true,
        readContainerMarker: () => "docker", isVitestProcess: () => false,
        observeCurrentContainerMounts: () => [{ source: "/host", destination: "/client" }, { source: "/nested", destination: "/client/deep" }],
        captureHostJoin: () => join, readPodmanCgroups: () => "disabled" };
    const mounts = mountsCore.createContainerMountArguments(mountPorts);
    assert.deepEqual(mounts.bindMountArgs("/client/deep/file", "/target", { readonly: true }), ["-v", "/nested/file:/target:ro,Z"]);
    assert.deepEqual(mounts.bindMountArgs("/client-sibling/file", "/target"), ["-v", "/client-sibling/file:/target:Z"]);
    assert.deepEqual(mounts.bindMountArgs("volume", "/target"), ["-v", "volume:/target"]);
    const raw = Symbol("mount getter");
    assert.throws(() => mountsCore.createContainerMountArguments({ ...mountPorts, readRuntimeInfo() { throw raw; } }).runtimeExtraRunArgs(), value => value === raw);
    facts = { runtime: "podman", flavor: "podman-rootless", rootless: true, remote: false };
    assert.deepEqual(mounts.runtimeExtraRunArgs(), ["--cgroups=disabled", "--userns=keep-id:uid=1000,gid=1000"]);
    process.env.CCC_SELINUX_RELABEL = "force";
    process.env.CCC_PODMAN_CGROUPS = "disabled";
    runtime._setRuntimeInfoForTest(facts);
    assert.deepEqual(runtime.bindMountArgs("/private", "/target", { readonly: true }), ["-v", "/private:/target:ro,Z"]);
    assert.deepEqual(runtime.runtimeExtraRunArgs(), mounts.runtimeExtraRunArgs());
    const options = { containerName: "ccc-private", fullPath: "/private/project", projectMountPath: "/project",
        credentialMounts: [], claudeJsonFile: "/private/claude.json", miseVolumeName: "private-mise",
        codexPackagesVolumeName: "private-packages", pidsLimit: "300", imageName: "private-image" };
    const args = docker.buildDockerRunArgs(options);
    const launchArguments = mountsCore.createContainerLaunchArguments({ captureBindMountArgs: () => runtime.bindMountArgs,
        captureRuntimeExtraRunArgs: () => runtime.runtimeExtraRunArgs, readRuntimeInfo: () => facts,
        captureExistsSync: () => () => false, captureHostJoin: () => join, captureIdentityLabels: () => () => ({}),
        captureEntries: () => Object.entries, readCliVersion: () => "1.1.90", readProjectMountIdentityLabel: () => "unused",
        readDeviceLabMountIdentityLabel: () => "unused", readCodexPackagesVolumeName: () => "unused",
        readCodexPackagesContainerDir: () => "/home/ccc/.codex/packages", readBrokerAuthContainerFile: () => "unused",
        readClipboardFilesContainerDir: () => "unused" });
    assert.deepEqual(launchArguments.buildRunArgs(options), args, "compiled launch core and actual public facade share argv policy");
    assert.deepEqual(args.slice(0, 8), ["run", "-d", "--name", "ccc-private", "--hostname", "ccc-private", "--network", "host"]);
    assert.equal(args.at(-1), "private-image");
    assert.ok(args.includes("--userns=keep-id:uid=1000,gid=1000"));
    const launchTrace = [];
    const missing = { status: 1, stdout: "ccc-codex-daemon-missing\n", stderr: "", signal: null };
    const help = { status: 0, stdout: "Usage: codex app-server daemon start [OPTIONS]\n", stderr: "", signal: null };
    const ok = { status: 0, stdout: "", stderr: "", signal: null };
    const start = Object.freeze({ opaque: true });
    const coreLaunch = launchCore.createCodexLaunchPreparation({ probeDaemonExecutable: () => missing,
        prepareStart: () => start, probeDaemonStartHelp: selected => { assert.equal(selected, start); return help; },
        initializeDaemon: (selected, command) => { assert.equal(selected, start); launchTrace.push(command); return ok; },
        probeDaemonFallbackHelp: () => { throw new Error("Unexpected fallback"); } });
    assert.deepEqual(coreLaunch.prepare(["codex", "-c", "model=private"]), { ok: true, command: ["codex", "-c", "model=private"] });
    assert.deepEqual(launchTrace, [["-c", "model=private"]]);
    assert.equal(coreLaunch.prepare(["codex", "--profile", "private"]).ok, false);
    const calls = [];
    function launchRunner(command, args, options) {
        assert.equal(this, undefined); assert.equal(command, "private-runtime"); calls.push([args, options]);
        return [missing, help, ok][calls.length - 1];
    }
    assert.deepEqual(launch.prepareCodexLaunch("private-runtime", ["exec", "private"], ["codex", "-c=x"], launchRunner), { ok: true, command: ["codex", "-c=x"] });
    // Independently decoded c284 source template: native argv differs from the escaped source literal.
    assert.equal(createHash("sha256").update(calls[0][0].at(-1)).digest("hex"), "126f790982c790e08eaba30250a01083f7ca395a71de5e3b4c5323faa2b02d33");
    assert.deepEqual(calls[1][0], ["exec", "private", "codex", "app-server", "daemon", "start", "--help"]);
    assert.deepEqual(calls[2][0], ["exec", "private", "codex", "app-server", "daemon", "start", "-c=x"]);
    assert.equal(calls[0][1], calls[1][1]); assert.equal(calls[2][1].timeout, 60000);
    let defaultLaunchCalls = 0;
    cp.spawnSync = (command, args) => { assert.equal(command, "private-runtime"); assert.equal(args[0], "exec"); return [missing, help, ok][defaultLaunchCalls++]; };
    syncBuiltinESMExports();
    assert.equal(launch.prepareCodexLaunch("private-runtime", ["exec"], ["codex"]).ok, true);
    assert.equal(defaultLaunchCalls, 3);
    cp.spawnSync = () => { nativeCalls++; throw new Error("Unallocated tool-session native execution"); };
    syncBuiltinESMExports();
    const unchanged = ["codex", "resume", "id", "prompt"];
    assert.deepEqual(resume.buildCodexResumeRecoveryCommand(unchanged), unchanged);
    const wrapped = resume.buildCodexResumeRecoveryCommand(["codex", "resume", "--last"]);
    assert.deepEqual(wrapped.slice(0, 2), ["node", "-e"]);
    assert.deepEqual(JSON.parse(wrapped.at(-1)), { command: ["codex", "resume", "--last"], retry: ["codex", "resume"], config: [] });
    const savedJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value() {
        if (Array.isArray(this.command)) { this.command = ["prototype-mutated"]; throw raw; } return this;
    } });
    try { assert.deepEqual(resume.buildCodexResumeRecoveryCommand(["codex", "resume"]), ["codex", "resume"]); }
    finally { if (savedJSON) Object.defineProperty(Object.prototype, "toJSON", savedJSON); else delete Object.prototype.toJSON; }
    const trace = [];
    const observation = extra => ({ code: 0, output: "", stderr: "", overflow: false, signal: null, ...extra });
    const plan = { command: ["codex", "resume", "--last"], retry: ["codex", "resume"], config: [] };
    const ports = { probeTerminal: async () => { trace.push("probe"); return observation({ output: "util-linux" }); },
        launchOriginal: async () => { trace.push("original"); return observation({ code: 1 }); },
        qualifyRollout: () => ({ id: "id", path: "private" }), probeMigration: async () => observation({}), supportsMigration: () => true,
        reportRecovery: () => { trace.push("notice"); }, migrateThread: async () => { trace.push("migrate"); return observation({}); },
        missingMetadata: () => false, restoreMetadata: async () => ({ ok: true }), repairedThread: () => true,
        retryResume: async () => { trace.push("retry"); return observation({ code: 9 }); }, interruption: () => 0,
        reportFailure: () => { trace.push("failure"); }, dispose: () => { trace.push("dispose"); } };
    assert.equal(await resumeCore.createCodexResumeRecovery(ports)(plan, {}, "private", () => {}), 9);
    assert.deepEqual(trace, ["probe", "original", "notice", "migrate", "retry", "dispose"]);
    trace.length = 0;
    assert.equal(await resumeCore.createCodexResumeRecovery({ ...ports, qualifyRollout: () => null })(plan, {}, "private", () => {}), 1);
    assert.deepEqual(trace, ["probe", "original", "dispose"]);
    await assert.rejects(resumeCore.createCodexResumeRecovery({ ...ports, probeTerminal: async () => { throw raw; } })(plan, {}, "private", () => {}), value => value === raw);
    let disposed = 0;
    const nativeRunner = { interrupted: 0, run: async (command, options) => {
        assert.deepEqual(command, ["/usr/bin/script", "--version"]); assert.deepEqual(options, { timeoutMs: 5000 });
        return observation({ code: 1 });
    }, dispose() { assert.equal(this, nativeRunner); disposed++; } };
    nativeRunner.run = async (command, options) => command[0] === "/usr/bin/script" ? observation({ code: 1 })
        : (assert.equal(command, plan.command), assert.deepEqual(options, { direct: true }), observation({ code: 7 }));
    assert.equal(await resumeRuntime.runCodexResumeRecovery(plan, nativeRunner, "private", () => {}), 7);
    assert.equal(disposed, 1);
    const { default: fs } = await import("node:fs");
    const codexHome = join(process.env.HOME, "codex-home"), id = "11111111-1111-4111-8111-111111111111";
    const rollout = join(codexHome, "sessions", `rollout-private-${id}.jsonl`);
    fs.mkdirSync(join(codexHome, "sessions"), { recursive: true }); fs.writeFileSync(rollout, "private rollout bytes\n");
    const recoveryCalls = [], notices = []; let qualifiedDisposals = 0;
    const qualifiedRunner = { interrupted: 0, async run(command, options) {
        recoveryCalls.push([command, options]);
        switch (recoveryCalls.length) {
            case 1: return observation({ output: "util-linux" });
            case 2: return observation({ code: 1, output: `Error: Failed to resume session from ${rollout}: thread/resume failed during TUI bootstrap: thread/resume failed: list_turns is not supported yet (code -32601)` });
            case 3: return observation({ output: "Usage: codex migrate-rollouts --apply --thread --json" });
            case 4: return observation({ output: JSON.stringify({ outcomes: [{ thread_id: id, status: "migrated" }] }) });
            case 5: return observation({ code: 8 });
            default: throw new Error("Public resume retried more than once");
        }
    }, dispose() { assert.equal(this, qualifiedRunner); qualifiedDisposals++; } };
    assert.equal(await resumeRuntime.runCodexResumeRecovery(plan, qualifiedRunner, codexHome, message => notices.push(message)), 8);
    assert.equal(recoveryCalls.length, 5); assert.equal(qualifiedDisposals, 1); assert.equal(notices.length, 1);
    assert.deepEqual(recoveryCalls[3], [["codex", "migrate-rollouts", "--apply", "--thread", id, "--json"], { timeoutMs: 60000 }]);
    const image = Object.freeze({ opaque: true }), writes = [];
    const attachmentPorts = { now: () => 10, relativePath: (a, b, filename) => join(a, b, filename()),
        defaultReader: () => async () => image, imagePath: (project, relative) => join(project, relative),
        ensureDirectory: (...parts) => { writes.push(["directory", ...parts]); }, writeImage: (path, value) => { assert.equal(value, image); writes.push(["write", path]); } };
    const coreAttachment = attachmentCore.createCodexClipboardImageAttachment(attachmentPorts);
    assert.deepEqual(await coreAttachment.maybeAttachCodexClipboardImage("/private", ["codex", "exec"], { enabled: true, clipboardUrl: "opaque", clipboardToken: "private" }), { args: ["codex", "exec"] });
    assert.deepEqual(writes, []);
    const attached = await coreAttachment.maybeAttachCodexClipboardImage("/private", ["codex"], { enabled: true, clipboardUrl: "opaque", clipboardToken: "private" });
    assert.ok(attached.args.includes("--image")); assert.equal(writes.length, 2);
    await assert.rejects(coreAttachment.maybeAttachCodexClipboardImage("/private", ["codex"], { enabled: true, clipboardUrl: "opaque", clipboardToken: "private", readImage: async () => { throw raw; } }), value => value === raw);
    assert.deepEqual(await attachment.maybeAttachCodexClipboardImage("/private", ["--version"], { enabled: false }), { args: ["--version"] });
    const publicWrites = [], png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    fs.mkdirSync = (path, options) => { publicWrites.push(["mkdir", path, options]); };
    fs.writeFileSync = (path, value) => { assert.deepEqual(value, png); publicWrites.push(["write", path]); };
    syncBuiltinESMExports();
    const publicAttached = await attachment.maybeAttachCodexClipboardImage("/private", ["codex"], {
        enabled: true, clipboardUrl: "private-http", clipboardToken: "private-token", timestamp: 10,
        readImage: async (url, token) => { assert.equal(url, "private-http"); assert.equal(token, "private-token"); return png; },
    });
    assert.equal(publicAttached.relativeImagePath, attached.relativeImagePath); assert.equal(publicWrites.length, 2);
    await assert.rejects(attachment.maybeAttachCodexClipboardImage("/private", ["codex"], {
        enabled: true, clipboardUrl: "private-http", clipboardToken: "private-token", readImage: async () => { throw raw; },
    }), value => value === raw);
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
        assert.equal(req.url, "/clipboard/image/png");
        if (req.headers.authorization !== "Bearer private-native-token") { res.writeHead(401).end(); return; }
        res.writeHead(200, { "Content-Type": "image/png" }); res.write(png.subarray(0, 4)); res.end(png.subarray(4));
    });
    const port = await new Promise(done => server.listen(0, "127.0.0.1", () => done(server.address().port)));
    try {
        const url = `http://127.0.0.1:${port}`;
        assert.deepEqual(await attachment.readClipboardImagePng(url, "private-native-token"), png);
        assert.equal(await attachment.readClipboardImagePng(url, "wrong-token"), null);
        const nativeAttached = await attachment.maybeAttachCodexClipboardImage("/private", ["codex"], {
            enabled: true, clipboardUrl: url, clipboardToken: "private-native-token", timestamp: 10,
        });
        assert.equal(nativeAttached.relativeImagePath, publicAttached.relativeImagePath); assert.equal(publicWrites.length, 4);
    } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    assert.equal(nativeCalls, 0, "all selected native effects must remain explicitly injected");
}

async function verifyReviewedBrokerDelivery(root, home) {
    const {default: assert} = await import("node:assert/strict");
    const {default: cp} = await import("node:child_process");
    const {default: net} = await import("node:net");
    const {default: http} = await import("node:http");
    const {default: https} = await import("node:https");
    const {syncBuiltinESMExports} = await import("node:module");
    const filesystem = (await import("node:fs")).default;
    const existsSync = (...args) => filesystem.existsSync(...args), mkdirSync = (...args) => filesystem.mkdirSync(...args);
    const readFileSync = (...args) => filesystem.readFileSync(...args), readdirSync = (...args) => filesystem.readdirSync(...args), writeFileSync = (...args) => filesystem.writeFileSync(...args);
    const {join, resolve} = await import("node:path");
    const {pathToFileURL, fileURLToPath} = await import("node:url");
    const privateRequest = http.request;
    const privateConnection = net.createConnection;
    const privateSocketConnect = net.Socket.prototype.connect;
    const privateCreateServer = http.createServer, privateListen = net.Server.prototype.listen;
    let creatingFixtureServer = false, listeningFixtureServer = false, fixtureServer, allocatedServers = 0, allocatedListeners = 0;
    assert(!root.includes('/.claude/worktrees/'));
    assert(!existsSync(join(root, 'node_modules')));
    for (const key of Object.keys(process.env)) if (/^(CCC_|ANDROID_)/i.test(key)) delete process.env[key];
    Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home,'AppData/Roaming'), LOCALAPPDATA: join(home,'AppData/Local') });
    mkdirSync(home, {recursive:true});
    let nativeCalls = 0, allocatedMetadata = 0, allocatedConnections = 0;
    const refuse = (...args) => { nativeCalls++; throw new Error('QA forbidden native/process/network call: '+String(args[0])); };
    for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[key] = refuse;
    for(const mod of [net, http, https]) for(const key of ['connect','createConnection','request','get','createServer']) if(typeof mod[key] === 'function') mod[key] = refuse;
    globalThis.fetch = refuse;
    process.kill = refuse;
    net.Socket.prototype.connect = refuse;
    net.Server.prototype.listen = function (...args) {
        if(!listeningFixtureServer || this!==fixtureServer || allocatedListeners!==0 || this.address()!==null
            || args.length!==3 || args[0]!==0 || args[1]!=="127.0.0.1" || typeof args[2]!=="function")return refuse("unallocated listener");
        allocatedListeners++;
        return privateListen.apply(this,args);
    };
    http.createServer = (...args) => {
        if(!creatingFixtureServer || fixtureServer || args.length!==1 || typeof args[0]!=="function")return refuse("unallocated HTTP server");
        fixtureServer=privateCreateServer(...args); allocatedServers++;
        return fixtureServer;
    };
    const udp = (await import("node:dgram")).default;
    udp.createSocket = refuse;
    for(const method of ["bind","send","connect"])udp.Socket.prototype[method]=refuse;
    (await import("node:tls")).default.connect = refuse;
    const fs = (await import("node:fs")).default;
    for (const name of ["readFileSync", "writeFileSync", "mkdirSync", "readdirSync", "unlinkSync", "rmSync", "renameSync", "linkSync", "symlinkSync", "copyFileSync", "openSync", "chmodSync"]) {
        const captured = fs[name];
        fs[name] = function (...args) {
            if (name === "readFileSync") {
                if (args[0] === "/proc/sys/kernel/random/boot_id") { allocatedMetadata++; return "shipping-fixture-boot\n"; }
                if (args[0] === `/proc/${process.pid}/stat`) { allocatedMetadata++; return `${process.pid} (node) ${Array(20).fill("1").join(" ")}`; }
                if (args[0] === `/proc/${process.pid}/cmdline`) { allocatedMetadata++; return Buffer.from("node\0shipping-fixture\0"); }
            }
            const selected = ["renameSync", "linkSync", "copyFileSync"].includes(name) ? args.slice(0, 2) : name === "symlinkSync" ? [args[1]] : [args[0]];
            for (const value of selected) {
                if (typeof value === "number") continue;
                const resolved = resolve(value instanceof URL ? fileURLToPath(value) : String(value));
                if (![home, root].some(base => resolved === base || resolved.startsWith(base + "/"))) return refuse("filesystem:" + resolved);
            }
            const writes = !["readFileSync", "readdirSync"].includes(name) && !(name==="openSync" && (args[1]==="r" || args[1]===fs.constants.O_RDONLY || args[1]===(fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))));
            if(writes){const destination=["renameSync","linkSync","copyFileSync","symlinkSync"].includes(name)?args[1]:args[0];if(typeof destination!=="number" && resolve(destination instanceof URL ? fileURLToPath(destination) : String(destination))!==home && !resolve(destination instanceof URL ? fileURLToPath(destination) : String(destination)).startsWith(home+"/"))return refuse("filesystem-write:"+destination);}
            return captured.apply(this, args);
        };
    }
    syncBuiltinESMExports();
    const source = join(root,'dist/packages/device-lab/dist/device-lab');
    const names = ['application/broker-observation-inventory','application/broker-observation-leases','application/broker-observation-appium','application/broker-observation-status','application/broker-observation-command-plan','domain/broker-observation','domain/broker-observation-command-plan','ports/broker-observation'];
    const [inventory, leases, appium, status, preview, domain, conflicts, ports] = await Promise.all(names.map(name => import(pathToFileURL(join(source,name+'.js')).href)));
    assert.equal(Object.keys(ports).length,0);
    let checks = 0;
    const eq=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
    const throws=(fn,error)=>{assert.throws(fn,error);checks++;};
    const owner='0123456789abcdef';
    const device={id:'device',status:'attached',appium:{sessionId:'synthetic'},secret:'private'};
    let invError=null, redacted=0;
    const ownerInventory=inventory.createOwnerInventory({root:()=>'/synthetic',file:(_r,_o,key)=>key,exists:key=>key!=='missing',stat:key=>({size:key==='large'?101:1}),read:()=>{if(invError)throw invError;return [device,{id:'two'},{id:'three'}]},redact:d=>{redacted++;return {id:d.id}},errorCode:e=>e.code||null,ownerRoot:(r,o)=>r+'/owners/'+o},{stateKeys:['android','missing','large'],maxBytes:100,maxDevices:2});
    let observed=ownerInventory(owner);
    eq(observed.backends[0].devices.length,2); eq(observed.backends[0].devices[0],device); assert.equal(observed.backends[0].devices[0],device); checks++;
    eq(observed.backends[1],{stateKey:'missing',devices:[],exists:false});eq(observed.backends[2].error,'inventory-file-too-large');
    eq(ownerInventory(owner,true).backends[0].devices,[{id:'device'},{id:'two'}]);eq(redacted,2);
    invError={code:'read-denied'};eq(ownerInventory(owner).backends[0].error,'read-denied');invError=null;
    const fatal=new Error('exist-fault');throws(()=>inventory.createOwnerInventory({root:()=>'',file:()=>'',exists:()=>{throw fatal}},{stateKeys:['x'],maxBytes:1,maxDevices:1})(owner),e=>e===fatal);
    let focusTrace=[];
    const focused=inventory.createFocusedInventory({inventory:o=>{focusTrace.push('inventory');return ownerInventory(o)},androidHost:()=>{focusTrace.push('host');return {devices:['usb']}},androidChoices:()=>{focusTrace.push('choices');return {images:[]}},backend:e=>'backend:'+e.stateKey});
    eq(focused(owner,{stateKey:'android',backend:'android-device',tool:'device_inventory'},{}).hostDevices,['usb']);eq(focusTrace,['inventory','host']);
    focusTrace=[];eq(focused(owner,{backend:'android-emulator',tool:'device_inventory'},{}).devices,undefined);eq(focusTrace,['inventory','choices']);eq(focused(owner,{stateKey:'unknown',backend:null,tool:'device_inventory'},{}).devices,[]);

    eq(domain.observedLeaseTtlMs({ttlMs:0},5),5);eq(domain.observedLeaseTtlMs({ttlMs:1},5),1);
    const dates=leases.createLeaseDatePolicy({parse:f=>Date.parse(f()),epoch:()=>new Date(0).toISOString(),expiryFrom:(s,t)=>new Date(Date.parse(s)+t).toISOString()},1000);
    eq(dates.expiresAt({updatedAt:'1970-01-01T00:00:00.000Z'}),'1970-01-01T00:00:01.000Z');eq(dates.expired({expiresAt:'1970-01-01T00:00:01.000Z'},1000),true);eq(dates.expired({expiresAt:'1970-01-01T00:00:01.000Z'},999),false);eq(dates.expiresAt({expiresAt:'bad',updatedAt:'bad'}),'1970-01-01T00:00:01.000Z');
    let entries=[],closeError=null,closed=0,inspection={ok:true,exists:true};
    const scan=leases.createLeaseDirectoryScan({root:()=>'/lease',inspect:()=>inspection,assertRoot:()=>{},open:()=>({readSync:()=>entries.shift()||null,closeSync:()=>{closed++;if(closeError)throw closeError}}),entryFile:(r,e)=>r+'/'+e.name,errorCode:e=>e.code||null},2);
    const entry=name=>({name,isFile(){return true}});
    entries=[entry('usb%3A1.json'),entry('bad%zz.json')];eq(scan('android-device').entries,[{file:'/lease/usb%3A1.json',hardwareId:'usb:1'}]);eq(closed,1);
    entries=[entry('a.json'),entry('b.json'),entry('c.json')];eq(scan('android-device').kind,'entry-cap');eq(closed,2);
    closeError={code:'close-failed'};entries=[entry('a.json'),entry('b.json'),entry('c.json')];eq(scan('android-device'),{kind:'directory-failed',backend:'android-device',detail:'close-failed'});closeError=null;
    inspection={ok:false,reason:'native-fence'};eq(scan('android-device'),{kind:'native-refusal',evidence:inspection});inspection={ok:true,exists:false};eq(scan('android-device').entries,[]);
    const leaseValues=[{ownerId:owner,expiresAt:'1970-01-01T00:00:02.000Z',ttlMs:1000},{ownerId:owner,expiresAt:'1970-01-01T00:00:01.000Z'},{ownerId:'foreign',expiresAt:'1970-01-01T00:00:02.000Z'},null];let nowCalls=0;
    const list=leases.createLeaseList(()=>({ok:true,entries:leaseValues.map((_x,i)=>({file:i,hardwareId:String(i)}))}),{read:i=>leaseValues[i],expired:l=>{nowCalls++;return dates.expired(l,1000)},expiresAt:dates.expiresAt,ttlMs:dates.ttlMs});
    eq(list(owner,'android-device').leases.length,1);eq(nowCalls,2);
    const composite=leases.createPhysicalComposite({leases:list,androidHost:()=>({devices:['usb']}),devices:()=>[device]});eq(composite(owner,'android-device',{}).value.hostDevices,['usb']);eq('hostInventory' in composite(owner,'ios-device',{}).value,false);
    eq(leases.createPhysicalComposite({leases:()=>({ok:false,error:'refusal'})})(owner,'android-device',{}),{kind:'lease-refused',evidence:{ok:false,error:'refusal'}});

    let metadata=[null,device,{id:7,status:false,appium:0},{id:'nullish',status:0,appium:false}];let readError=null;
    const meta=appium.createAppiumObservations({read:()=>{if(readError)throw readError;return metadata}});const request={backend:'android-emulator',stateKey:'android',deviceId:'device'};
    assert.equal(meta.status(owner,request).value.device,device);checks++;assert.equal(meta.status(owner,request).value.appium,device.appium);checks++;
    eq(meta.status(owner,{...request,deviceId:'missing'}).kind,'not-found');eq(meta.list(owner,request).value.sessions[1],{deviceId:'nullish',status:0,appium:false});
    readError={code:'state-fault'};eq(meta.list(owner,request),{kind:'read-failed',error:readError});readError=null;
    const getterError=new Error('projection-fault');metadata=[{get id(){return 7},get status(){throw getterError}}];throws(()=>meta.list(owner,request),e=>e===getterError);

    let trace=[],existCount=0;
    const brokerStatus=status.createBrokerStatus({root:()=>{trace.push('root');return '/root'},service:()=>{trace.push('service');return {}},serviceOwner:()=>({ownerId:owner}),runtimeFile:()=>'/runtime',runtime:()=>null,address:()=>({host:'synthetic',port:1}),hostId:()=>'synthetic',pid:()=>1,startToken:()=>'token',startedAt:()=>'start',paths:()=>({ownerRoot:'/owner'}),exists:()=>++existCount===1,persistence:()=>({persistent:true}),serviceFacts:()=>({supported:false}),elevation:()=>({state:'unavailable'})});
    const facts=brokerStatus(owner,{});eq(facts.rootExists,true);eq(facts.deviceStateMounted,false);eq(facts.runtimeFacts.present,false);eq(facts.ownedByCurrentOwner,true);eq(trace,['root','service']);
    let supported=true,dryRun=false,queryTrace=[],queryFailure=false;
    const svc=status.createBrokerService({plan:()=>({supported,definitionPath:'/definition'}),commands:()=>['first','second'],dryRun:()=>dryRun,owner:()=>({ownerId:owner}),installed:()=>true,query:(_c,command)=>{queryTrace.push(command);return {mode:'exec',provider:'systemctl',status:queryFailure?1:0,stdout:'RAW_SECRET',stderr:''}},succeeded:r=>r.status===0,projection:(p,c)=>({...p,commands:c}),diagnostics:()=>[]},new Set(['status']));
    eq(svc(owner,'start',{}),{kind:'invalid-action',action:'start',allowed:['status']});eq(queryTrace,[]);supported=false;eq(svc(owner,'status',{}).kind,'unsupported');eq(queryTrace,[]);supported=true;dryRun=true;eq(svc(owner,'status',{}).kind,'dry-run');eq(queryTrace,[]);dryRun=false;queryFailure=true;eq(svc(owner,'status',{}).value.running,false);eq(queryTrace,['first','second']);

    let used=new Set(),inventoryFailure=null;
    const allocator=preview.createAndroidPreviewPortAllocation({valid:p=>Number.isInteger(p)&&p>=5554&&p<=5558&&p%2===0,allocated:()=>{if(inventoryFailure)throw inventoryFailure;return new Set(used)},inventoryError:()=> 'unavailable',seed:()=>2},5554,5558);
    const create={backend:'android-emulator',stateKey:'android',command:'device_create',deviceId:'new',force:false,dryRun:true,create:{}};
    eq(allocator(owner,{...create,create:{port:5555}},[]).kind,'invalid');eq(allocator(owner,create,[]),{kind:'allocated',port:5558});used=new Set([5558]);eq(allocator(owner,create,[]),{kind:'allocated',port:5554});eq(allocator(owner,{...create,create:{port:5558}},[]).kind,'conflict');eq(allocator(owner,create,[5554,5556]).kind,'exhausted');inventoryFailure=new Error('inventory');eq(allocator(owner,create,[]),{kind:'inventory-failed',detail:'unavailable'});inventoryFailure=null;
    eq(conflicts.hyperVPreviewConflicts({name:'new',profile:'ubuntu-lts',memoryMb:4096,cpus:2,networking:true},{...create,backend:'linux-vm'},()=>({})),[]);eq(conflicts.hyperVPreviewConflicts({name:'new',profile:'ubuntu-lts',memoryMb:4096,cpus:1,networking:true},{...create,backend:'linux-vm'},()=>({})),['cpus']);
    let current=[],attachment=false,stateFailure=null,writeFailure=null,redactFailure=null,intents=0;
    const lifecycle=preview.createLifecyclePreview({read:()=>{if(stateFailure)throw stateFailure;return current},hyperV:p=>p.backend==='linux-vm',validIncarnation:p=>typeof p.expectedIncarnationId==='string',incarnation:d=>d.incarnationId||null,conflicts:(d,p)=>conflicts.hyperVPreviewConflicts(d,p,()=>({})),androidPort:(o,p)=>{const a=allocator(o,p,[]);return a.kind==='allocated'?{ok:true,port:a.port}:{ok:false,error:a.kind}},createDefinition:(_o,p)=>({id:p.deviceId,port:p.create?.port}),assertWritable:producer=>{producer();if(writeFailure)throw writeFailure},redactDevice:d=>{if(redactFailure)throw redactFailure;return d},redactHyperVDevice:d=>d,redactCreate:p=>p.create,publicHyperVCreate:p=>p.create,maskedHyperVPlan:()=>({mode:'masked',provider:'hyper-v'}),createPlan:()=>{intents++;return {mode:'intent',provider:'native'}},existingPlan:()=>{intents++;return {mode:'intent',provider:'native'}},attachmentMatches:()=>attachment});
    used=new Set();eq(lifecycle(owner,create,{},false).kind,'create');eq(intents,1);writeFailure={code:'capacity'};eq(lifecycle(owner,create,{},false),{kind:'state-failed',error:writeFailure});eq(intents,1);writeFailure=null;
    redactFailure=new Error('redaction');throws(()=>lifecycle(owner,create,{},true),e=>e===redactFailure);eq(intents,1);redactFailure=null;
    current=[{id:'new',status:'detached',incarnationId:'live'}];eq(lifecycle(owner,create,{},false).kind,'already-exists');eq(lifecycle(owner,{...create,backend:'android-device',stateKey:'android-device',command:'device_start'}, {},false).kind,'not-attached');
    current[0].status='attached';attachment=true;eq(lifecycle(owner,{...create,backend:'android-device',stateKey:'android-device',command:'device_start'}, {},false).kind,'existing');
    eq(lifecycle(owner,{...create,backend:'linux-vm',command:'device_stop'}, {},false).kind,'incarnation-required');eq(lifecycle(owner,{...create,backend:'linux-vm',command:'device_stop',expectedIncarnationId:'old'}, {},false).kind,'incarnation-conflict');
    current=[];eq(lifecycle(owner,{...create,backend:'linux-vm',command:'device_delete'}, {},false).kind,'missing-delete');eq(lifecycle(owner,{...create,command:'device_status'}, {},false).kind,'not-found');stateFailure={code:'state'};eq(lifecycle(owner,create,{},false),{kind:'state-failed',error:stateFailure});stateFailure=null;

    const broker=await import(pathToFileURL(join(root,'dist/packages/device-lab/dist/device-lab-broker.js')).href);
    let commandCalls=[];const runner=command=>{commandCalls.push(command);return {...command,status:0,stdout:'RAW_SERVICE_DIAGNOSTIC',stderr:''}};
    const options={ownerId:owner,cwd:home,host:'127.0.0.1',port:17374,startedAt:'frozen',platform:'linux',providerPaths:{systemctl:'/synthetic/systemctl'},commandRunner:runner};
    const statusResult=broker.deviceBrokerStatus(options);eq(statusResult.ownerId,owner);eq(statusResult.startedAt,'frozen');eq(statusResult.url,'http://127.0.0.1:17374');eq(statusResult.containerContract.ownerResolution,'host-broker-resolve');eq(statusResult.serviceManager.actions,['status']);eq(commandCalls,[]);
    eq(broker.deviceBrokerService('start',options),{ok:false,error:'invalid-service-action',action:'start',allowed:['status']});eq(commandCalls,[]);
    eq(broker.deviceBrokerService('status',{...options,dryRun:true}).dryRun,true);eq(commandCalls,[]);
    const raw=broker.deviceBrokerService('status',options);eq(raw.ok,true);eq(raw.running,true);eq(commandCalls.length,2);eq(raw.results[0].stdout,'RAW_SERVICE_DIAGNOSTIC');
    commandCalls=[];const failed=broker.deviceBrokerService('status',{...options,commandRunner:command=>{commandCalls.push(command);return {...command,status:1,stdout:'',stderr:'synthetic failure'}}});eq(failed.ok,true);eq(failed.running,false);eq(commandCalls.length,2);
    eq(broker.deviceBrokerService('status',{...options,platform:'aix'}).error,'service-manager-unsupported');
    const runnerFailure=new Error('runner-fault');throws(()=>broker.deviceBrokerService('status',{...options,commandRunner:()=>{throw runnerFailure}}),e=>e===runnerFailure);
    eq(nativeCalls,0);
    const registration = broker.registerDeviceBrokerOwner(home);
    const rpcOwner = registration.ownerId, token = broker.deviceBrokerOwnerToken(rpcOwner);
    const stateFile = join(home, ".ccc/devices/owners", rpcOwner, "android/devices.json");
    mkdirSync(join(stateFile, ".."), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ devices: [{ id: "metadata", status: "stopped", appium: { sessionId: "private-session" } }] }));
    let server;
    creatingFixtureServer=true;
    try { server=broker.createDeviceBrokerServer({ ...options, ownerId: rpcOwner }); }
    finally { creatingFixtureServer=false; }
    assert.equal(server,fixtureServer); assert.equal(allocatedServers,1);
    const port = await new Promise((done, reject) => { server.once("error", reject); listeningFixtureServer=true;
        try { server.listen(0, "127.0.0.1", () => {
        const address=server.address();
        if(!address || address.address!=="127.0.0.1" || address.family!=="IPv4" || !Number.isInteger(address.port) || address.port<1 || address.port>65535){try{refuse("invalid allocated listener address");}catch(error){reject(error);}return;}
        done(address.port);
        }); } finally { listeningFixtureServer=false; }
    });
    assert.equal(allocatedListeners,1);
    const privateAgent = new http.Agent({ keepAlive: false });
    privateAgent.createConnection = (connection, callback) => {
        assert.equal(connection.host, "127.0.0.1");
        assert.equal(connection.port, port);
        const socket = new net.Socket();
        const nativeSocketConnect = privateSocketConnect;
        assert.equal(connection.host, "127.0.0.1"); assert.equal(connection.port, port);
        allocatedConnections++;
        return nativeSocketConnect.call(socket, connection, callback);
    };
    async function rpc(method, params, bearer = token, claimedOwner = rpcOwner) {
        return new Promise((done, reject) => {
            const req = privateRequest({ hostname: "127.0.0.1", port, agent: privateAgent, path: `/v1/owners/${rpcOwner}/rpc`, method: "POST",
                headers: { "x-ccc-device-token": bearer, "Content-Type": "application/json" } }, response => {
                const parts = []; response.on("data", part => parts.push(part));
                response.on("end", () => done({ status: response.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }));
                response.on("error", reject);
            });
            req.setTimeout(5000, () => req.destroy(new Error("Private broker RPC timeout")));
            req.on("error", reject); req.end(JSON.stringify({ method, params, ownerId: claimedOwner }));
        });
    }
    try {
        const cases = [["broker.status", {}], ["broker.service.manager", { action: "status", dryRun: true }],
            ["broker.inventory", {}], ["broker.lease.list", { backend: "ios-device" }],
            ["broker.physical.list", { backend: "ios-device" }],
            ["broker.command.plan", { backend: "linux-vm", command: "device_delete", deviceId: "missing", dryRun: true }],
            ["broker.appium.status", { backend: "android-emulator", deviceId: "metadata" }],
            ["broker.appium.list", { backend: "android-emulator" }]];
        for (const [method, params] of cases) {
            const denied = await rpc(method, params, "wrong-token"); eq(denied.status, 401); eq(denied.body.error, "invalid-owner-token");
            const mismatch = await rpc(method, params, token, "ffffffffffffffff"); eq(mismatch.status, 403);
            const allowed = await rpc(method, params); eq(allowed.status, 200); eq(allowed.body.ok, true);
            if (method === "broker.appium.status") eq(allowed.body.result.appium, { sessionId: "private-session" });
            if (method === "broker.appium.list") eq(allowed.body.result.sessions[0].deviceId, "metadata");
            if (method === "broker.command.plan") eq(allowed.body.result.deviceId, "missing");
        }
        const create = { backend: "windows-sandbox", command: "device_create", deviceId: "shipping-rpc", name: "Shipping RPC", memoryMb: 2048, networking: true };
        eq((await rpc("broker.command.invoke", create, "wrong-token")).status, 401);
        eq((await rpc("broker.command.invoke", create, token, "ffffffffffffffff")).status, 403);
        const windows = join(home, ".ccc/devices/owners", rpcOwner, "windows");
        eq((await rpc("broker.command.invoke", { ...create, dryRun: true })).status, 200);
        eq(existsSync(join(windows, "devices.json")), false);
        const made = await rpc("broker.command.invoke", create);
        assert.equal(made.status, 200, JSON.stringify({ consumer:"sandbox-authenticated-create", response:made, deniedEffects:nativeCalls, allocatedMetadata, allocatedConnections, allocatedServers, allocatedListeners, fixture:{platform:options.platform,providerPaths:options.providerPaths} }).slice(0,2400));
        const record = JSON.parse(readFileSync(join(windows, "devices.json"), "utf8")).devices[0];
        eq(record.createdAt, record.updatedAt); eq(record.networking, true);
        const config = readFileSync(record.configPath, "utf8"); assert.match(config, /<MemoryInMB>2048<\/MemoryInMB>/); eq((config.match(/<MappedFolder>/g) || []).length, 5);
        const duplicate = await rpc("broker.command.invoke", create); eq(duplicate.status, 409); eq(duplicate.body.error, "owner-device-already-exists");
        const fallback = await rpc("broker.command.invoke", { ...create, deviceId: "fallback", memoryMb: "raw" }); eq(fallback.status, 200); eq(fallback.body.result.device.memoryMb, 4096);
        assert.ok((await rpc("broker.command.invoke", { ...create, deviceId: "../invalid" })).status >= 400);
        const fs = (await import("node:fs")).default;
        const faultConfig = join(windows, "config-fault/config-fault.wsb"); fs.mkdirSync(faultConfig, { recursive: true }); fs.writeFileSync(join(faultConfig, "keep"), "keep");
        const failure = await rpc("broker.command.invoke", { ...create, deviceId: "config-fault" }); eq(failure.status, 500); eq(failure.body.error, "windows-sandbox-config-write-failed");
        assert.equal(JSON.parse(readFileSync(join(windows, "devices.json"), "utf8")).devices.some(d => d.id === "config-fault"), false);
        eq(readFileSync(join(faultConfig, "keep"), "utf8"), "keep");
        for (const name of ["ccc-guest-helper.ps1", "ccc-guest-helper-bootstrap.ps1", "ccc-guest-helper-bootstrap.vbs"]) assert.ok(readFileSync(join(windows, "config-fault/tools", name), "utf8").length);
        const { createBrokerWindowsSandboxCreate } = await import(pathToFileURL(join(source, "application/lifecycle/windows-sandbox-create.js")).href);
        const { retainAfterWindowsConfigFailure } = await import(pathToFileURL(join(source, "domain/lifecycle/windows-sandbox-create.js")).href);
        const captured = { id: "same", createdAt: "old" };
        const sameIdSuccessor = { id: "same", createdAt: "new" }, sameTimeForeign = { id: "different", createdAt: "old" };
        let survivors = [captured, sameIdSuccessor, sameTimeForeign, null]; const publicationError = { failure: "config" };
        const outcome = await createBrokerWindowsSandboxCreate({
            createRecord: () => captured, claimDefinition: () => ({ ok: true }),
            rollbackAfterClaimFailure: async () => { throw Error("unexpected claim rollback"); },
            publishConfig: () => { throw publicationError; }, stateErrorCode: () => null,
            removeMatchingClaim: (id, createdAt) => { eq(id, "same"); eq(createdAt, "old"); return survivors = survivors.filter(d => retainAfterWindowsConfigFailure(d, id, createdAt)); },
        }).create({});
        eq(outcome.kind, "config-failure"); assert.equal(outcome.error, publicationError);
        eq(survivors, [sameIdSuccessor, sameTimeForeign, null]);
        for (const mode of ["conflict", "claim-throw", "rollback-false", "rollback-throw", "mutation-throw"]) {
            const raw = { mode }; const trace = [];
            const app = createBrokerWindowsSandboxCreate({
                createRecord: () => captured,
                claimDefinition: () => { trace.push("claim"); if(mode!=="conflict" && mode!=="mutation-throw")throw raw; return mode==="conflict"?{ok:false,error:"owner-device-id-conflict",field:"id",value:"same",existing:sameIdSuccessor}:{ok:true}; },
                rollbackAfterClaimFailure: async () => { trace.push("rollback"); if(mode==="rollback-throw")throw raw; return {ok:mode!=="rollback-false"}; },
                publishConfig: () => { trace.push("config"); throw raw; },
                removeMatchingClaim: () => { trace.push("mutate"); throw raw; }, stateErrorCode: () => null,
            });
            if(mode==="rollback-throw" || mode==="mutation-throw")await assert.rejects(app.create({}),error=>error===raw);
            else { const result=await app.create({}); eq(result.kind,mode==="conflict"?"claim-conflict":"claim-exception"); if(mode!=="conflict")assert.equal(result.error,raw); if(mode==="rollback-false")eq(result.stateCode,"owner-state-write-failed"); }
            eq(trace,mode==="mutation-throw"?["claim","config","mutate"]:["claim","rollback"]);
        }
        eq(nativeCalls, 0);
        console.log(JSON.stringify({ consumer: "sandbox-authenticated-create", result: "PASS", layer: "compiled-RPC/compensation/native-writer", deniedEffects: nativeCalls, allocatedMetadata, allocatedConnections, allocatedServers, allocatedListeners }));
    } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    console.log(JSON.stringify({ result: "PASS", checks, nativeCalls, publicRpcQueries: 8, partialAggregateCeiling: true }));
}

async function verifyReviewedSandboxDelivery(payload) {
    const { default: assert } = await import("node:assert/strict");
    const { default: cp } = await import("node:child_process");
    const { default: fs } = await import("node:fs");
    const { default: path } = await import("node:path");
    const { syncBuiltinESMExports } = await import("node:module");
    const { pathToFileURL, fileURLToPath } = await import("node:url");
    const { createHash } = await import("node:crypto");
    let deniedEffects = 0, allocatedMetadata = 0, allocatedDiscovery = 0;
    const deny = () => { deniedEffects++; throw new Error("Unallocated Sandbox process/network effect"); };
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[name] = deny;
    process.kill = deny;
    const net = (await import("node:net")).default;
    net.connect = net.createConnection = net.createServer = net.Socket.prototype.connect = net.Server.prototype.listen = deny;
    const udp = (await import("node:dgram")).default;
    udp.createSocket = deny;
    for(const method of ["bind","send","connect"])udp.Socket.prototype[method]=deny;
    (await import("node:tls")).default.connect = deny;
    for (const protocol of ["node:http", "node:https"]) { const mod = (await import(protocol)).default; mod.request = mod.get = mod.createServer = deny; }
    globalThis.fetch = deny;
    const privatePath = selected => {
        if (typeof selected === "number") return true;
        const resolved = path.resolve(selected instanceof URL ? fileURLToPath(selected) : String(selected));
        return [process.env.HOME, payload].some(root => resolved === root || resolved.startsWith(root + path.sep));
    };
    for (const name of ["readFileSync", "writeFileSync", "mkdirSync", "readdirSync", "unlinkSync", "rmSync", "renameSync", "symlinkSync", "linkSync", "copyFileSync", "openSync", "chmodSync"]) {
        const captured = fs[name];
        fs[name] = function (...args) {
            if (name === "readFileSync") {
                if (args[0] === "/proc/sys/kernel/random/boot_id") { allocatedMetadata++; return "shipping-fixture-boot\n"; }
                if (args[0] === `/proc/${process.pid}/stat`) { allocatedMetadata++; return `${process.pid} (node) ${Array(20).fill("1").join(" ")}`; }
                if (args[0] === `/proc/${process.pid}/cmdline`) { allocatedMetadata++; return Buffer.from("node\0shipping-fixture\0"); }
            }
            const paths = ["renameSync", "linkSync", "copyFileSync"].includes(name) ? args.slice(0, 2) : name === "symlinkSync" ? [args[1]] : [args[0]];
            if (!paths.every(privatePath)) return deny();
            const writes = !["readFileSync", "readdirSync"].includes(name) && !(name==="openSync" && (args[1]==="r" || args[1]===fs.constants.O_RDONLY || args[1]===(fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))));
            if(writes){const destination = ["renameSync","linkSync","copyFileSync","symlinkSync"].includes(name)?args[1]:args[0];if(typeof destination!=="number" && path.resolve(destination instanceof URL ? fileURLToPath(destination) : String(destination))!==process.env.HOME && !path.resolve(destination instanceof URL ? fileURLToPath(destination) : String(destination)).startsWith(process.env.HOME+path.sep))return deny();}
            return captured.apply(this, args);
        };
    }
    syncBuiltinESMExports();
    const providers = path.join(payload, "dist/packages/device-lab/providers");
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(providers, "backends/windows-helper.ps1"))).digest("hex"),
        "4c00058569e0f42b95c542f329d35d546abfa01afb17a601d606c0849eeb4086", "retained authoritative native Sandbox asset");
    const module = name => import(pathToFileURL(path.join(providers, name)).href);
    let nativeCalls = 0;

    syncBuiltinESMExports();
    const { createWindowsSandboxStop } = await module("application/lifecycle/windows-sandbox-stop.mjs");
    const guid = "11111111-1111-4111-8111-111111111111";
    function fixture(extra = {}) {
        let current = { id: "core", status: "running", sandboxId: guid, singletonClaimId: "old", recording: { active: true } };
        const trace = [];
        const ports = { findDevice: () => current, readSingleton: () => ({ claimId: "old", deviceId: "core", sandboxId: guid }),
            sameSingletonOwner: () => true, newRuntimeId: () => "operation", wallTimestamp: () => "2026-10-08T00:00:00.000Z",
            transitionDevice: (_id, expected, replacement) => { assert.equal(current, expected); current = replacement; trace.push("cas:" + replacement.status); return { matched: true, found: true }; },
            claimSingleton: () => { throw new Error("Unexpected claim"); }, releaseSingleton: () => { trace.push("release"); return false; },
            singletonGenerationMatches: () => true, watchdogCancelPath: () => "private-cancel",
            cancelWatchdog: cancelPath => ({ attempted: true, ok: true, cancelPath }),
            discoverRuntime: () => ({ available: true, missing: [], binding: { opaque: true } }),
            stopOwnedRuntime: (binding, device, timeout) => { assert.deepEqual(binding, { opaque: true }); assert.equal(device.sandboxId, guid); assert.equal(timeout, 60000); trace.push("stop"); return { ok: true, evidence: { opaque: true } }; }, ...extra };
        return { run: () => createWindowsSandboxStop(ports).stop("core"), trace, current: () => current };
    }
    const success = fixture(); assert.equal(success.run().kind, "completed");
    assert.deepEqual(success.trace, ["cas:stopping", "stop", "cas:stopped", "release"]);
    assert.deepEqual(success.current().recording, { active: true });
    const foreign = fixture({ sameSingletonOwner: () => false, claimSingleton: () => ({ ok: false, error: "foreign owner" }) });
    assert.equal(foreign.run().kind, "refused"); assert.deepEqual(foreign.trace, ["cas:stopping", "cas:running"]);
    const failure = Symbol("raw native stop");
    const raw = fixture({ stopOwnedRuntime() { throw failure; } }); assert.throws(raw.run, value => value === failure);
    const mismatch = fixture({ transitionDevice: () => ({ matched: false, found: true }) }); assert.notEqual(mismatch.run().kind, "completed"); assert.deepEqual(mismatch.trace, []);
    const successor = fixture({ singletonGenerationMatches: () => false }); assert.equal(successor.run().kind, "refused"); assert.equal(successor.trace.includes("release"), false);
    const failedNative = fixture({ stopOwnedRuntime: () => ({ ok: false, evidence: { raw: "stop failed" } }) });
    assert.deepEqual(failedNative.run(), { kind: "native-failure", evidence: { raw: "stop failed" } });
    cp.spawnSync = (command, args = [], options) => {
        const lookup = command === "where" ? args[0] : command === "/bin/sh" && args[0] === "-c" && args[1]?.startsWith("command -v ") ? args[1].slice(11) : null;
        if (lookup !== null) { allocatedDiscovery++; assert.ok(["wsb", "powershell", "powershell.exe", "pwsh"].includes(lookup), "only allocated Sandbox discovery observations"); return { status: lookup === "wsb" ? 0 : 1, stdout: lookup === "wsb" ? "private-fake-wsb\n" : "", stderr: "" }; }
        assert.equal(command, "private-fake-wsb"); assert.deepEqual(args, ["stop", "--id", guid]);
        assert.equal(options.timeout, 60000); assert.equal(options.windowsHide, true); nativeCalls++;
        return { status: 0, stdout: "", stderr: "" };
    };
    syncBuiltinESMExports();
    const backend = await module("backends/windows-sandbox.mjs");
    const state = await module("state/device-store.mjs");
    const { ownerId } = await module("context.mjs");
    state.writeOwnerDevices("windows", [{ id: "public", status: "running", backend: "windows-sandbox", sandboxId: guid, singletonClaimId: "old", recording: { active: true } }]);
    const lock = path.join(process.env.HOME, ".ccc/devices/host-locks/windows-sandbox.json");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ provider: "windows-sandbox", ownerId: ownerId(), deviceId: "public", sandboxId: guid, claimId: "old" }));
    const response = await backend.handleWindowsTool("device_stop", { deviceId: "public" });
    assert.notEqual(response.isError, true); assert.equal(state.findOwnerDevice("windows", "public").status, "stopped");
    assert.deepEqual(state.findOwnerDevice("windows", "public").recording, { active: true }); assert.equal(fs.existsSync(lock), false);
    assert.notEqual((await backend.handleWindowsTool("device_stop", { deviceId: "public" })).isError, true);
    assert.equal(nativeCalls, 1, "actual facade must stop the captured runtime once");
    const direct = await module("application/lifecycle/windows-sandbox-create.mjs");
    const trace = []; let ticks = 0;
    const definition = direct.createWindowsSandboxCreate({
        deriveDeviceId: () => { trace.push("derive"); return "compiled-create"; },
        readDefinitions: () => { trace.push("read"); return []; },
        readOwnerId: () => { trace.push("owner"); return "owner"; },
        ensureHelperWorkspace: () => { trace.push("helper"); return { scratch: "private" }; },
        wallTimestamp: () => { trace.push("clock"); return `tick-${++ticks}`; },
        claimDefinition: () => { trace.push("claim"); return { ok: true }; },
    }).create({ backend: "windows-sandbox", name: "Compiled", memoryMb: null, networking: "truthy" });
    assert.equal(definition.kind, "created");
    assert.deepEqual(trace, ["derive", "read", "owner", "helper", "clock", "clock", "claim"]);
    assert.equal(definition.device.memoryMb, null); assert.equal(definition.device.networking, true);
    assert.notEqual(definition.device.createdAt, definition.device.updatedAt);
    for (const point of ["read", "owner", "helper", "clock", "claim"]) {
        const fault = { direct: point }; const observed = [];
        const observe = (name, value) => () => { observed.push(name); if(name===point) throw fault; return value; };
        const app = direct.createWindowsSandboxCreate({ deriveDeviceId: observe("derive", "id"), readDefinitions: observe("read", []), readOwnerId: observe("owner", "owner"), ensureHelperWorkspace: observe("helper", { scratch:"owned" }), wallTimestamp: observe("clock", "time"), claimDefinition: observe("claim", {ok:true}) });
        assert.throws(()=>app.create({backend:"windows-sandbox",name:"Fault"}), error=>error===fault);
        const frozenOrder = ["derive", "read", "owner", "helper", "clock", "clock", "claim"];
        assert.deepEqual(observed, frozenOrder.slice(0, frozenOrder.indexOf(point)+1));
    }
    let duplicateEffects=0;
    const dupCore=direct.createWindowsSandboxCreate({deriveDeviceId:()=>"id",readDefinitions:()=>[{id:"id"}],readOwnerId:()=>{duplicateEffects++;return "owner";},ensureHelperWorkspace:()=>{duplicateEffects++;return {};},wallTimestamp:()=>{duplicateEffects++;return "time";},claimDefinition:()=>{duplicateEffects++;return {ok:true};}});
    assert.equal(dupCore.create({backend:"windows-sandbox"}).kind,"duplicate"); assert.equal(duplicateEffects,0);
    const created = await backend.handleWindowsTool("device_create", { backend: "windows-sandbox", deviceId: "shipping-create", name: "Shipping", memoryMb: "raw", networking: "yes" });
    assert.notEqual(created.isError, true);
    const stored = state.findOwnerDevice("windows", "shipping-create");
    assert.equal(stored.memoryMb, "raw"); assert.equal(stored.networking, true);
    const deviceRoot = path.join(process.env.HOME, ".ccc/devices/owners", ownerId(), "windows/shipping-create");
    for (const name of ["ccc-guest-helper.ps1", "ccc-guest-helper-bootstrap.ps1", "ccc-guest-helper-bootstrap.vbs"]) assert.ok(fs.readFileSync(path.join(deviceRoot, "tools", name), "utf8").length);
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(deviceRoot, "tools/ccc-guest-helper.ps1"))).digest("hex"), "4c00058569e0f42b95c542f329d35d546abfa01afb17a601d606c0849eeb4086");
    const duplicate = await backend.handleWindowsTool("device_create", { backend: "windows-sandbox", deviceId: "shipping-create", name: "Shipping" });
    assert.equal(duplicate.isError, true); assert.match(JSON.stringify(duplicate), /already exists/);
    assert.equal(deniedEffects, 0, "caught denial is still an unallocated effect");
    console.log(JSON.stringify({ consumer: "sandbox-direct-create", result: "PASS", layer: "compiled-public/native-helper", deniedEffects, allocatedMetadata, allocatedDiscovery }));
}

const LAB_STATE_DELIVERY_BASELINE = [{"name":"migrate","input":{"name":"migrate","previous":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"events":["runtime","volume","runtime","ps","extras","runtime","old","runtime","helper"],"error":null,"callsSha256":"36ae417e0ae9525d02c7158fb109325d27c1b33c8d23f65a0f36164783e4dc1b"},{"name":"verify","input":{"name":"verify"},"events":["runtime","volume","runtime","ps","extras","runtime","helper"],"error":null,"callsSha256":"2d166658bc991f98ca60c2cd6283b479125ae395a3f138e46fc2133ad4d355b6"},{"name":"empty-previous","input":{"name":"empty-previous","previous":""},"events":["runtime","volume","runtime","ps","extras","runtime","helper"],"error":null,"callsSha256":"2d166658bc991f98ca60c2cd6283b479125ae395a3f138e46fc2133ad4d355b6"},{"name":"absent","input":{"name":"absent","listed":""},"events":["runtime","volume"],"error":null,"callsSha256":"ae2c09ea7d8eb47815541555356b689e15b46447643ead09c4152e4b71180aa2"},{"name":"crlf-nonmatch","input":{"name":"crlf-nonmatch","listed":"ccc-example-lab-state\r\n"},"events":["runtime","volume"],"error":null,"callsSha256":"ae2c09ea7d8eb47815541555356b689e15b46447643ead09c4152e4b71180aa2"},{"name":"whitespace-nonmatch","input":{"name":"whitespace-nonmatch","listed":" ccc-example-lab-state\n"},"events":["runtime","volume"],"error":null,"callsSha256":"ae2c09ea7d8eb47815541555356b689e15b46447643ead09c4152e4b71180aa2"},{"name":"users-running","input":{"name":"users-running","users":"running\n"},"events":["runtime","volume","runtime","ps"],"error":{"name":"Error","message":"Lab state volume ccc-example-lab-state may be in use; finish its running work before retrying."},"callsSha256":"ab6bb8ae78a5c165c4db05f73d31162a7ea953a3ed9c7020f2b73060d0f14099"},{"name":"list-failure","input":{"name":"list-failure","listStatus":1},"events":["runtime","volume"],"error":{"name":"Error","message":"Unable to inspect lab state volumes."},"callsSha256":"ae2c09ea7d8eb47815541555356b689e15b46447643ead09c4152e4b71180aa2"},{"name":"users-failure","input":{"name":"users-failure","usersStatus":null},"events":["runtime","volume","runtime","ps"],"error":{"name":"Error","message":"Lab state volume ccc-example-lab-state may be in use; finish its running work before retrying."},"callsSha256":"ab6bb8ae78a5c165c4db05f73d31162a7ea953a3ed9c7020f2b73060d0f14099"},{"name":"old-invalid","input":{"name":"old-invalid","previous":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","old":"0:1001"},"events":["runtime","volume","runtime","ps","extras","runtime","old"],"error":{"name":"Error","message":"Cannot establish previous lab state owner for ccc-example-lab-state; no ownership was changed."},"callsSha256":"b17df65600c68fe64cf14b5e8684a6f0f0c95684511aad35277c2015d7d017ed"},{"name":"old-overflow","input":{"name":"old-overflow","previous":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","old":"1001:4294967295"},"events":["runtime","volume","runtime","ps","extras","runtime","old"],"error":{"name":"Error","message":"Cannot establish previous lab state owner for ccc-example-lab-state; no ownership was changed."},"callsSha256":"b17df65600c68fe64cf14b5e8684a6f0f0c95684511aad35277c2015d7d017ed"},{"name":"old-extra-output","input":{"name":"old-extra-output","previous":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","old":"1001:1002\nextra"},"events":["runtime","volume","runtime","ps","extras","runtime","old"],"error":{"name":"Error","message":"Cannot establish previous lab state owner for ccc-example-lab-state; no ownership was changed."},"callsSha256":"b17df65600c68fe64cf14b5e8684a6f0f0c95684511aad35277c2015d7d017ed"},{"name":"helper-failure","input":{"name":"helper-failure","previous":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","helperStatus":1},"events":["runtime","volume","runtime","ps","extras","runtime","old","runtime","helper"],"error":{"name":"Error","message":"Lab state ownership preparation failed for ccc-example-lab-state. Existing data was retained; repair its ownership before retrying."},"callsSha256":"36ae417e0ae9525d02c7158fb109325d27c1b33c8d23f65a0f36164783e4dc1b"},{"name":"extras-migrate","input":{"name":"extras-migrate","previous":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","extras":["--cgroups=disabled","--userns=keep-id:uid=1000,gid=1000"]},"events":["runtime","volume","runtime","ps","extras","runtime","old","runtime","helper"],"error":null,"callsSha256":"bc1638c8478a0cf0f818a34e4e6bcc3daa5e6cc2f0427cfea5015645cfcd2369"},{"name":"dynamic-identity-migrate","input":{"name":"dynamic-identity-migrate","previous":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","dynamic":true},"events":["runtime","volume","runtime","ps","extras","identity.uid","identity.gid","runtime","old","identity.uid","identity.gid","identity.uid","identity.gid","runtime","helper"],"error":null,"callsSha256":"a3609e9096d938a229c0d36a0f3a5082865f3a13354dfd777806c0ea50932f1a"},{"name":"dynamic-identity-verify","input":{"name":"dynamic-identity-verify","dynamic":true},"events":["runtime","volume","runtime","ps","extras","identity.uid","identity.gid","identity.uid","identity.gid","runtime","helper"],"error":null,"callsSha256":"681e8d291b1f9e70cee6fb858f38b186f4ba15666ce3fc8739566dfdae251bdd"},{"name":"invalid-volume","input":{"name":"invalid-volume","volume":"x,target=/host"},"events":[],"error":{"name":"Error","message":"Invalid lab state volume name."},"callsSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"name":"mutable-image","input":{"name":"mutable-image","image":"ccc:latest"},"events":[],"error":{"name":"Error","message":"Container identity requires an immutable sha256 image ID."},"callsSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"name":"mutable-previous","input":{"name":"mutable-previous","previous":"ccc:old"},"events":[],"error":{"name":"Error","message":"Container identity requires an immutable sha256 image ID."},"callsSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"name":"matched-owner","input":{"name":"matched-owner","previous":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","old":"2001:3001"},"events":["runtime","volume","runtime","ps","extras","runtime","old","runtime","helper"],"error":null,"callsSha256":"0460a5aaa5159651074a84a24f67a18c658a789d95478d930096dc7ced21cb5c"}];
async function verifyReviewedLabStateDelivery(payload, records) {
    const {default: assert} = await import("node:assert/strict");
    const {default: child} = await import("node:child_process");
    const {default: filesystem} = await import("node:fs");
    const {syncBuiltinESMExports} = await import("node:module");
    const {pathToFileURL} = await import("node:url");
    const {join} = await import("node:path");
    const {createHash} = await import("node:crypto");
    const savedFs = {readFileSync:filesystem.readFileSync};
    const blocked = () => {throw new Error("Unallocated Lab ownership native effect");};
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) child[name]=blocked;
    for (const name of ["writeFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "chmodSync", "chownSync", "lchownSync", "rmdirSync", "appendFileSync", "truncateSync"]) filesystem[name]=blocked;
    syncBuiltinESMExports();
    const facade=await import(pathToFileURL(join(payload,'dist/lab-state-ownership.js')).href);
    const runtime=await import(pathToFileURL(join(payload,'dist/container-runtime.js')).href);
    const app=await import(pathToFileURL(join(payload,'dist/application/container/lab-state-ownership.js')).href);
    assert.equal(facade.prepareLabStateOwnership.name,'prepareLabStateOwnership');
    assert.equal(facade.prepareLabStateOwnership.length,4);
    const volume='ccc-example-lab-state',image=`sha256:${'a'.repeat(64)}`,previous=`sha256:${'b'.repeat(64)}`;
    const options={encoding:'utf-8',timeout:300000};
    let checks=2;
    for(const record of records){
     const entry=record.input,calls=[],events=[];
     let uidReads=0,gidReads=0;
     const identity=entry.dynamic?{get uid(){events.push('identity.uid');return 2000+(++uidReads)},get gid(){events.push('identity.gid');return 3000+(++gidReads)},mapping:'host',contractVersion:'1'}:{uid:2001,gid:3001,mapping:'host',contractVersion:'1'};
     runtime._setRuntimeInfoForTest(entry.extras?{runtime:'podman',flavor:'podman-rootless',rootless:true,remote:false}:{runtime:'docker',flavor:'docker-native',rootless:false,remote:false});
     process.env.container='';process.env.CCC_PODMAN_CGROUPS=entry.extras?'disabled':'';
     child.spawnSync=(cli,args,supplied)=>{
      assert.ok(['docker','podman'].includes(cli));assert.deepEqual(supplied,options);
      assert.ok(['volume','ps','run'].includes(args[0]));calls.push([cli,args,supplied]);
      events.push(args[0]==='run'?(args.includes('--mount')?'helper':'old'):args[0]);
      if(args[0]==='volume')return {status:entry.listStatus??0,stdout:entry.listed??volume+'\n'};
      if(args[0]==='ps')return {status:'usersStatus' in entry?entry.usersStatus:0,stdout:entry.users??''};
      if(!args.includes('--mount'))return {status:0,stdout:entry.old??'1001:1002'};
      return {status:entry.helperStatus??0,stdout:''};
     };syncBuiltinESMExports();
     let error=null,value;
     try{value=facade.prepareLabStateOwnership(entry.volume??volume,entry.image??image,identity,entry.previous)}catch(e){error={name:e.name,message:e.message}}
     assert.equal(value,undefined,record.name);
     assert.deepEqual(error,record.error,record.name);

     assert.equal(createHash('sha256').update(JSON.stringify(calls)).digest('hex'),record.callsSha256,record.name+' complete native argv/options/scripts');
     assert.deepEqual(events,record.events.filter(event=>!['runtime','extras'].includes(event)),record.name+' native/principal trace');
     checks++;
    }
    for(const stage of ['volume','ps','old','helper']){
     for(const field of stage==='helper'?['error','status']:['error','status','stdout']){
      const failure=Symbol(stage+field),reads=[],calls=[];
      runtime._setRuntimeInfoForTest({runtime:'docker',flavor:'docker-native',rootless:false,remote:false});
      child.spawnSync=(cli,args,supplied)=>{
       calls.push([cli,args,supplied]);const selected=args[0]==='run'?(args.includes('--mount')?'helper':'old'):args[0];
       if(selected===stage)return {
        get error(){reads.push('error');if(field==='error')throw failure;return undefined},
        get status(){reads.push('status');if(field==='status')throw failure;return 0},
        get stdout(){reads.push('stdout');throw failure},
       };
       return {status:0,stdout:selected==='volume'?volume+'\n':selected==='old'?'1001:1002':''};
      };syncBuiltinESMExports();
      let caught;try{facade.prepareLabStateOwnership(volume,image,{uid:2001,gid:3001,mapping:'host',contractVersion:'1'},previous)}catch(e){caught=e}
      assert.equal(caught,failure,stage+field+' thrown identity');
      assert.deepEqual(reads,['error','status','stdout'].slice(0,['error','status','stdout'].indexOf(field)+1));
      assert.equal(calls.length,['volume','ps','old','helper'].indexOf(stage)+1);
      checks++;
     }
    }
    const scope=Object.freeze({}),principal={uid:2001,gid:3001},traces=[];
    const ports={normalizeImageId:value=>value,listVolumeNames:()=>({status:0,stdout:volume}),observeVolumeUsers:()=>({status:0,stdout:''}),captureHelperScope:()=>scope,observePreviousAccount:(selected,value)=>{assert.equal(selected,scope);assert.equal(value,previous);return {status:0,stdout:'1001:1002'}},applyOwnership:(selected,name,value,owner,intent)=>{assert.equal(selected,scope);assert.equal(owner,principal);traces.push([name,value,intent]);return {status:0}}};
    assert.equal(app.createLabStateOwnershipPreparation(ports).run(volume,image,principal,previous),undefined);
    assert.deepEqual(traces,[[volume,image,{kind:'migrate',oldUid:1001,oldGid:1002}]]);
    assert.throws(()=>app.createLabStateOwnershipPreparation({...ports,applyOwnership:undefined}),/callable applyOwnership/);
    checks+=2;
    child.spawnSync=blocked;syncBuiltinESMExports();
    const declaration=savedFs.readFileSync(join(payload,'dist/lab-state-ownership.d.ts'),'utf8');
    assert.equal(createHash('sha256').update(declaration).digest('hex'),"2d23ee95049473e23a2f79bbe1e240e423029874e078b72d8c992cbb3325d0c7");
    checks++;
}

async function verifyReviewedCodexStateDelivery(payload) {
    delete process.env.container;
    const { default: assert } = await import("node:assert/strict");
    const { default: fs } = await import("node:fs");
    const { default: cp } = await import("node:child_process");
    const { default: path } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const { syncBuiltinESMExports } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const module = name => import(pathToFileURL(path.join(payload, "dist", name + ".js")).href);
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[name] = () => { throw new Error("Unallocated retained-state native execution"); };
    syncBuiltinESMExports();
    const { createCodexStateOwnershipMigration } = await module("application/credentials/codex-state-ownership");
    const root = "/host/ccc/codex", trace = [];
    const principal = { uid: 1000, gid: 1000, mapping: "host", contractVersion: "1" };
    const previous = { Image: "old", Mounts: [{ Type: "bind", Source: root, Destination: "/home/ccc/.codex" }] };
    const facts = { mode: 0o40755n, uid: 1000n, gid: 1000n, dev: 8n, ino: 9n,
        isDirectory() { assert.equal(this, facts); return true; }, isSymbolicLink() { assert.equal(this, facts); return false; } };
    const ports = { managedRoot: profile => { trace.push(["root", profile]); return root; }, nestedContainerMarker: () => "",
        runtime: () => ({ rootless: false, flavor: "docker-native" }), platform: () => "linux", effectiveUid: () => 1000, effectiveGid: () => 1000,
        normalizeImage: image => image, previousAccount: () => "1001:1002", directory: selected => { trace.push(["stat", selected]); return facts; },
        parent: path.posix.dirname, activeIds: () => { trace.push(["ps"]); return ""; }, inspectActive: () => "[]",
        isAbsolute: path.posix.isAbsolute, realpath: selected => selected, separator: "/",
        migrate: (...args) => { trace.push(["helper", ...args]); return undefined; } };
    const app = createCodexStateOwnershipMigration(ports);
    assert.equal(app.run(previous, "new", principal, "private"), undefined);
    assert.deepEqual(trace.filter(row => row[0] === "stat"), Array.from({ length: 2 }, () => [root, "/host/ccc", "/host", "/"].map(selected => ["stat", selected])).flat());
    assert.deepEqual(trace.at(-1), ["helper", root, "new", "1001", "1002", "1000", "1000", { dev: "8", ino: "9" }]);
    trace.length = 0; app.run(previous, "new", { ...principal, mapping: "desktop" }, "private"); assert.deepEqual(trace, [["root", "private"]]);
    const alias = { Image: "old", Mounts: [{ Type: "bind", Source: "/alias", Destination: "/home/ccc/.codex" }] };
    let proofReceiver = "unset";
    app.run(alias, "new", principal, undefined, function(source) { assert.equal(source, "/alias"); proofReceiver = this; return true; });
    assert.equal(proofReceiver, undefined);
    const raw = Symbol("proof fault"); assert.throws(() => app.run(alias, "new", principal, undefined, () => { throw raw; }), value => value === raw);
    assert.throws(() => createCodexStateOwnershipMigration({ ...ports, effectiveUid: () => undefined }).run(previous, "new", principal), /Unsupported host mapping/);
    for (const source of [root, "/host/ccc", root + "/child", "/"]) {
        trace.length = 0;
        assert.throws(() => createCodexStateOwnershipMigration({ ...ports, activeIds: () => "active", inspectActive: () => JSON.stringify([{ Id: "active", Mounts: [{ Type: "bind", Source: source }] }]) }).run(previous, "new", principal), /in use/);
        assert.equal(trace.some(row => row[0] === "helper"), false);
    }
    let roots = 0;
    assert.throws(() => createCodexStateOwnershipMigration({ ...ports, directory: selected => ({ ...facts, ino: selected === root && ++roots === 2 ? 99n : 9n, isDirectory: () => true, isSymbolicLink: () => false }) }).run(previous, "new", principal), /root changed/);
    const originalStat = fs.lstatSync, originalRealpath = fs.realpathSync;
    Object.defineProperty(process, "geteuid", { value: () => 1000, configurable: true });
    Object.defineProperty(process, "getegid", { value: () => 1000, configurable: true });
    let nativeRoot, nativeTrace = [];
    fs.lstatSync = (selected, options) => {
        if (!options?.bigint) return originalStat(selected, options);
        nativeTrace.push(["stat", selected]); return facts;
    };
    fs.realpathSync = selected => selected;
    cp.spawnSync = (command, args, options) => {
        assert.equal(command, "docker"); nativeTrace.push(["native", args]);
        assert.equal(options.timeout, 300000); assert.equal(options.maxBuffer, 4 * 1024 * 1024);
        if (args[0] === "ps") return { status: 0, stdout: "", stderr: "" };
        assert.equal(args[0], "run");
        if (!args.includes("--mount")) return { status: 0, stdout: "1001:1002", stderr: "" };
        assert.ok(args.includes(`type=bind,src=${nativeRoot},dst=/state`));
        assert.deepEqual(args.slice(-7), ["/state", "1001", "1002", "1000", "1000", "8", "9"]);
        return { status: 0, stdout: "", stderr: "" };
    };
    syncBuiltinESMExports();
    const runtime = await module("container-runtime"); runtime._setRuntimeInfoForTest({ runtime: "docker", flavor: "docker-native", rootless: false, remote: false });
    const facade = await module("codex-state-ownership");
    const utils = await module("utils"); nativeRoot = utils.getCodexDir();
    assert.ok(nativeRoot.startsWith(process.env.HOME + path.sep));
    for (const [name, expected] of [["codexStateMigrationScript", "d012cb4ab27db4f53aa5e450b151e5185eed5e12d0b6bac50fab76bbf04f964d"], ["codexStateAccessScript", "ca84f846e3ecb81751227a7f310d5a366083870eea2e6bbf7fcb9f6540a9893d"]]) {
        assert.equal(createHash("sha256").update(facade[name]).digest("hex"), expected, `retained native ${name}`);
    }
    const oldImage = "sha256:" + "a".repeat(64), image = "sha256:" + "b".repeat(64);
    const actualPrevious = { Image: oldImage, Mounts: [{ Type: "bind", Source: nativeRoot, Destination: "/home/ccc/.codex" }] };
    assert.equal(facade.prepareCodexStateOwnership(actualPrevious, image, principal), undefined);
    assert.equal(nativeTrace.filter(row => row[0] === "native" && row[1].includes("--mount")).length, 1, "one actual helper dispatch");
    const ancestors = []; for (let selected = nativeRoot;; selected = path.dirname(selected)) { ancestors.push(selected); if (path.dirname(selected) === selected) break; }
    assert.deepEqual(nativeTrace.filter(row => row[0] === "stat").map(row => row[1]), [...ancestors, ...ancestors], "two complete actual facade traversals");
    nativeTrace = []; facade.prepareCodexStateOwnership(actualPrevious, image, { ...principal, mapping: "desktop" }); assert.deepEqual(nativeTrace, []);
    fs.lstatSync = originalStat; fs.realpathSync = originalRealpath;
}

const REVIEWED_SANDBOX_DECLARATION_CONSUMER = "import { createWindowsSandboxStop } from \"./reviewed-sandbox-declarations/application/lifecycle/windows-sandbox-stop.mjs\";\nimport type { WindowsSandboxStopPorts } from \"./reviewed-sandbox-declarations/ports/lifecycle/windows-sandbox-stop.mjs\";\nimport type { IsoTimestamp, WindowsSandboxLifecycleDevice } from \"./reviewed-sandbox-declarations/domain/lifecycle/windows-sandbox-stop.mjs\";\n\ntype Ports = WindowsSandboxStopPorts<{ handle: 'native' }, { receipt: 'opaque' }>;\nconst ports: Ports = {\n    readSingleton: () => null, sameSingletonOwner: () => false, newRuntimeId: () => \"operation\", wallTimestamp: () => \"2026-10-08T00:00:00.000Z\",\n    transitionDevice: () => ({ found: true, matched: true }), findDevice: () => undefined,\n    claimSingleton: () => ({ ok: false, error: \"foreign\" }), releaseSingleton: () => false, singletonGenerationMatches: () => false,\n    watchdogCancelPath: () => \"cancel\", cancelWatchdog: cancelPath => ({ attempted: true, ok: true, cancelPath }),\n    discoverRuntime: () => ({ available: true, missing: [], binding: { handle: \"native\" } }), stopOwnedRuntime: () => ({ ok: false, evidence: { receipt: \"opaque\" } }),\n};\nfunction contracts() {\n    const app = createWindowsSandboxStop(ports);\n    const result = app.stop(\"target\");\n    if (result.kind === \"completed\") { const status: string = result.device.status; const claim: string | null | undefined = result.device.singletonClaimId; void [status, claim]; }\n    if (result.kind === \"native-failure\") { const receipt: \"opaque\" = result.evidence.receipt; void receipt; }\n    const device: WindowsSandboxLifecycleDevice = { id: \"target\", status: \"running\", sandboxId: undefined, singletonClaimId: null, lifecycle: undefined, helperSessionLaunch: null };\n    app.stopDevice(device);\n    // @ts-expect-error No ambient ports.\n    createWindowsSandboxStop();\n    // @ts-expect-error All semantic ports are required.\n    createWindowsSandboxStop({ findDevice: () => device });\n    // @ts-expect-error stop is synchronous.\n    const asynchronous: Promise<unknown> = app.stop(\"target\");\n    // @ts-expect-error Native wall timestamp carrier is narrow.\n    const badTimestamp: IsoTimestamp = \"yesterday\";\n    // @ts-expect-error A thenable is not a helper metadata carrier.\n    const badHelper: WindowsSandboxLifecycleDevice = { id: \"target\", status: \"running\", helperSessionLaunch: Promise.resolve({ ok: true }) };\n    // @ts-expect-error Narrow claim carrier rejects unknown.\n    const badClaim: WindowsSandboxLifecycleDevice = { id: \"target\", status: \"running\", singletonClaimId: {} as unknown };\n    // @ts-expect-error Unknown read results are rejected.\n    createWindowsSandboxStop({ ...ports, findDevice: (): unknown => device });\n    // @ts-expect-error Unknown native observations are rejected.\n    createWindowsSandboxStop({ ...ports, stopOwnedRuntime: (): unknown => ({ ok: true }) });\n    // @ts-expect-error Read is synchronous.\n    createWindowsSandboxStop({ ...ports, findDevice: async () => device });\n    // @ts-expect-error Singleton read is synchronous.\n    createWindowsSandboxStop({ ...ports, readSingleton: async () => null });\n    // @ts-expect-error Owner check is synchronous.\n    createWindowsSandboxStop({ ...ports, sameSingletonOwner: async () => true });\n    // @ts-expect-error ID is synchronous.\n    createWindowsSandboxStop({ ...ports, newRuntimeId: async () => \"operation\" });\n    // @ts-expect-error Timestamp is synchronous.\n    createWindowsSandboxStop({ ...ports, wallTimestamp: async () => \"2026-10-08T00:00:00.000Z\" });\n    // @ts-expect-error CAS is synchronous.\n    createWindowsSandboxStop({ ...ports, transitionDevice: async () => ({ matched: true, found: true }) });\n    // @ts-expect-error Claim is synchronous.\n    createWindowsSandboxStop({ ...ports, claimSingleton: async () => ({ ok: false, error: \"busy\" }) });\n    // @ts-expect-error Release is synchronous.\n    createWindowsSandboxStop({ ...ports, releaseSingleton: async () => true });\n    // @ts-expect-error Generation is synchronous.\n    createWindowsSandboxStop({ ...ports, singletonGenerationMatches: async () => true });\n    // @ts-expect-error Metadata is synchronous.\n    createWindowsSandboxStop({ ...ports, watchdogCancelPath: async () => \"cancel\" });\n    // @ts-expect-error Cancellation is synchronous.\n    createWindowsSandboxStop({ ...ports, cancelWatchdog: async cancelPath => ({ attempted: true, ok: true, cancelPath }) });\n    // @ts-expect-error Discovery is synchronous.\n    createWindowsSandboxStop({ ...ports, discoverRuntime: async () => ({ available: true, missing: [], binding: { handle: \"native\" } }) });\n    // @ts-expect-error Runtime stop is synchronous.\n    createWindowsSandboxStop({ ...ports, stopOwnedRuntime: async () => ({ ok: true, evidence: { receipt: \"opaque\" } }) });\n    void [asynchronous, badTimestamp, badHelper, badClaim];\n}\nvoid contracts;\n";

// Captured before extraction in identity-image-baseline-01a11c09/witness.cjs.
// expected.json SHA256 cb9d929cd5b6db8e497911e4c955eb9783535b81c925619d1f4bd3b18b948990
// witness.cjs SHA256 adf8578985a6063c2ded5616ef34e31fa756ee522e6de5f776201617094796b6
// These eight records retain native argv, scripts, hash and JSON observation order.
const IDENTITY_IMAGE_SHIPPING_BASELINE = [{"scenario":"cache","arity":{"normalizeImageId":1,"resolveContainerIdentity":0,"getIdentityLabels":1,"getIdentityMiseVolumeName":1,"getIdentityCodexPackagesVolumeName":1,"ensureIdentityImage":2},"outcome":{"value":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"resolutions":[{"reads":["runtime","rootless"],"value":{"error":"Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership."}},{"reads":["runtime","runtime","rootless","flavor"],"value":{"uid":1000,"gid":1000,"mapping":"podman-keep-id","contractVersion":"1"}},{"reads":["runtime","rootless","flavor","runtime"],"value":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"}}],"publicFacts":{"defaultIdentity":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"},"labels":{"ccc.identity.version":"1","ccc.identity.uid":"1234","ccc.identity.gid":"2345","ccc.identity.mapping":"host"},"mise":"ccc-mise-cache-v1-host-1234-2345","codex":"ccc-codex-packages-v1-host-1234-2345","normalized":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","constant":"1"},"events":[["createHash","sha256"],["hash.get","update"],["JSON.stringify"],["hash.update","{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"],["hash.get","digest"],["locksDir"],["lock","/frozen-locks/identity-04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9.lock",{"waitMs":1260000,"reclaimStale":false}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["extraRunArgs"],["runtimeCli"],["spawn","docker",["run","--rm","--network","none","--frozen-runtime","--user","ccc","--entrypoint","/bin/sh","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","-c","set -eu; test \"$(id -un)\" = ccc; test \"$(getent passwd ccc | cut -d: -f6)\" = /home/ccc; test \"$(getent group ccc | cut -d: -f3)\" = \"$(id -g)\"; sudo -n true; printf \"%s:%s:%s:ccc\\n\" \"$(id -u)\" \"$(id -g)\" \"$HOME\""],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["unlock"]],"labelsJSON":"{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","hash":"04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"},{"scenario":"inspect-getters","arity":{"normalizeImageId":1,"resolveContainerIdentity":0,"getIdentityLabels":1,"getIdentityMiseVolumeName":1,"getIdentityCodexPackagesVolumeName":1,"ensureIdentityImage":2},"outcome":{"value":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"resolutions":[{"reads":["runtime","rootless"],"value":{"error":"Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership."}},{"reads":["runtime","runtime","rootless","flavor"],"value":{"uid":1000,"gid":1000,"mapping":"podman-keep-id","contractVersion":"1"}},{"reads":["runtime","rootless","flavor","runtime"],"value":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"}}],"publicFacts":{"defaultIdentity":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"},"labels":{"ccc.identity.version":"1","ccc.identity.uid":"1234","ccc.identity.gid":"2345","ccc.identity.mapping":"host"},"mise":"ccc-mise-cache-v1-host-1234-2345","codex":"ccc-codex-packages-v1-host-1234-2345","normalized":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","constant":"1"},"events":[["createHash","sha256"],["hash.get","update"],["JSON.stringify"],["hash.update","{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"],["hash.get","digest"],["locksDir"],["lock","/frozen-locks/identity-04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9.lock",{"waitMs":1260000,"reclaimStale":false}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["get","image.Id"],["get","image.Config"],["get","image.Config.User"],["get","image.Config"],["get","image.Config.Labels"],["get","image.Config.Labels.ccc.identity.version"],["get","image.Config"],["get","image.Config.Labels"],["get","image.Config.Labels.ccc.identity.uid"],["get","image.Config"],["get","image.Config.Labels"],["get","image.Config.Labels.ccc.identity.gid"],["get","image.Config"],["get","image.Config.Labels"],["get","image.Config.Labels.ccc.identity.mapping"],["get","image.Config"],["get","image.Config.Labels"],["get","image.Config.Labels.ccc.identity.base"],["extraRunArgs"],["get","image.Id"],["runtimeCli"],["spawn","docker",["run","--rm","--network","none","--frozen-runtime","--user","ccc","--entrypoint","/bin/sh","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","-c","set -eu; test \"$(id -un)\" = ccc; test \"$(getent passwd ccc | cut -d: -f6)\" = /home/ccc; test \"$(getent group ccc | cut -d: -f3)\" = \"$(id -g)\"; sudo -n true; printf \"%s:%s:%s:ccc\\n\" \"$(id -u)\" \"$(id -g)\" \"$HOME\""],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["get","image.Id"],["unlock"]],"labelsJSON":"{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","hash":"04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"},{"scenario":"build","arity":{"normalizeImageId":1,"resolveContainerIdentity":0,"getIdentityLabels":1,"getIdentityMiseVolumeName":1,"getIdentityCodexPackagesVolumeName":1,"ensureIdentityImage":2},"outcome":{"value":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"resolutions":[{"reads":["runtime","rootless"],"value":{"error":"Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership."}},{"reads":["runtime","runtime","rootless","flavor"],"value":{"uid":1000,"gid":1000,"mapping":"podman-keep-id","contractVersion":"1"}},{"reads":["runtime","rootless","flavor","runtime"],"value":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"}}],"publicFacts":{"defaultIdentity":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"},"labels":{"ccc.identity.version":"1","ccc.identity.uid":"1234","ccc.identity.gid":"2345","ccc.identity.mapping":"host"},"mise":"ccc-mise-cache-v1-host-1234-2345","codex":"ccc-codex-packages-v1-host-1234-2345","normalized":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","constant":"1"},"events":[["createHash","sha256"],["hash.get","update"],["JSON.stringify"],["hash.update","{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"],["hash.get","digest"],["locksDir"],["lock","/frozen-locks/identity-04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9.lock",{"waitMs":1260000,"reclaimStale":false}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["runtimeCli"],["spawn","docker",["tag","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ccc-identity-base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["runtimeCli"],["spawn","docker",["build","--pull=false","-t","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9","-"],{"encoding":"utf-8","input":"FROM ccc-identity-base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nUSER root\nRUN set -eu; old_uid=$(id -u ccc); old_gid=$(id -g ccc); collision=$(getent passwd 1234 | cut -d: -f1 || true); if [ -n \"$collision\" ] && [ \"$collision\" != ccc ]; then if [ \"1234\" = 1000 ] && [ \"$collision\" = ubuntu ] && [ \"$(getent passwd ubuntu | cut -d: -f6)\" = /home/ubuntu ]; then userdel ubuntu; else echo \"Target UID belongs to an unrelated image account\" >&2; exit 1; fi; fi; groupmod -o -g 2345 ccc; usermod -u 1234 -g ccc ccc; for dir in /home/ccc /opt/ccc /host-stage; do if [ -d \"$dir\" ] && [ ! -L \"$dir\" ]; then if [ \"$old_uid\" != \"1234\" ]; then find -P \"$dir\" -xdev -uid \"$old_uid\" -exec chown -h 1234 {} +; fi; if [ \"$old_gid\" != \"2345\" ]; then find -P \"$dir\" -xdev -gid \"$old_gid\" -exec chgrp -h 2345 {} +; fi; fi; done; test \"$(id -u ccc)\" = 1234; test \"$(id -g ccc)\" = 2345; test \"$(getent passwd ccc | cut -d: -f6)\" = /home/ccc\nENV HOME=/home/ccc\nLABEL ccc.identity.version=\"1\"\nLABEL ccc.identity.uid=\"1234\"\nLABEL ccc.identity.gid=\"2345\"\nLABEL ccc.identity.mapping=\"host\"\nLABEL ccc.identity.base=\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"\nUSER ccc\n","timeout":1200000,"maxBuffer":16777216}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["extraRunArgs"],["runtimeCli"],["spawn","docker",["run","--rm","--network","none","--frozen-runtime","--user","ccc","--entrypoint","/bin/sh","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","-c","set -eu; test \"$(id -un)\" = ccc; test \"$(getent passwd ccc | cut -d: -f6)\" = /home/ccc; test \"$(getent group ccc | cut -d: -f3)\" = \"$(id -g)\"; sudo -n true; printf \"%s:%s:%s:ccc\\n\" \"$(id -u)\" \"$(id -g)\" \"$HOME\""],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["unlock"]],"labelsJSON":"{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","hash":"04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"},{"scenario":"inspect-throw","arity":{"normalizeImageId":1,"resolveContainerIdentity":0,"getIdentityLabels":1,"getIdentityMiseVolumeName":1,"getIdentityCodexPackagesVolumeName":1,"ensureIdentityImage":2},"outcome":{"error":"inspect spawn throws"},"resolutions":[{"reads":["runtime","rootless"],"value":{"error":"Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership."}},{"reads":["runtime","runtime","rootless","flavor"],"value":{"uid":1000,"gid":1000,"mapping":"podman-keep-id","contractVersion":"1"}},{"reads":["runtime","rootless","flavor","runtime"],"value":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"}}],"publicFacts":{"defaultIdentity":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"},"labels":{"ccc.identity.version":"1","ccc.identity.uid":"1234","ccc.identity.gid":"2345","ccc.identity.mapping":"host"},"mise":"ccc-mise-cache-v1-host-1234-2345","codex":"ccc-codex-packages-v1-host-1234-2345","normalized":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","constant":"1"},"events":[["createHash","sha256"],["hash.get","update"],["JSON.stringify"],["hash.update","{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"],["hash.get","digest"],["locksDir"],["lock","/frozen-locks/identity-04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9.lock",{"waitMs":1260000,"reclaimStale":false}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["unlock"]],"labelsJSON":"{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","hash":"04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"},{"scenario":"tag-fail","arity":{"normalizeImageId":1,"resolveContainerIdentity":0,"getIdentityLabels":1,"getIdentityMiseVolumeName":1,"getIdentityCodexPackagesVolumeName":1,"ensureIdentityImage":2},"outcome":{"error":"Container identity tag failed: exit 2\ntag detail"},"resolutions":[{"reads":["runtime","rootless"],"value":{"error":"Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership."}},{"reads":["runtime","runtime","rootless","flavor"],"value":{"uid":1000,"gid":1000,"mapping":"podman-keep-id","contractVersion":"1"}},{"reads":["runtime","rootless","flavor","runtime"],"value":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"}}],"publicFacts":{"defaultIdentity":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"},"labels":{"ccc.identity.version":"1","ccc.identity.uid":"1234","ccc.identity.gid":"2345","ccc.identity.mapping":"host"},"mise":"ccc-mise-cache-v1-host-1234-2345","codex":"ccc-codex-packages-v1-host-1234-2345","normalized":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","constant":"1"},"events":[["createHash","sha256"],["hash.get","update"],["JSON.stringify"],["hash.update","{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"],["hash.get","digest"],["locksDir"],["lock","/frozen-locks/identity-04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9.lock",{"waitMs":1260000,"reclaimStale":false}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["runtimeCli"],["spawn","docker",["tag","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ccc-identity-base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["unlock"]],"labelsJSON":"{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","hash":"04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"},{"scenario":"build-fail","arity":{"normalizeImageId":1,"resolveContainerIdentity":0,"getIdentityLabels":1,"getIdentityMiseVolumeName":1,"getIdentityCodexPackagesVolumeName":1,"ensureIdentityImage":2},"outcome":{"error":"Container identity build failed: native build error\n x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x x"},"resolutions":[{"reads":["runtime","rootless"],"value":{"error":"Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership."}},{"reads":["runtime","runtime","rootless","flavor"],"value":{"uid":1000,"gid":1000,"mapping":"podman-keep-id","contractVersion":"1"}},{"reads":["runtime","rootless","flavor","runtime"],"value":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"}}],"publicFacts":{"defaultIdentity":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"},"labels":{"ccc.identity.version":"1","ccc.identity.uid":"1234","ccc.identity.gid":"2345","ccc.identity.mapping":"host"},"mise":"ccc-mise-cache-v1-host-1234-2345","codex":"ccc-codex-packages-v1-host-1234-2345","normalized":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","constant":"1"},"events":[["createHash","sha256"],["hash.get","update"],["JSON.stringify"],["hash.update","{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"],["hash.get","digest"],["locksDir"],["lock","/frozen-locks/identity-04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9.lock",{"waitMs":1260000,"reclaimStale":false}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["runtimeCli"],["spawn","docker",["tag","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ccc-identity-base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["runtimeCli"],["spawn","docker",["build","--pull=false","-t","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9","-"],{"encoding":"utf-8","input":"FROM ccc-identity-base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nUSER root\nRUN set -eu; old_uid=$(id -u ccc); old_gid=$(id -g ccc); collision=$(getent passwd 1234 | cut -d: -f1 || true); if [ -n \"$collision\" ] && [ \"$collision\" != ccc ]; then if [ \"1234\" = 1000 ] && [ \"$collision\" = ubuntu ] && [ \"$(getent passwd ubuntu | cut -d: -f6)\" = /home/ubuntu ]; then userdel ubuntu; else echo \"Target UID belongs to an unrelated image account\" >&2; exit 1; fi; fi; groupmod -o -g 2345 ccc; usermod -u 1234 -g ccc ccc; for dir in /home/ccc /opt/ccc /host-stage; do if [ -d \"$dir\" ] && [ ! -L \"$dir\" ]; then if [ \"$old_uid\" != \"1234\" ]; then find -P \"$dir\" -xdev -uid \"$old_uid\" -exec chown -h 1234 {} +; fi; if [ \"$old_gid\" != \"2345\" ]; then find -P \"$dir\" -xdev -gid \"$old_gid\" -exec chgrp -h 2345 {} +; fi; fi; done; test \"$(id -u ccc)\" = 1234; test \"$(id -g ccc)\" = 2345; test \"$(getent passwd ccc | cut -d: -f6)\" = /home/ccc\nENV HOME=/home/ccc\nLABEL ccc.identity.version=\"1\"\nLABEL ccc.identity.uid=\"1234\"\nLABEL ccc.identity.gid=\"2345\"\nLABEL ccc.identity.mapping=\"host\"\nLABEL ccc.identity.base=\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"\nUSER ccc\n","timeout":1200000,"maxBuffer":16777216}],["unlock"]],"labelsJSON":"{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","hash":"04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"},{"scenario":"invalid-built","arity":{"normalizeImageId":1,"resolveContainerIdentity":0,"getIdentityLabels":1,"getIdentityMiseVolumeName":1,"getIdentityCodexPackagesVolumeName":1,"ensureIdentityImage":2},"outcome":{"error":"Built container identity image failed UID/GID, HOME, sudo or named-user validation. Retry after correcting the base image."},"resolutions":[{"reads":["runtime","rootless"],"value":{"error":"Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership."}},{"reads":["runtime","runtime","rootless","flavor"],"value":{"uid":1000,"gid":1000,"mapping":"podman-keep-id","contractVersion":"1"}},{"reads":["runtime","rootless","flavor","runtime"],"value":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"}}],"publicFacts":{"defaultIdentity":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"},"labels":{"ccc.identity.version":"1","ccc.identity.uid":"1234","ccc.identity.gid":"2345","ccc.identity.mapping":"host"},"mise":"ccc-mise-cache-v1-host-1234-2345","codex":"ccc-codex-packages-v1-host-1234-2345","normalized":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","constant":"1"},"events":[["createHash","sha256"],["hash.get","update"],["JSON.stringify"],["hash.update","{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"],["hash.get","digest"],["locksDir"],["lock","/frozen-locks/identity-04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9.lock",{"waitMs":1260000,"reclaimStale":false}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["runtimeCli"],["spawn","docker",["tag","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ccc-identity-base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["runtimeCli"],["spawn","docker",["build","--pull=false","-t","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9","-"],{"encoding":"utf-8","input":"FROM ccc-identity-base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nUSER root\nRUN set -eu; old_uid=$(id -u ccc); old_gid=$(id -g ccc); collision=$(getent passwd 1234 | cut -d: -f1 || true); if [ -n \"$collision\" ] && [ \"$collision\" != ccc ]; then if [ \"1234\" = 1000 ] && [ \"$collision\" = ubuntu ] && [ \"$(getent passwd ubuntu | cut -d: -f6)\" = /home/ubuntu ]; then userdel ubuntu; else echo \"Target UID belongs to an unrelated image account\" >&2; exit 1; fi; fi; groupmod -o -g 2345 ccc; usermod -u 1234 -g ccc ccc; for dir in /home/ccc /opt/ccc /host-stage; do if [ -d \"$dir\" ] && [ ! -L \"$dir\" ]; then if [ \"$old_uid\" != \"1234\" ]; then find -P \"$dir\" -xdev -uid \"$old_uid\" -exec chown -h 1234 {} +; fi; if [ \"$old_gid\" != \"2345\" ]; then find -P \"$dir\" -xdev -gid \"$old_gid\" -exec chgrp -h 2345 {} +; fi; fi; done; test \"$(id -u ccc)\" = 1234; test \"$(id -g ccc)\" = 2345; test \"$(getent passwd ccc | cut -d: -f6)\" = /home/ccc\nENV HOME=/home/ccc\nLABEL ccc.identity.version=\"1\"\nLABEL ccc.identity.uid=\"1234\"\nLABEL ccc.identity.gid=\"2345\"\nLABEL ccc.identity.mapping=\"host\"\nLABEL ccc.identity.base=\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"\nUSER ccc\n","timeout":1200000,"maxBuffer":16777216}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["runtimeCli"],["spawn","docker",["image","rm","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["unlock"]],"labelsJSON":"{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","hash":"04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"},{"scenario":"remove-throw","arity":{"normalizeImageId":1,"resolveContainerIdentity":0,"getIdentityLabels":1,"getIdentityMiseVolumeName":1,"getIdentityCodexPackagesVolumeName":1,"ensureIdentityImage":2},"outcome":{"error":"removal throws"},"resolutions":[{"reads":["runtime","rootless"],"value":{"error":"Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership."}},{"reads":["runtime","runtime","rootless","flavor"],"value":{"uid":1000,"gid":1000,"mapping":"podman-keep-id","contractVersion":"1"}},{"reads":["runtime","rootless","flavor","runtime"],"value":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"}}],"publicFacts":{"defaultIdentity":{"uid":1234,"gid":2345,"mapping":"host","contractVersion":"1"},"labels":{"ccc.identity.version":"1","ccc.identity.uid":"1234","ccc.identity.gid":"2345","ccc.identity.mapping":"host"},"mise":"ccc-mise-cache-v1-host-1234-2345","codex":"ccc-codex-packages-v1-host-1234-2345","normalized":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","constant":"1"},"events":[["createHash","sha256"],["hash.get","update"],["JSON.stringify"],["hash.update","{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"],["hash.get","digest"],["locksDir"],["lock","/frozen-locks/identity-04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9.lock",{"waitMs":1260000,"reclaimStale":false}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["runtimeCli"],["spawn","docker",["tag","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ccc-identity-base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["runtimeCli"],["spawn","docker",["build","--pull=false","-t","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9","-"],{"encoding":"utf-8","input":"FROM ccc-identity-base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nUSER root\nRUN set -eu; old_uid=$(id -u ccc); old_gid=$(id -g ccc); collision=$(getent passwd 1234 | cut -d: -f1 || true); if [ -n \"$collision\" ] && [ \"$collision\" != ccc ]; then if [ \"1234\" = 1000 ] && [ \"$collision\" = ubuntu ] && [ \"$(getent passwd ubuntu | cut -d: -f6)\" = /home/ubuntu ]; then userdel ubuntu; else echo \"Target UID belongs to an unrelated image account\" >&2; exit 1; fi; fi; groupmod -o -g 2345 ccc; usermod -u 1234 -g ccc ccc; for dir in /home/ccc /opt/ccc /host-stage; do if [ -d \"$dir\" ] && [ ! -L \"$dir\" ]; then if [ \"$old_uid\" != \"1234\" ]; then find -P \"$dir\" -xdev -uid \"$old_uid\" -exec chown -h 1234 {} +; fi; if [ \"$old_gid\" != \"2345\" ]; then find -P \"$dir\" -xdev -gid \"$old_gid\" -exec chgrp -h 2345 {} +; fi; fi; done; test \"$(id -u ccc)\" = 1234; test \"$(id -g ccc)\" = 2345; test \"$(getent passwd ccc | cut -d: -f6)\" = /home/ccc\nENV HOME=/home/ccc\nLABEL ccc.identity.version=\"1\"\nLABEL ccc.identity.uid=\"1234\"\nLABEL ccc.identity.gid=\"2345\"\nLABEL ccc.identity.mapping=\"host\"\nLABEL ccc.identity.base=\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"\nUSER ccc\n","timeout":1200000,"maxBuffer":16777216}],["runtimeCli"],["spawn","docker",["image","inspect","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":30000}],["runtimeCli"],["spawn","docker",["image","rm","ccc-identity:04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"],{"encoding":"utf-8","timeout":600000,"maxBuffer":16777216}],["unlock"]],"labelsJSON":"{\"ccc.identity.version\":\"1\",\"ccc.identity.uid\":\"1234\",\"ccc.identity.gid\":\"2345\",\"ccc.identity.mapping\":\"host\",\"ccc.identity.base\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","hash":"04bf9d1a3bd083a299674e4a7c3213cafbeaef28f2e4d79d74aac4ca575cb8e9"}];
async function verifyProviderRuntimeWave(payload, golden) {
    const {default: assert} = await import('node:assert/strict');
    const {default: fs} = await import('node:fs');
    const path = await import('node:path');
    const vm = await import('node:vm');
    const crypto = await import('node:crypto');
    const {pathToFileURL} = await import('node:url');
    const {default: cp} = await import('node:child_process');
    const {syncBuiltinESMExports} = await import('node:module');
    const denied = () => { throw new Error('Unallocated provider/runtime wave effect'); };
    for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[key]=denied;
    const net = (await import('node:net')).default;
    net.connect=net.createConnection=denied;
    globalThis.fetch=denied;
    syncBuiltinESMExports();
    const baseId='sha256:'+'a'.repeat(64), builtId='b'.repeat(64);
    const identity={uid:1234,gid:2345,mapping:'host',contractVersion:'1'};
function identityWitness(source, scenario) {
  const events = [];
  let inspectCount = 0;
  const runtime = {runtime:'docker',rootless:false,flavor:'docker-native'};
  const labels = {'ccc.identity.version':'1','ccc.identity.uid':'1234','ccc.identity.gid':'2345','ccc.identity.mapping':'host','ccc.identity.base':baseId};
  const result = (stdout='',status=0,stderr='') => ({stdout,status,stderr});
  function spawnSync(cli,args,options) {
    events.push(['spawn',cli,args,options]);
    if (args[0] === 'image' && args[1] === 'inspect') {
      inspectCount++;
      if (scenario === 'inspect-throw') throw new Error('inspect spawn throws');
      if (!['cache','inspect-getters'].includes(scenario) && inspectCount === 1) return result('',1);
      if (scenario === 'invalid-built' || scenario === 'remove-throw') return result('{broken');
      return result(JSON.stringify([{Id:builtId,Config:{User:'ccc',Labels:labels}}]));
    }
    if (args[0] === 'tag' && scenario === 'tag-fail') return result('',2,'tag detail');
    if (args[0] === 'build' && scenario === 'build-fail') return { ...result('',9,' x'.repeat(3000)+'  '),error:new Error('native build error') };
    if (args[0] === 'image' && args[1] === 'rm' && scenario === 'remove-throw') throw new Error('removal throws');
    if (args[0] === 'run') return result('1234:2345:/home/ccc:ccc\n');
    return result();
  }
  const native = {
    child_process:{spawnSync}, crypto:{createHash: algorithm => { events.push(['createHash',algorithm]); const hash=crypto.createHash(algorithm); return new Proxy(hash,{get(target,key){events.push(['hash.get',String(key)]); const value=target[key]; if(key === 'update') return function(...args){events.push(['hash.update',...args]);target.update(...args);return new Proxy(target,{get(t,k){events.push(['hash.get',String(k)]);return typeof t[k]==='function'?t[k].bind(t):t[k];}});}; return typeof value === 'function'?value.bind(target):value;}}); }}, path,
    './home-layout.js':{locksDir:()=>{events.push(['locksDir']);return '/frozen-locks';}},
    './container-runtime.js':{getRuntimeInfo:()=>runtime,runtimeCli:()=>{events.push(['runtimeCli']);return 'docker';},runtimeExtraRunArgs:()=>{events.push(['extraRunArgs']);return ['--frozen-runtime'];}},
    '@ccc/device-lab/device-lab-shared-state.js':{withSharedMutationLock:(lock,operation,options)=>{events.push(['lock',lock,options]);try{return operation();}finally{events.push(['unlock']);}}},
  };
  const modules = new Map();
  function load(file) {
    if(modules.has(file)) return modules.get(file);
    if (!allowed.has(file)) throw new Error('Unowned compiled identity import: '+file);
    let code = fs.readFileSync(file,'utf8');
    const exports = {};
    modules.set(file,exports);
    const names = [...code.matchAll(/export\s+(?:function|const|class)\s+(\w+)/g)].map(m=>m[1]);
    code=code.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g,(_,bindings,id)=>`const {${bindings.replace(/\bas\b/g,':')}} = require(${JSON.stringify(id)});`);
    code=code.replace(/export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g,(_,bindings,id)=>bindings.split(',').filter(x=>x.trim()).map(x=>{const [name,alias]=x.trim().split(/\s+as\s+/);return `exports.${alias||name}=require(${JSON.stringify(id)}).${name};`;}).join('\n'));
    code=code.replace(/\bexport\s+(?=(?:function|const|class))/g,'');
    code+='\n'+names.map(n=>`exports.${n}=${n};`).join('\n');
    // Assembly rewrites this one native dependency in the public facade.
    // Bind its exact emitted path to the same captured lock observation.
    const req=id=>file===source&&id==='./packages/device-lab/dist/device-lab-shared-state.js'
      ? native['@ccc/device-lab/device-lab-shared-state.js']
      : native[id]||load(path.resolve(path.dirname(file),id));
    const instrumentedJSON = Object.create(JSON);
    instrumentedJSON.stringify = value => {events.push(["JSON.stringify"]);return JSON.stringify(value);};
    instrumentedJSON.parse = text => { const data=JSON.parse(text); if(scenario !== 'inspect-getters') return data; const wrap=(value,prefix)=>value && typeof value==='object' ? new Proxy(value,{get(target,key){events.push(['get',prefix+String(key)]);return wrap(target[key],prefix+String(key)+'.');}}) : value; return data.map(value=>wrap(value,'image.')); };
    vm.runInNewContext(code,{require:req,exports,JSON:instrumentedJSON,process:{platform:'linux',geteuid:()=>1234,getegid:()=>2345},console},{filename:file});
    return exports;
  }
  const allowed = new Set(['container-identity.js','application/container/identity-image.js','domain/container/identity-image.js'].map(name=>path.resolve(path.dirname(source),name)));
  const api=load(source);
  const arity=Object.fromEntries(['normalizeImageId','resolveContainerIdentity','getIdentityLabels','getIdentityMiseVolumeName','getIdentityCodexPackagesVolumeName','ensureIdentityImage'].map(k=>[k,api[k].length]));
  let outcome;
  try {outcome={value:api.ensureIdentityImage(baseId.slice(7),identity)};} catch(e) {outcome={error:e.message};}
  const resolutions=[];
  for(const spec of [{runtime:'docker',rootless:true,flavor:'docker-native'},{runtime:'podman',rootless:false,flavor:'podman-machine'},runtime]) {
    const reads=[];
    const lazy=Object.fromEntries(Object.keys(spec).map(key=>[key,undefined]));
    for(const key of Object.keys(spec)) Object.defineProperty(lazy,key,{get(){reads.push(key);return spec[key];}});
    let value;try{value=api.resolveContainerIdentity(lazy,'linux',1234,2345);}catch(e){value={error:e.message};}
    resolutions.push({reads,value});
  }
  const publicFacts={defaultIdentity:api.resolveContainerIdentity(),labels:api.getIdentityLabels(identity),mise:api.getIdentityMiseVolumeName(identity),codex:api.getIdentityCodexPackagesVolumeName(identity),normalized:api.normalizeImageId(baseId.slice(7)),constant:api.IDENTITY_CONTRACT_VERSION};
  return JSON.parse(JSON.stringify({scenario,arity,outcome,resolutions,publicFacts,events,labelsJSON:JSON.stringify(labels),hash:crypto.createHash('sha256').update(JSON.stringify(labels)).digest('hex')}));
}
    const observed=golden.map(record=>identityWitness(path.join(payload,'dist/container-identity.js'),record.scenario));
    assert.deepEqual(observed,golden,'compiled public/inward identity eight frozen native witnesses');
    const providers=path.join(payload,'dist/packages/device-lab/providers');
    const module=name=>import(pathToFileURL(path.join(providers,name)).href);
    const {evaluateDestructivePolicy}=await module('domain/destructive-admission.mjs');
    // Destructive baseline source SHA256 2979195132ee93436bcaa195bef89b4c35030af46b86204d7a996674103b0697.
    for(const consent of [undefined,false,0,1,'true',null]) {
        assert.deepEqual(evaluateDestructivePolicy('device_delete',{confirmDestructive:consent}), {
            ok:false,destructive:true,error:'destructive-action-confirmation-required',
            message:'Set confirmDestructive=true to run this destructive device-lab action.',confirmationField:'confirmDestructive',actions:['device-delete']});
    }
    assert.deepEqual(evaluateDestructivePolicy('device_delete',{confirmDestructive:true}),{ok:true,destructive:true,actions:['device-delete']});
    const {FLOW_MAX_STEPS}=await module('domain/device-flow.mjs'); assert.equal(FLOW_MAX_STEPS,50);
    await module('ports/device-flow.mjs');
    const {runDeviceFlow}=await module('application/device-flow.mjs');
    // Frozen 10c8618383811ced1f24305c35f6098ab858d25d server.mjs
    // SHA256 b16b3c229534593327d4a531ca63a2534c3ec934614b1143bc6edfc277993483:
    // validation precedes fresh scope; raw error classification survives rendering.
    for(const [stopOnError,rawFailure] of [[true,true],[false,true],[true,false]]) {
        const trace=[], native=[];
        const ports={
            toolInputError:(tool)=>{trace.push('validate:'+tool);return null;}, flowOperationAllowed:()=>true,
            toolOperation:tool=>tool, flowStepArguments:(_tool,_flow,args)=>args||{}, normalizePublicToolArgs:(_tool,args)=>args,
            withBrokerOperation:async callback=>{trace.push('scope');return callback();},
            dispatchTool:async operation=>{trace.push('dispatch:'+operation);return {failed:rawFailure&&operation==='first',content:[{type:'image',token:operation}]};},
            evaluateDestructivePolicy:denied,policyDeniedResult:denied,unexpectedError:denied,
            summarizeToolResult:(_operation,result,content)=>{content.push(...result.content);return {isError:!!result.failed};},
            actionResult:(_tool,_operation,raw)=>({failed:false,content:raw.content}),
            textFailure:denied,renderFlow:value=>({content:native,value})};
        const result=await runDeviceFlow({stopOnError,steps:[{tool:'first'},{tool:'second'}]}, {toolName:'run_flow',toolAllowed:()=>true,detail:true},ports);
        assert.equal(result.value.ok,!rawFailure,'raw classification survives presentation');
        assert.deepEqual(result.content.map(item=>item.token),stopOnError&&rawFailure?['first']:['first','second']);
        assert.deepEqual(trace,stopOnError&&rawFailure?['validate:first','scope','dispatch:first']:['validate:first','scope','dispatch:first','validate:second','scope','dispatch:second']);
    }
}

// Frozen original state52/runtime55 row hashes and payload-only isolated consumers.
// These functions run in isolated checker child processes. Never invoke in checker parent.
function fence(){
 let denied=0;const restore=[];
 const patch=(object,key,value)=>{const d=Object.getOwnPropertyDescriptor(object,key);restore.push(()=>Object.defineProperty(object,key,d));Object.defineProperty(object,key,{configurable:true,writable:true,value});};
 const deny=(name)=>(...args)=>{denied++;throw Error('unallocated effect: '+name);};
 for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])patch(cp,key,deny(key));
 patch(tls,'connect',deny('tls.connect'));patch(process,'kill',deny('process.kill'));patch(net.Socket.prototype,'connect',deny('Socket.connect'));patch(net.Server.prototype,'listen',deny('Server.listen'));
 for(const [o,keys] of [[net,['connect','createConnection','createServer']],[http,['request','get','createServer']],[https,['request','get','createServer']],[dgram,['createSocket']]])for(const key of keys)patch(o,key,deny(key));
 patch(globalThis,'fetch',deny('fetch'));syncBuiltinESMExports();
 return {patch,deny,finish(){assert.equal(denied,0,'caught denied effects are failures');},restore(){for(const fn of restore.reverse())fn();syncBuiltinESMExports();}};
}
async function verifyReviewedStateAccessDelivery(payload,privateHome,golden){
 const effect=fence(),native={trace:[],fault:null},constructors=[],extra=[];
 const originals={};for(const key of ['closeSync','fstatSync','ftruncateSync','lstatSync','openSync','readSync','writeSync'])originals[key]=fs[key];
 const owned=file=>{const p=path.resolve(String(file));if(!(p===privateHome||p.startsWith(privateHome+path.sep)))effect.deny('state filesystem')(p);};
 for(const key of Object.keys(originals))effect.patch(fs,key,(...args)=>{if(key==='openSync'||key==='lstatSync')owned(args[0]);native.trace.push(key);if(native.fault?.name===key)throw native.fault.error;if(native.adjust)args=native.adjust(key,args);const result=originals[key](...args);if(native.after)native.after(key,args,result);return native.map?native.map(key,result):result;});
 // Setup/read APIs retain captured authority but refuse non-private mutations and non-payload reads.
 for(const key of ['writeFileSync','readFileSync','symlinkSync','linkSync','unlinkSync','rmSync','mkdtempSync','mkdirSync']){
 const original=fs[key];effect.patch(fs,key,(...args)=>{
 if(key==='readFileSync'){const p=path.resolve(String(args[0]));if(!(p.startsWith(privateHome+path.sep)||p.startsWith(payload+path.sep)))effect.deny('state readFileSync')(p);}
 else {owned(args[0]);if(key==='symlinkSync'||key==='linkSync')owned(args[1]);}
 return original(...args);
 });
 }
 syncBuiltinESMExports();
 // Resolve-only fresh constructor graph. No source loader, TS stripping, or checkout fallback.
 const hook=registerHooks({resolve(spec,ctx,next){if(ctx.parentURL?.includes('?constructor')&&spec.startsWith('.')){const u=new URL(spec,ctx.parentURL);assert.ok(u.pathname.startsWith(payload+'/'));u.search='?constructor';return next(u.href,ctx);}return next(spec,ctx);}});
 try{
const temp=fs.mkdtempSync(path.join(privateHome,'state-access-witness-')),file=path.join(temp,'state.json');
const out=[];
const describe=(e)=>({name:e?.name,code:e?.code,message:e?.message?.replaceAll(temp,'ROOT'),cause:e?.cause?.message?.replaceAll(temp,'ROOT')});
try{for(const form of ['ts','shared']){
 const target=path.join(payload,form==='ts'?'dist/packages/device-lab/dist/device-lab-state-file.js':'dist/packages/device-lab/providers/state/state-file.mjs');
 const m=await import(pathToFileURL(target).href);
 const adapter=await import(pathToFileURL(path.join(payload,form==='ts'?'dist/packages/device-lab/dist/device-lab/adapters/state/state-file.js':'dist/packages/device-lab/providers/adapters/state/state-file.mjs')).href);
 assert.equal(m.DeviceLabStateFileError,adapter.DeviceLabStateFileError);
 assert.equal(m.withDeviceLabReadableFile,adapter.withDeviceLabReadableFile);
 constructors.push(m.DeviceLabStateFileError);
 const run=(name,fn)=>{native.trace=[];try{const v=fn();out.push({form,name,value:Buffer.isBuffer(v)?v.toString():v,trace:[...native.trace]});}catch(e){out.push({form,name,error:describe(e),trace:[...native.trace]});}finally{native.fault=null;native.adjust=null;native.after=null;native.map=null;}};
 out.push({form,name:'exports',value:Object.keys(m)});
 fs.writeFileSync(file,'{"a":1}');run('json-valid',()=>m.readDeviceLabStateFile(file,v=>v,'w'));
 run('json-missing',()=>m.readDeviceLabStateFile(file+'absent',()=>{throw Error('validator-called');},'w'));
 const originalParse=JSON.parse;let events=[];
 Object.defineProperty(JSON,'parse',{configurable:true,get(){events.push('parse-get');return function(s){events.push(this===JSON?'parse-JSON':'parse-other');return originalParse(s);};}});
 const originalToString=Buffer.prototype.toString;Object.defineProperty(Buffer.prototype,'toString',{configurable:true,get(){events.push('decode-get');return function(...args){events.push(Buffer.isBuffer(this)?'decode-bytes':'decode-other');return originalToString.apply(this,args);};}});
 run('receiver-order',()=>m.readDeviceLabStateFile(file,function(v){events.push(this===undefined?'validator-bare':'validator-other');return v;},'w'));
 Object.defineProperty(Buffer.prototype,'toString',{configurable:true,writable:true,value:originalToString});Object.defineProperty(JSON,'parse',{configurable:true,writable:true,value:originalParse});out.push({form,name:'events',value:events});
 fs.writeFileSync(file,'{');run('invalid-json',()=>m.readDeviceLabStateFile(file,v=>v,'w'));
 fs.writeFileSync(file,'{"a":1}');run('validator-fault',()=>m.readDeviceLabStateFile(file,()=>{throw Error('validator');},'w'));
 run('existing-error',()=>{const e=new m.DeviceLabStateFileError('existing');try{m.readDeviceLabStateFile(file,()=>{throw e;},'w');}catch(actual){return {same:actual===e,error:describe(actual)};}});
 run('read-fault',()=>{native.fault={name:'readSync',error:Error('native-read')};return m.readDeviceLabStateFile(file,v=>v,'w');});
 run('callback-fault',()=>m.withDeviceLabReadableFile(file,'w',99,()=>{throw Error('callback');}));
 run('close-priority',()=>{native.fault={name:'closeSync',error:Error('close')};return m.withDeviceLabReadableFile(file,'w',99,()=>{throw Error('callback');});});
 let recognition=0;Object.defineProperty(m.DeviceLabStateFileError,Symbol.hasInstance,{configurable:true,value(){recognition++;throw Error('recognizer');}});
 run('hostile-recognition',()=>m.readDeviceLabStateFile(file,()=>{throw Error('validator');},'w'));out.push({form,name:'recognition-count',value:recognition});delete m.DeviceLabStateFileError[Symbol.hasInstance];
 const NativeError=globalThis.Error;let constructorCalls=0;globalThis.Error=class extends NativeError{constructor(message,options){if(message==='w-state-invalid'){constructorCalls++;throw new NativeError('constructor-fault');}super(message,options);}};
 const ctorModule=await import(pathToFileURL(target).href+'?constructor');fs.writeFileSync(file,'{');run('error-constructor-fault',()=>ctorModule.readDeviceLabStateFile(file,v=>v,'w'));globalThis.Error=NativeError;out.push({form,name:'constructor-count',value:constructorCalls});fs.writeFileSync(file,'{"a":1}');
 run('stat-size',()=>m.readDeviceLabBinaryFile(file,'w',1));
 const link=file+'-link';fs.symlinkSync(file,link);run('symlink',()=>m.readDeviceLabBinaryFile(link,'w'));fs.unlinkSync(link);
 fs.linkSync(file,link);run('hardlink',()=>m.readDeviceLabBinaryFile(file,'w'));fs.unlinkSync(link);
 run('nonordinary',()=>m.readDeviceLabBinaryFile(temp,'w'));
 run('dev-mismatch',()=>{native.map=(n,r)=>n==='lstatSync'?{...r,isFile:()=>true,isSymbolicLink:()=>false,dev:r.dev+1}:r;return m.readDeviceLabBinaryFile(file,'w');});
 run('ino-mismatch',()=>{native.map=(n,r)=>n==='lstatSync'?{...r,isFile:()=>true,isSymbolicLink:()=>false,ino:r.ino+1}:r;return m.readDeviceLabBinaryFile(file,'w');});
 run('zero-dev-ino',()=>{native.map=(n,r)=>n==='lstatSync'?{...r,isFile:()=>true,isSymbolicLink:()=>false,dev:0,ino:0}:r;return m.readDeviceLabBinaryFile(file,'w');});
 run('max-plus-one',()=>{native.map=(n,r)=>n==='readSync'?99:r;return m.readDeviceLabBinaryFile(file,'w',20);});
 if(form==='ts'){run('root-read',()=>m.readDeviceLabBinaryFileWithinRoot(temp,file,'w'));run('write-existing',()=>{m.writeDeviceLabBinaryFile(temp,file,Buffer.from('replacement'),'w');return fs.readFileSync(file,'utf8');});
 run('write-partial',()=>{native.adjust=(n,a)=>n==='writeSync'?[a[0],a[1],a[2],Math.max(1,Math.floor(a[3]/2))]:a;m.writeDeviceLabBinaryFile(temp,file,Buffer.from('partial'),'w');return fs.readFileSync(file,'utf8');});
 run('write-zero',()=>{native.fault={name:'writeSync',error:Error('zero-write')};m.writeDeviceLabBinaryFile(temp,file,Buffer.from('no'),'w');});
 {native.map=(n,r)=>n==='writeSync'?0:r;let thrown;try{m.writeDeviceLabBinaryFile(temp,file,Buffer.from('no'),'w');}catch(e){thrown=e;}finally{native.map=null;}assert.ok(thrown,'genuine zero-return write must refuse');extra.push('genuine-zero-return');}
 run('write-preproof-fault',()=>{fs.writeFileSync(file,'preserved');native.fault={name:'fstatSync',error:Error('stat')};try{m.writeDeviceLabBinaryFile(temp,file,Buffer.from('no'),'w');}catch(e){return {error:describe(e),bytes:fs.readFileSync(file,'utf8')};}});
 run('root-after-read-fault',()=>{fs.writeFileSync(file,'{}');native.after=(n)=>{if(n==='readSync')native.fault={name:'lstatSync',error:Error('post-root')};};return m.readDeviceLabBinaryFileWithinRoot(temp,file,'w');});
 }
 }}finally{fs.rmSync(temp,{recursive:true,force:true});}
assert.equal(out.length,52);compareFrozenRows(out,golden);assert.notEqual(constructors[0],constructors[1]);assert.deepEqual(extra,['genuine-zero-return']);effect.finish();return {consumer:'state-access',ts:out.filter(x=>x.form==='ts').length,shared:out.filter(x=>x.form==='shared').length,genuineZero:true,ownConstructors:true};
 }finally{hook.deregister();effect.restore();}
}
async function verifyRuntimeCapabilitiesDelivery(payload,privateHome,golden){
 const effect=fence();
 // Read the exact emitted static closure before fencing descriptor operations.
 // The load hook serves these owned bytes; payload code never gets a read bridge.
 const facadeUrl=pathToFileURL(path.join(payload,'dist/container-runtime.js'));
 const importRead=await createOwnedImportRead(new URL('./',facadeUrl),new URL('./packages/device-lab/package.json',facadeUrl),'runtime import fixture');
 const sourceUrls=['container-runtime','domain/container-runtime','application/container-runtime-selection','application/docker-endpoint-selection',
  'application/container-launch-arguments','domain/container-launch-arguments','application/runtime-capabilities','domain/runtime-capabilities','adapters/runtime-capabilities']
  .map(name=>new URL('./'+name+'.js',facadeUrl));
 importRead.restrictSources(sourceUrls);
 const ownedSources=new Map();
 try{
  for(const url of sourceUrls){
   assert.ok(fs.lstatSync(url).size<=256*1024,'bounded runtime import source');
   const source=importRead.read(url,'utf8');
   assert.ok(Buffer.byteLength(source,'utf8')<=256*1024,'bounded runtime import bytes');
   ownedSources.set(url.href,source);
  }
 }catch(error){effect.deny('runtime unowned import read')(error);}
 finally{importRead.close();}
 const loadedSources=new Set();
 const hook=registerHooks({load(url,context,nextLoad){
  if(url.startsWith('node:'))return nextLoad(url,context);
  if(!ownedSources.has(url))return effect.deny('runtime unexpected import')(url);
  loadedSources.add(url);
  return {format:'module',source:ownedSources.get(url),shortCircuit:true};
 }});
 const state={active:false,trace:[],env:{},platform:'linux',uid:0,probe:null,platformReads:null,failEnv:null,loopback:false};
 const nativeJoin=path.join;
 for(const key of ['writeFileSync','appendFileSync','openSync','mkdirSync','rmSync','unlinkSync','renameSync','symlinkSync','linkSync','truncateSync'])effect.patch(fs,key,effect.deny('runtime '+key));
 effect.patch(cp,'spawnSync',(command,args,options)=>{state.trace.push(['spawn',command,args,options]);const expected=frozenRuntimeProbeWhitelist;if(!expected.some(x=>JSON.stringify(x)===JSON.stringify([command,args,options])))return effect.deny('runtime probe')(command,args,options);return state.probe(command,args);});
 effect.patch(fs,'existsSync',file=>{state.trace.push(['exists',file]);if(file!=='/sys/class/net/loopback0')return effect.deny('runtime filesystem')(file);return state.loopback;});
 effect.patch(fs,'readFileSync',effect.deny('native file read'));
 effect.patch(path,'join',(...args)=>{if(state.active)state.trace.push(['join',...args]);return nativeJoin(...args);});
 syncBuiltinESMExports();
 try{
const originalEnv=process.env,platformDescriptor=Object.getOwnPropertyDescriptor(process,'platform'),uidDescriptor=Object.getOwnPropertyDescriptor(process,'getuid');
const keys=new Set(['VITEST','CCC_RUNTIME','DOCKER_CONTEXT','DOCKER_HOST','WSL_DISTRO_NAME','CCC_RUNTIME_SOCKET','XDG_RUNTIME_DIR']);
process.env=new Proxy(originalEnv,{get(target,key){if(keys.has(key)){if(state.active)state.trace.push(['env',key]);if(state.failEnv===key)throw Error('env-fault-'+key);return state.env[key];}return target[key];}});
Object.defineProperty(process,'platform',{configurable:true,get(){if(state.active)state.trace.push(['platform']);return state.platformReads?.length?state.platformReads.shift():state.platform;}});
Object.defineProperty(process,'getuid',{configurable:true,get(){if(state.active)state.trace.push(['uid-get']);if(state.uid==='absent')return undefined;if(state.uid==='getter-fault')throw Error('uid-getter');return function(){state.trace.push(['uid-call',this===process]);if(state.uid==='fault')throw Error('uid-fault');return state.uid;};}});
const source=path.join(payload,'dist/container-runtime.js');const runtime=await import(pathToFileURL(source).href);
assert.equal(loadedSources.size,sourceUrls.length,'only exact shipped runtime closure loaded');
const result=(status,stdout)=>({get status(){state.trace.push(['status']);return status;},get stdout(){state.trace.push(['stdout']);return stdout;}});
const defaults=(command,args)=>{if(args[0]==='--version')return result(0,command==='docker'?'Docker version 27.1.1':'podman version 5.2.3');if(args[0]==='context')return result(0,'unix:///selected.sock');if(args.at(-1)==='{{.OperatingSystem}}')return result(0,'Ubuntu');if(args.at(-1)==='{{json .SecurityOptions}}')return result(0,'[]');if(args.at(-1)==='{{.Host.Remote}}')return result(0,'false');if(args.at(-1)==='{{.Host.Security.Rootless}}')return result(0,'false');throw Error('unplanned mock command');};
const outputRows=[];
function run(name,configure={},effect=()=>runtime.getRuntimeInfo()){
 state.active=false;runtime._resetRuntimeCacheForTest();Object.assign(state,{trace:[],env:{CCC_RUNTIME:'docker'},platform:'linux',uid:0,probe:defaults,platformReads:null,failEnv:null,loopback:false},configure);state.active=true;
 try{const value=effect();state.active=false;outputRows.push({name,value,trace:state.trace});}catch(error){state.active=false;outputRows.push({name,error:{name:error.name,message:error.message},trace:state.trace});}
}
try{
 run('docker-native');run('podman-native',{env:{CCC_RUNTIME:'podman'}});run('vitest-stub',{env:{VITEST:'1',CCC_RUNTIME:'invalid'}});run('vitest-override',{env:{VITEST:'1',CCC_RUNTIME:'invalid'}},()=>{runtime.setRuntimeOverride('podman');return runtime.getRuntimeInfo();});
 run('cache-env-skip',{},()=>{const first=runtime.getRuntimeInfo();state.failEnv='VITEST';first.version='mutated';return {first,same:runtime.getRuntimeInfo()===first,cli:runtime.runtimeCli(),remote:runtime.isContainerHostRemote()};});
 run('override-noop',{},()=>{const first=runtime.getRuntimeInfo();runtime.setRuntimeOverride('');runtime.setRuntimeOverride(null);return runtime.getRuntimeInfo()===first;});
 run('invalid-override-preserves',{},()=>{const first=runtime.getRuntimeInfo();let message;try{runtime.setRuntimeOverride('invalid');}catch(e){message=e.message;}return {same:runtime.getRuntimeInfo()===first,message};});
 run('override-invalidates',{},()=>{const first=runtime.getRuntimeInfo();runtime.setRuntimeOverride('podman');return {same:runtime.getRuntimeInfo()===first,info:runtime.getRuntimeInfo()};});
 run('preload-order',{},()=>{const input={get runtime(){state.trace.push(['input-runtime']);return 'podman';},get version(){state.trace.push(['input-version']);return '9';}};runtime._setRuntimeInfoForTest(input);return runtime.getRuntimeInfo();});
 for(const platform of ['darwin','win32'])run('docker-'+platform,{platform});
 for(const platform of ['darwin','win32'])run('podman-'+platform,{platform,env:{CCC_RUNTIME:'podman'}});
 run('wsl-nat',{env:{CCC_RUNTIME:'docker',WSL_DISTRO_NAME:'Ubuntu'}});run('wsl-mirrored',{env:{CCC_RUNTIME:'docker',WSL_DISTRO_NAME:'Ubuntu'},loopback:true});run('wsl-falsy',{env:{CCC_RUNTIME:'docker',WSL_DISTRO_NAME:''}});run('wsl-getter-fault',{failEnv:'WSL_DISTRO_NAME'});
 const modify=(field,status,text)=>(command,args)=>args.at(-1)===field?result(status,text):defaults(command,args);
 run('desktop-linux',{probe:modify('{{.OperatingSystem}}',0,'Docker Desktop'),failEnv:'WSL_DISTRO_NAME'});
 run('desktop-win-pipe',{platform:'win32',probe:(c,a)=>a.at(-1)==='{{.OperatingSystem}}'?result(1,''):a[0]==='context'?result(0,'npipe:////./pipe/dockerDesktopLinuxEngine'):defaults(c,a)});
 run('nondesktop-defeats-pipe',{platform:'win32',env:{CCC_RUNTIME:'docker',DOCKER_HOST:'npipe:////./pipe/dockerDesktopLinuxEngine'}});
 run('desktop-remote-endpoint',{env:{CCC_RUNTIME:'docker',DOCKER_CONTEXT:'colima',DOCKER_HOST:'unix:///shadowed'},probe:(c,a)=>a.at(-1)==='{{.OperatingSystem}}'?result(0,'Docker Desktop'):a[0]==='context'?result(0,'ssh://remote'):defaults(c,a)});
 run('desktop-context-raw',{env:{CCC_RUNTIME:'docker',DOCKER_CONTEXT:' --format=hostile ',DOCKER_HOST:'ssh://shadowed'},probe:modify('{{.OperatingSystem}}',0,'Docker Desktop')});
 run('desktop-context-fail',{env:{CCC_RUNTIME:'docker',DOCKER_CONTEXT:'colima',DOCKER_HOST:'unix:///shadowed'},probe:(c,a)=>a.at(-1)==='{{.OperatingSystem}}'?result(0,'Docker Desktop'):a[0]==='context'?result(1,'unix:///local'):defaults(c,a)});
 run('docker-rootless-json',{probe:modify('{{json .SecurityOptions}}',0,'["name=rootless"]')});run('docker-rootless-fallback',{probe:modify('{{json .SecurityOptions}}',0,'rootless')});run('docker-rootless-nonarray',{probe:modify('{{json .SecurityOptions}}',0,'"rootless"')});
 run('podman-remote',{env:{CCC_RUNTIME:'podman'},probe:modify('{{.Host.Remote}}',0,' TRUE ')});run('podman-rootless-true',{env:{CCC_RUNTIME:'podman'},probe:modify('{{.Host.Security.Rootless}}',0,'true')});run('podman-rootless-false',{env:{CCC_RUNTIME:'podman'},uid:1000});
 for(const uid of [1000,'absent','fault','getter-fault'])run('podman-uid-'+uid,{env:{CCC_RUNTIME:'podman'},uid,probe:modify('{{.Host.Security.Rootless}}',1,'')});
 run('socket-override',{env:{CCC_RUNTIME:'podman',CCC_RUNTIME_SOCKET:' raw socket '},probe:modify('{{.Host.Security.Rootless}}',0,'true')});run('socket-xdg',{env:{CCC_RUNTIME:'podman',XDG_RUNTIME_DIR:'/run/custom'},probe:modify('{{.Host.Security.Rootless}}',0,'true')});run('socket-uid-fault',{env:{CCC_RUNTIME:'podman'},uid:'fault',probe:modify('{{.Host.Security.Rootless}}',0,'true')});
 run('changing-platform',{platformReads:['win32','linux','darwin'],probe:modify('{{.OperatingSystem}}',1,'')});
 run('failed-collection-retries',{probe:()=>{throw Error('probe-fault');}},()=>{const errors=[];for(let i=0;i<2;i++)try{runtime.getRuntimeInfo();}catch(e){errors.push(e.message);}return errors;});
 for(const [label,field,runtimeName] of [['version','--version','docker'],['desktop','{{.OperatingSystem}}','docker'],['docker-rootless','{{json .SecurityOptions}}','docker'],['podman-remote','{{.Host.Remote}}','podman'],['podman-rootless','{{.Host.Security.Rootless}}','podman']]){
  run('spawn-fault-'+label,{env:{CCC_RUNTIME:runtimeName},probe:(c,a)=>{if(a[0]===field||a.at(-1)===field)throw Error('spawn-'+label);return defaults(c,a);}});
  for(const property of ['status','stdout'])run(property+'-fault-'+label,{env:{CCC_RUNTIME:runtimeName},probe:(c,a)=>{if(a[0]===field||a.at(-1)===field)return {get status(){state.trace.push(['status']);if(property==='status')throw Error('status-'+label);return 0;},get stdout(){state.trace.push(['stdout']);throw Error('stdout-'+label);}};return defaults(c,a);}});
 }
 run('cache-reentry',{},()=>{const normal=state.probe;let first=true;state.probe=(c,a)=>{if(first){first=false;runtime._setRuntimeInfoForTest({runtime:'podman',version:'inside'});}return normal(c,a);};const info=runtime.getRuntimeInfo();return {info,same:runtime.getRuntimeInfo()===info};});
 run('version-getters',{probe:(c,a)=>a[0]==='--version'?result(0,{toString(){state.trace.push(['version-toString',this!==null]);return 'custom 7.2';}}):defaults(c,a)});
}finally{state.active=false;process.env=originalEnv;Object.defineProperty(process,'platform',platformDescriptor);Object.defineProperty(process,'getuid',uidDescriptor);}
assert.equal(outputRows.length,55);compareFrozenRows(outputRows,golden);await verifyControlledRuntimeCore(payload);effect.finish();return {consumer:'runtime55',executed:55,layer:'compiled-public-and-inward-collection'};
 }finally{hook.deregister();effect.restore();}
}

const runtimeCapabilitiesDeclarationConsumer = "import { createRuntimeCapabilitiesCollector } from \"./dist/application/runtime-capabilities.js\";\nimport type { RuntimeCapabilitiesPorts, RuntimeCapabilityProbeResult } from \"./dist/ports/runtime-capabilities.js\";\nimport type { RuntimeInfo, RuntimeFlavor } from \"./dist/domain/runtime-capabilities.js\";\nimport { getRuntimeInfo, runtimeCli, type RuntimeInfo as PublicRuntimeInfo, type RuntimeFlavor as PublicRuntimeFlavor } from \"./dist/container-runtime.js\";\nimport type { RuntimeName } from \"./dist/domain/container-runtime.js\";\n\nfunction runtimeCapabilitiesContracts(ports: RuntimeCapabilitiesPorts): void {\n    const collect: () => RuntimeInfo = createRuntimeCapabilitiesCollector(ports);\n    const domainInfo: RuntimeInfo = getRuntimeInfo(); const publicInfo: PublicRuntimeInfo = collect();\n    const flavor: RuntimeFlavor = publicInfo.flavor; const publicFlavor: PublicRuntimeFlavor = flavor;\n    const name: RuntimeName = runtimeCli(); const raw: RuntimeCapabilityProbeResult = ports.observeVersion(name);\n    const wsl: string | undefined = ports.readWslDistributionName();\n    const { readWslDistributionName, ...withoutWsl } = ports;\n    // @ts-expect-error capabilities must include the explicit lazy WSL observation port\n    const missingWsl: RuntimeCapabilitiesPorts = withoutWsl;\n    // @ts-expect-error raw probe status is not a sanitized success boolean\n    const wrongProbe: RuntimeCapabilityProbeResult = { status: true, stdout: \"\" };\n    // @ts-expect-error cache publication must finish synchronously before the collector returns\n    const asyncPublisher: RuntimeCapabilitiesPorts[\"publishCachedInfo\"] = async () => undefined;\n    // @ts-expect-error public info remains synchronous\n    const asyncInfo: Promise<RuntimeInfo> = getRuntimeInfo();\n    void [domainInfo, publicInfo, publicFlavor, raw, wsl, readWslDistributionName, missingWsl, wrongProbe, asyncPublisher, asyncInfo];\n}\n\n// @ts-expect-error permissive void publication loses exact completion contract\nconst voidPublisher: RuntimeCapabilitiesPorts[\"publishCachedInfo\"] = (): void => {};\n";

const stateAccessDeclarationConsumer = "import type { Stats } from \"node:fs\";\nimport {\n    readDeviceLabStateFile,\n    readDeviceLabBinaryFile,\n    readDeviceLabBinaryFileWithinRoot,\n    readDeviceLabTextFile,\n    withDeviceLabReadableFile,\n    writeDeviceLabBinaryFile,\n} from \"./dist/packages/device-lab/dist/device-lab-state-file.js\";\nimport { readValidatedStateFile } from \"./dist/packages/device-lab/providers/application/state-file-read.mjs\";\nimport type { StateFileReadPorts } from \"./dist/packages/device-lab/providers/ports/state-file.mjs\";\n\nconst token = Symbol(\"validated\");\nconst validated: typeof token | null = readDeviceLabStateFile<typeof token>(\"explicit-file\", () => token, \"prefix\");\nconst binary: Buffer | null = readDeviceLabBinaryFile(\"file\", \"prefix\");\nconst fenced: Buffer | null = readDeviceLabBinaryFileWithinRoot(\"root\", \"file\", \"prefix\");\nconst text: string | null = readDeviceLabTextFile(\"file\", \"prefix\");\nconst callback: { descriptor: number; stat: Stats } | null = withDeviceLabReadableFile(\"file\", \"prefix\", 9, (descriptor, stat) => ({ descriptor, stat }));\nwriteDeviceLabBinaryFile(\"root\", \"file\", Buffer.from(\"bytes\"), \"prefix\", { allowNestedCreate: true });\nconst opaque = { content: \"{}\" };\nconst ports: StateFileReadPorts<typeof opaque, typeof token> = {\n    read: () => opaque,\n    decode: bytes => bytes.content,\n    parse: decode => JSON.parse(decode()),\n    validate: () => token,\n    isStateError: () => false,\n    invalidState: cause => new Error(\"invalid\", { cause }),\n};\nconst applicationValue: typeof token | null = readValidatedStateFile(ports);\n// @ts-expect-error read port cannot be omitted in a business construction\nconst incomplete: StateFileReadPorts<typeof opaque, typeof token> = { decode: ports.decode, parse: ports.parse, validate: ports.validate, isStateError: ports.isStateError, invalidState: ports.invalidState };\n// @ts-expect-error native compatibility descriptor is a number, not an opaque business token\nwithDeviceLabReadableFile(\"file\", \"prefix\", 9, (descriptor: string) => descriptor);\nvoid [validated, binary, fenced, text, callback, applicationValue, incomplete];\n";

const stateFrozenRowHashes = Object.freeze([{"identity":"ts:exports","sha256":"66e3b9630d08b51ef3db8ff0410974eb09f727c82c847b21948121002cd977cd"},{"identity":"ts:json-valid","sha256":"bed2716b9f43d0238708062a1500a2eabccaf8f8529aa63fbd0aca355549c141"},{"identity":"ts:json-missing","sha256":"5ccf8453c911d082ea7e0b1caf6206797499dfc6ff126585e4987bfe7362fdfa"},{"identity":"ts:receiver-order","sha256":"3fc2f8ed8b6e4276243ab5a2abf2fd34fbf510fd19300b717954df1b73b336c8"},{"identity":"ts:events","sha256":"ec5f6a3b47e23ac8dd0d9f911a2ed1285cc751300028df6e9ba2834a07834126"},{"identity":"ts:invalid-json","sha256":"30dc42ec0f548b6d6c28fb67a2b012b122108a38ec8688cea39e68a7b2bf29ae"},{"identity":"ts:validator-fault","sha256":"94a33002e3dfc2688ea44a6a0a7ae8a979308fdf193ae0c9c38d4011c55bcfb5"},{"identity":"ts:existing-error","sha256":"af5ce8f62495f8209cefa96ac5f854b59d2360a0ab1610cd9e47a66d1275f560"},{"identity":"ts:read-fault","sha256":"fde5a413d6854c8b09aaed6fdff286a48de3a41493d96d74fc69fa3c22d0b021"},{"identity":"ts:callback-fault","sha256":"7b610e494eae5cdb4c2fcbf2db0f777af97c34f913832320c2923b30025587a1"},{"identity":"ts:close-priority","sha256":"de60fa1975b4cefdf44131529e9bb5ed1e1deb56dde411717279fae3b3c81abc"},{"identity":"ts:hostile-recognition","sha256":"cb6cd08e0a3d6d606badccb8f55efc4671e639e651b523a5abc2e70d5d18b829"},{"identity":"ts:recognition-count","sha256":"921022b15de7ab68125545e3e5208bd5d9f326c18fcfe87f4b5b621e745dc8e8"},{"identity":"ts:error-constructor-fault","sha256":"0303f8404ca7f12fdabd5ecd1fdbc4906d6fbdc171ea38e7138266c36d6fb76d"},{"identity":"ts:constructor-count","sha256":"b09a3239833d0fe15547c4eca65df25f2662a50fe3d97f28494905b24e18c26a"},{"identity":"ts:stat-size","sha256":"8ee3fedc5e3d9f1bb73cee97944b8f8fd2d369d546800c3372715de0c95b6fa7"},{"identity":"ts:symlink","sha256":"b59a99116d33570455597bcd583a2e856593b04712a491bdcccc76c08fef28ba"},{"identity":"ts:hardlink","sha256":"5a5b382514b0ecd11bfd835b4d8bf5a142255e3168ffc07f2a928b710e1e3a95"},{"identity":"ts:nonordinary","sha256":"194134539214a0f12db85ca39ee5329a4e0a5da489842ab7a42c341cd600d4b9"},{"identity":"ts:dev-mismatch","sha256":"daa67300198991bda5a552dfc9325eff362ce84a5b7e53bca5181cfda4eeb23a"},{"identity":"ts:ino-mismatch","sha256":"7aad631e89b770acb5fe0e72a75eef782d229d62c090ff6111ce08044b3de074"},{"identity":"ts:zero-dev-ino","sha256":"35468693cfff08f01e2d5cc9550a8e1207c4cf40071bd0a97da3c50945233e46"},{"identity":"ts:max-plus-one","sha256":"6fe01ecb632482396547577aa2f61b17fe17d736d7db56cd1afbcb554a883a4f"},{"identity":"ts:root-read","sha256":"22ef21a600d30e2266b1546dea17b8519970f5bd2b635502e4277a5f42573cd5"},{"identity":"ts:write-existing","sha256":"17c63af42e20da7079b3050523a0672140c12905e46018a99c5acc845f019662"},{"identity":"ts:write-partial","sha256":"a00d31e452b546ab0b5d716c8b88f7ffb9e09d96f371e461a5c8b2c5cb0cebdd"},{"identity":"ts:write-zero","sha256":"5024018110286ff7c0d7960dcd17176b7c52420935f40376ee2c5f582d33a6b9"},{"identity":"ts:write-preproof-fault","sha256":"e3581ce21597d0ce3878adbf91edd47e3a1e3247a5aa3dacbf42c5370a48d716"},{"identity":"ts:root-after-read-fault","sha256":"5bb838ffe3fa43d35fe8a88da1055d7ba6fedaca255ed780fc0d07aa816f31db"},{"identity":"shared:exports","sha256":"d48f1081a76cba0d41d68faac8c99720272696054946f792520d7ae0cccef6cc"},{"identity":"shared:json-valid","sha256":"35fc9647e62d35de225efa058995414d8f5422d600f3ecdf5de20301520ecb20"},{"identity":"shared:json-missing","sha256":"d73e6c4b257a6ea127a52f2ca925d5cd5d188f87314393bebce605ec3eec98c0"},{"identity":"shared:receiver-order","sha256":"97552cea33967ce930f6df9931147874376a82ef06ca1f09510cd2ac8340edac"},{"identity":"shared:events","sha256":"70f12cee11c0593355e6e875412f6780fc9b315cd02dbbd1d257cd4996b13097"},{"identity":"shared:invalid-json","sha256":"699122bd48373b00584d3f5248dc252fe5af98ec9abe948b306630de8a1b4dd3"},{"identity":"shared:validator-fault","sha256":"6b2df97e680cd7f1fd6cc1204507b0ff90f83ba9fc7ef6f2812747968fb22e57"},{"identity":"shared:existing-error","sha256":"fbf4c7480cf1397110b24b1e77905d0568b813cc2cc393a0a03dc132617ffb6f"},{"identity":"shared:read-fault","sha256":"662680a662d5ee661fbf7560493bd0a00b5d98f23f8ae57c55fa4e2522f4ac1e"},{"identity":"shared:callback-fault","sha256":"925b055d464d8b591ee7a00bdb9676d4ceadcc3131f28e3cd97a20953b38fe89"},{"identity":"shared:close-priority","sha256":"a6ada851a86d46a330add9d72d99a4f81c561f0802d2423d71f720950e7969d1"},{"identity":"shared:hostile-recognition","sha256":"72ae0f95e321077f3bc27788a001069cbe96c654d1e5eac6069156b8f3b5bf9e"},{"identity":"shared:recognition-count","sha256":"c6322ee32e147c6b129d738e830a97ec75cf39c3c4ba1259cb2ca929fc169e50"},{"identity":"shared:error-constructor-fault","sha256":"95d4dc12fa2f9e13dfa9257a02ca01368e5c4eec0872bd10c222ed3fd7d3e0d9"},{"identity":"shared:constructor-count","sha256":"991ee3462dd98064e1930db56b9693de5bb86dc2f7d2305ea19fdb355ecd6a51"},{"identity":"shared:stat-size","sha256":"727268bbfdb5ee94035d464f10cce0c147b107dbf9996075af019cf8833a79d9"},{"identity":"shared:symlink","sha256":"ee7ec9e505da495e2125cb7deeea69fc22f9cceb8e244240fb93a718c288e7cc"},{"identity":"shared:hardlink","sha256":"db92c974456842ccaffaef2660b91915351a970d12b31458c895796a5a7e8394"},{"identity":"shared:nonordinary","sha256":"3a0871e72bf02f862ab3ee4cb861f813d999c2db33fd045d1de70770764d7b49"},{"identity":"shared:dev-mismatch","sha256":"5285ea616b1e596ce6f55f909445fff2c8dd8698c732dbbf292b9f221e5385da"},{"identity":"shared:ino-mismatch","sha256":"d95cbe574f1c7f748e3b743ea76785498fe644e66f1dfbb8f8c42da667d7de57"},{"identity":"shared:zero-dev-ino","sha256":"7e800ecbf5534dd8ea6bd2e5479ef438d9de29c95b047f718e3ef2b63c291d2e"},{"identity":"shared:max-plus-one","sha256":"542d0ccc99dd3f56e65323ff9f6c3c1be4871585c3f8010ab2ec008786ac7d0f"}]);

const runtimeFrozenRowHashes = Object.freeze([{"identity":"docker-native","sha256":"f55eb3d0cf04a2d85cb2b0d363c9abf052ee92fcc4d6705a6ebd801b276ea30d"},{"identity":"podman-native","sha256":"93620e08b5c5491b17a096332857a91d5e6f320e985049b2ccf3ade4f4849ace"},{"identity":"vitest-stub","sha256":"e533a7ba4348449b558b4241c72f5deb46de2115d2144e6ecd95e0f2f7a998ae"},{"identity":"vitest-override","sha256":"734670b9cf0c17604857adfd1ccdfa1b929220b63f1ae9c688de0da8dc308308"},{"identity":"cache-env-skip","sha256":"509bcd92f6b4ec728f4ac9db6112495682ceaab04ed3138f5c7fdbeef1a08677"},{"identity":"override-noop","sha256":"f93e253688a62c9e74aaf0902325fcd6fe7ad896e225b9a09048be030b1708df"},{"identity":"invalid-override-preserves","sha256":"af2c3c0f1967e8d35741be0679708cf41512440b16a815379df65e094c7b1020"},{"identity":"override-invalidates","sha256":"3b19027a65a24f0920eb7403278f5cc360eb24dace43d7cb2891f7f3dd8c3647"},{"identity":"preload-order","sha256":"a9ed4b321831f2650219547a8feb4e5519945c0dda13ce093f82ad6af68bf3bd"},{"identity":"docker-darwin","sha256":"4fc0099a537f578e696315fb2f97214b5337f2b8478c80334878fd47e0e17473"},{"identity":"docker-win32","sha256":"36ebff1fbfd4828ca9cdb2ef5243f1eae04f3617ab954170f7083749b1cd2b6d"},{"identity":"podman-darwin","sha256":"b8ed74db187269c24cd31afe30eeb9b1093481fd8cb71a1ab4e937a1fd4fb356"},{"identity":"podman-win32","sha256":"751130a0c5a9a52c3d89c795d67d58969e72ee0e30cb17ea14bd756137ebceef"},{"identity":"wsl-nat","sha256":"87075edaf3063baa5983f1748182d2c5f6858d81208c91caba50f4375309ea1b"},{"identity":"wsl-mirrored","sha256":"5a3374d21420c9b6e252655a20e8bffb3c4c6392867cf2b02fa58c2feecfcc13"},{"identity":"wsl-falsy","sha256":"e0f46ddbbac4478e9abf635b5a1438ed3c9c73a379bb06b0c2b61c8071226f2c"},{"identity":"wsl-getter-fault","sha256":"bd70031c21dde422a8c68478308ce45ecc5d5cb939adfe5007c8e181e449dc56"},{"identity":"desktop-linux","sha256":"b439ea298293370b4ea63b4fdec7f3cf977a9fa04301521aa7930842e60c19ba"},{"identity":"desktop-win-pipe","sha256":"d701a5b18b4366b2a9bc88f2dfd5a216beb6cd1570404b7287a14a387a17e46e"},{"identity":"nondesktop-defeats-pipe","sha256":"5baab666d879fbf120bbea653e9dddae36e0d304c9296a63727f58d9933cfea1"},{"identity":"desktop-remote-endpoint","sha256":"bc4cc2cef0d8f20b6f3f9a765e9d36a50fcd775c21dfd1cde904604fa9b5af60"},{"identity":"desktop-context-raw","sha256":"337d031061199a906d08c2daa4076ddbd1883c81bdbc17c6a3763a816b62dfeb"},{"identity":"desktop-context-fail","sha256":"c8de9b6d891cb3755d7e2af6964cfb27317bf906b3cc4e32a636a88307acf6f2"},{"identity":"docker-rootless-json","sha256":"c5dbbcf56120c64a89a1d51b65d3361f594193ba24620abc1d0ea20eec56d6bf"},{"identity":"docker-rootless-fallback","sha256":"e1403df5cbed07434657ad61a17dd3e235038896a722decf986162243c69cbb3"},{"identity":"docker-rootless-nonarray","sha256":"ceaf570bb64d3fff21c2534cf139a6d0819b8f922091582310fea926c50fe848"},{"identity":"podman-remote","sha256":"5fb035668d7f2e370e8933fcb64587bd6ec9410546c1f17056bcc29afd96734b"},{"identity":"podman-rootless-true","sha256":"59ce5cdaaee99d8ad23d6e067eb2cb153067a2f38935bdc22264551e19538510"},{"identity":"podman-rootless-false","sha256":"fe5187c2dbce63473d84ea7a54265ad063a7c0c816fab5aeeccafa85f101a706"},{"identity":"podman-uid-1000","sha256":"bd8173e6f5853769c9a1dd96a873c61b41edcae7845c8d58941f2940e95a577a"},{"identity":"podman-uid-absent","sha256":"f00d5d8bf227a22ed2c8269affa998f6dcd960e030000bfb54ae1f748a2b0d48"},{"identity":"podman-uid-fault","sha256":"215b8697890dee5997bd99ca6fbabbd53802ec661c7ece483ee0722402600217"},{"identity":"podman-uid-getter-fault","sha256":"f18871b54e3b1709cf7d065f9ec77c6408a918332a28fd4d00f0868e389b0de8"},{"identity":"socket-override","sha256":"bd4593ada152e103e24c05528647d2daa88f09ff2ab4f053e719da33353c4a87"},{"identity":"socket-xdg","sha256":"f471e2360f7883e35d20fd14e6cec9b8a816596adb23fc119dbef310ee680004"},{"identity":"socket-uid-fault","sha256":"363078a9aac615499bf0421601013f091f997122c08705ef69670e4c36825e33"},{"identity":"changing-platform","sha256":"97ed1c8d84935bb4260c49fc946963aac848bc0a5027af6ebc7337da202492dc"},{"identity":"failed-collection-retries","sha256":"b4547ed462f262af1e5b79ddc134f2a6143d64ce818494513e666a462ffb7580"},{"identity":"spawn-fault-version","sha256":"5d19cf6ab72f5ca4cc4746c72aa08fbffdfad01bb43e5717408016396f6fe706"},{"identity":"status-fault-version","sha256":"f3df0efc2fbe215df9c2ad4e79d4e2ada3d3b003470eceab45b8218e8800aebe"},{"identity":"stdout-fault-version","sha256":"d2526c1ec15761b11ff6c0366abb946b7d2ec480cde3b57c082bf8c793e541e7"},{"identity":"spawn-fault-desktop","sha256":"56e815cca86686591a856f9de8360542002cd54d29a77378c6dbc23b19ce4d1c"},{"identity":"status-fault-desktop","sha256":"d7e18c4bea1444b0bac258928b0a2ae35000f3e2f00c1f4557d4ab0b598e23c1"},{"identity":"stdout-fault-desktop","sha256":"310aa44e43d651d6baeeb251fbb75f39d1f7c9ad1b95eb19a83a8826b37d0119"},{"identity":"spawn-fault-docker-rootless","sha256":"c67a539b60923ffd60e7fff924e9b8fcd4ddf868d0314d991cbc0780b7fa7231"},{"identity":"status-fault-docker-rootless","sha256":"247f86ece84732700f59489a6a5b9d02991777ded34e6e460114de8c9d47377f"},{"identity":"stdout-fault-docker-rootless","sha256":"54ea6afc154284921778900b1ec018102bea9b2f8eea4f58b599c26028fe1323"},{"identity":"spawn-fault-podman-remote","sha256":"f3498ba4ba0190ab5dd58945c226b200878615715e711ba4189050a3c67c2e83"},{"identity":"status-fault-podman-remote","sha256":"9a9232c86cc26b0b50ff4bcb7ca0bf9aac0dfde85c1492769b519242e5ed0355"},{"identity":"stdout-fault-podman-remote","sha256":"7aafe36854814d825557f3975c4523d39d48c932c2457bfe585c91253c2ee3ce"},{"identity":"spawn-fault-podman-rootless","sha256":"a670644605e9d204f2da23fbd5b7603bda999ba6edfa7e54f02b8d54f97eda81"},{"identity":"status-fault-podman-rootless","sha256":"65a18dd3580369636d20477747be5b851212cf7c4f4ebcf92ae02e5875db1073"},{"identity":"stdout-fault-podman-rootless","sha256":"04e98d3bf38a8a7b3344ad05fe9a904ee1924eaad975e87e3ddd44c5f8b7dc15"},{"identity":"cache-reentry","sha256":"32b25bbd3a011e5f6a741698d50d7ee2fef9637f5cff01ec98d46e721014c5d7"},{"identity":"version-getters","sha256":"57e8b992b25fb09c2283a397a4ec9c244c89bfa46bbbf3af40e47c25b0c14a8d"}]);

const frozenRuntimeProbeWhitelist = [["docker",["--version"],{"encoding":"utf-8","stdio":["pipe","pipe","pipe"]}],["docker",["info","--format","{{.OperatingSystem}}"],{"encoding":"utf-8","stdio":["pipe","pipe","pipe"]}],["docker",["info","--format","{{json .SecurityOptions}}"],{"encoding":"utf-8","stdio":["pipe","pipe","pipe"]}],["podman",["--version"],{"encoding":"utf-8","stdio":["pipe","pipe","pipe"]}],["podman",["info","--format","{{.Host.Remote}}"],{"encoding":"utf-8","stdio":["pipe","pipe","pipe"]}],["podman",["info","--format","{{.Host.Security.Rootless}}"],{"encoding":"utf-8","stdio":["pipe","pipe","pipe"]}],["docker",["context","inspect","--format","{{.Endpoints.docker.Host}}"],{"encoding":"utf-8","stdio":["pipe","pipe","pipe"]}],["docker",["context","inspect","--format","{{.Endpoints.docker.Host}}","--","colima"],{"encoding":"utf-8","stdio":["pipe","pipe","pipe"]}],["docker",["context","inspect","--format","{{.Endpoints.docker.Host}}","--"," --format=hostile "],{"encoding":"utf-8","stdio":["pipe","pipe","pipe"]}]];

function compareFrozenRows(rows,descriptor){
 assert.equal(rows.length,descriptor.length);
 for(let i=0;i<rows.length;i++){
 const row=rows[i],identity=(row.form?row.form+':':'')+row.name;
 assert.equal(identity,descriptor[i].identity);
 assert.equal(createHash('sha256').update(JSON.stringify(row)).digest('hex'),descriptor[i].sha256,'frozen observation '+identity);
 }
}

async function verifyControlledRuntimeCore(payload){
 const {createRuntimeCapabilitiesCollector}=await import(pathToFileURL(path.join(payload,'dist/application/runtime-capabilities.js')).href);
 const trace=[];let cache=null,failPublication=true;const publicationFault=Error('controlled-publication');
 const note=(name,result)=>(...args)=>{trace.push([name,...args]);return result;};
 const ports={readCachedInfo:()=>{trace.push(['cache']);return cache;},publishCachedInfo:info=>{trace.push(['publish']);if(failPublication)throw publicationFault;cache=info;},
 readVitestFlag:note('vitest','1'),readExplicitOverride:note('override',null),selectRuntime:note('select','docker'),readPlatform:note('platform','linux'),
 observeVersion:note('version',{status:0,stdout:'Docker 27.1.1'}),observeDockerOperatingSystem:note('os',{status:0,stdout:'Ubuntu'}),readSelectedDockerEndpoint:note('endpoint',null),
 observePodmanRemote:note('remote',{status:0,stdout:'false'}),observeDockerSecurityOptions:note('security',{status:0,stdout:'[]'}),observePodmanRootless:note('rootless',{status:0,stdout:'false'}),
 readWslDistributionName:note('wsl',undefined),observeWslMirroredLoopback:note('loopback',false),readRuntimeSocketOverride:note('socket',undefined),readXdgRuntimeDirectory:note('xdg',undefined),readEffectiveUidOrDefault:note('uid',0),joinPodmanSocketPath:note('join','/unused')};
 const collect=createRuntimeCapabilitiesCollector(ports);assert.deepEqual(trace,[],'construction performs no observations');
 for(let i=0;i<2;i++){assert.throws(collect,e=>e===publicationFault);assert.equal(cache,null);}
 assert.deepEqual(trace,[['cache'],['vitest'],['override'],['publish'],['cache'],['vitest'],['override'],['publish']]);
 failPublication=false;trace.length=0;const first=collect();assert.equal(first.version,'0.0.0');assert.deepEqual(trace,[['cache'],['vitest'],['override'],['publish'],['cache']]);
 first.version='externally-mutated';trace.length=0;assert.equal(collect(),first);assert.equal(first.version,'externally-mutated');assert.deepEqual(trace,[['cache']]);
 const {readWslDistributionName,...missing}=ports;assert.throws(()=>createRuntimeCapabilitiesCollector(missing),/readWslDistributionName/);
}
// Author-only snippet. Parent must run in an isolated child with HOME equal to privateHome.
// No checkout module or archived source is imported at runtime.
async function mcpPayloadConsumer(payload, privateHome, ts) {
  const {default: assert} = await import('node:assert/strict');
  const {default: fs} = await import('node:fs');
  const {default: os} = await import('node:os');
  const path = await import('node:path');
  const {pathToFileURL,fileURLToPath} = await import('node:url');
  const {syncBuiltinESMExports} = await import('node:module');
  const {createHash} = await import('node:crypto');
  assert.equal(os.homedir(), privateHome);
  const hash = text => createHash('sha256').update(text).digest('hex');
  const saved = [], denied = [];
  const diagnosticStringify=JSON.stringify;
  let stage='install-fences', consumerFailed=false;
  const replace = (object, name, value) => {
    saved.push([object, name, Object.getOwnPropertyDescriptor(object, name)]);
    Object.defineProperty(object, name, {configurable: true, writable: true, value});
  };
  const deny = name => (...args) => { denied.push(name); throw new Error(`MCP forbidden effect: ${name}`); };
  const child = (await import('node:child_process')).default;
  for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) replace(child,name,deny(name));
  replace(process,'kill',deny('process.kill'));
  for (const module of ['node:net','node:tls','node:http','node:https','node:dgram']) {
    const native = (await import(module)).default;
    for (const name of ['connect','createConnection','request','get','createServer','createSocket']) if (typeof native[name] === 'function') replace(native,name,deny(`${module}.${name}`));
    for(const constructor of ['Socket','Server','TLSSocket'])if(native[constructor]?.prototype)for(const name of ['connect','listen'])if(typeof native[constructor].prototype[name]==='function')replace(native[constructor].prototype,name,deny(`${module}.${constructor}.${name}`));
  }
  if (globalThis.fetch) replace(globalThis,'fetch',deny('fetch'));
  const native = Object.fromEntries(['existsSync','readFileSync','writeFileSync','mkdirSync','openSync','unlinkSync','renameSync','rmSync','rmdirSync','symlinkSync','linkSync','chmodSync','lstatSync','realpathSync'].map(name=>[name,fs[name]]));
  const descriptors=new Map();
  const owned = (file,readonly=false) => {
    const deniedBefore=denied.length;
    try {
    if(typeof file==='number'){assert(descriptors.has(file),'unowned native descriptor');return owned(descriptors.get(file),readonly);}
    if(file instanceof URL){
      if(file.protocol!=='file:' || file.search || file.hash)return deny('invalid filesystem URL')();
      try{file=fileURLToPath(file);}catch(error){return deny('invalid filesystem URL')();}
    }
    assert.equal(typeof file,'string');
    const absolute = path.resolve(file);
    const payloadRoot=path.resolve(payload);
    const payloadRead=readonly && absolute.startsWith(payloadRoot+path.sep);
    if (!(absolute === privateHome || absolute.startsWith(privateHome + path.sep) || payloadRead)) {
      denied.push('filesystem-outside-private-home'); throw new Error(`MCP unowned filesystem operation: ${absolute}`);
    }
    const root=payloadRead?payloadRoot:privateHome;
    if(readonly){
      const stat=native.lstatSync(absolute);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1,'ordinary single-link shipped read');
      assert.equal(native.realpathSync(absolute),absolute,'shipped read must resolve exactly');
      assert(native.lstatSync(root).isDirectory() && !native.lstatSync(root).isSymbolicLink());
      assert.equal(native.realpathSync(root),root);
    }
    let ancestor = absolute;
    while (ancestor !== root) {
      if (native.existsSync(ancestor)) assert.equal(native.lstatSync(ancestor).isSymbolicLink(), false);
      ancestor = path.dirname(ancestor);
    }
    }catch(error){if(denied.length===deniedBefore)denied.push('filesystem-guard');throw error;}
  };
  // Real native private locks remain enabled. Payload ESM loading uses the loader's FS.
  replace(fs,'openSync',(file,...args)=>{const readonly=args[0]==='r' || args[0]===fs.constants.O_RDONLY || args[0]===(fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));owned(file,readonly);const fd=native.openSync(file,...args);descriptors.set(fd,file);return fd;});
  const nativeClose=fs.closeSync;replace(fs,'closeSync',(fd)=>{if(!descriptors.has(fd))return deny('unowned native descriptor')();try{return nativeClose(fd);}finally{descriptors.delete(fd);}});
  for (const name of ['writeFileSync','mkdirSync','unlinkSync','rmSync','rmdirSync','chmodSync']) replace(fs,name,(file,...args)=>{owned(file);return native[name](file,...args);});
  for (const name of ['renameSync','symlinkSync','linkSync']) replace(fs,name,(from,to,...args)=>{owned(from);owned(to);return native[name](from,to,...args);});
  replace(fs,'readFileSync',(file,...args)=>{
    if(file==='/proc/sys/kernel/random/boot_id')return 'mcp-private-fixture-boot\n';
    if(file===`/proc/${process.pid}/cmdline`)return Buffer.from('node\0mcp-private-fixture\0');
    if(file===`/proc/${process.pid}/stat`)return `${process.pid} (mcp-fixture) ${Array(19).fill('0').join(' ')} 12345`;
    owned(file,true);return native.readFileSync(file,...args);
  });
  syncBuiltinESMExports();
  const parseDescriptor = Object.getOwnPropertyDescriptor(JSON,'parse');
  const stringifyDescriptor = Object.getOwnPropertyDescriptor(JSON,'stringify');
  try {
    const resolve = relative => {
      const file = path.resolve(payload,relative);
      assert(file.startsWith(path.resolve(payload)+path.sep)); assert(native.existsSync(file),`Missing shipped MCP module ${relative}`);
      return pathToFileURL(file).href;
    };
    stage='compiled-payload-imports';
    const facade = await import(resolve('dist/mcp-forward.js'));
    await import(resolve('dist/application/mcp-forward.js'));
    const adapter = await import(resolve('dist/adapters/mcp-forward.js'));
    const utils = await import(resolve('dist/utils.js'));
    const originalParse = parseDescriptor.value, originalStringify = stringifyDescriptor.value;
    const host = path.join(privateHome,'.claude.json');
    const raw = new Error('raw-error');
    let mode, target, events, active = false, existsFile, parserIndex;
    const restoreJson = () => {Object.defineProperty(JSON,'parse',parseDescriptor);Object.defineProperty(JSON,'stringify',stringifyDescriptor);};
    replace(fs,'existsSync',(file,...args)=>{
      if (active && (file === target || file === host)) {existsFile=file;events.push(['exists',file]);}
      return native.existsSync(file,...args);
    });
    replace(fs,'readFileSync',(file,...args)=>{
      if(file==='/proc/sys/kernel/random/boot_id')return 'mcp-private-fixture-boot\n';
      if(file===`/proc/${process.pid}/cmdline`)return Buffer.from('node\0mcp-private-fixture\0');
      if(file===`/proc/${process.pid}/stat`)return `${process.pid} (mcp-fixture) ${Array(19).fill('0').join(' ')} 12345`;
      if (active && (file === target || file === host)) {
        events.push(['read',file]);
        if ((mode==='claude-parser-replacement' && file===target) || (mode==='host-parser-replacement' && file===host)) {
          Object.defineProperty(JSON,'parse',{configurable:true,writable:true,value:()=>({})});
        }
      }
      owned(file,true); return native.readFileSync(file,...args);
    });
    replace(fs,'writeFileSync',(file,text,...args)=>{
      owned(file);
      if(mode==='public'&&typeof file==='string')events.push(['publication',file]);
      if (active && file===target) {events.push('selected-write');if(mode==='selected-writer-throw') throw raw;}
      return native.writeFileSync(file,text,...args);
    });
    const selectedWriter=fs.writeFileSync;
    syncBuiltinESMExports();
    const goldens = {
      normal:['da0eea1b512abcbb22449202574456b90066c85998112f92b4e4468a320e5826','b42a5706c79ba1e4a34ae771ba8eb3b6d79efecff7332fab1817df8c796cff44'],
      'writer-replacement':['da0eea1b512abcbb22449202574456b90066c85998112f92b4e4468a320e5826','b42a5706c79ba1e4a34ae771ba8eb3b6d79efecff7332fab1817df8c796cff44'],
      'serializer-throw':['af7e0e60ef1cb6299c9cf719e651eac394d2005ba01ea0028f5b8c88c6ef992d','b42a5706c79ba1e4a34ae771ba8eb3b6d79efecff7332fab1817df8c796cff44'],
      'selected-writer-throw':['af7e0e60ef1cb6299c9cf719e651eac394d2005ba01ea0028f5b8c88c6ef992d','b42a5706c79ba1e4a34ae771ba8eb3b6d79efecff7332fab1817df8c796cff44'],
      'claude-parser-replacement':['06a4d19497feba13ca3d08b1fa06972d0e8ba7f2ae8f47041568bfcc0d4e844a','b83b5af2d2409e7389f4bb1814e47eeca5a9189d2924c76d58542462ae9724d2'],
      'host-parser-replacement':['da0eea1b512abcbb22449202574456b90066c85998112f92b4e4468a320e5826','b42a5706c79ba1e4a34ae771ba8eb3b6d79efecff7332fab1817df8c796cff44'],
      'claude-getter-throw':['52e4422e166703ea1fb5e13fc305f26837713cc5e39ac0b960b37d9fcb9b29a5','b42a5706c79ba1e4a34ae771ba8eb3b6d79efecff7332fab1817df8c796cff44'],
      'host-getter-throw':['06a4d19497feba13ca3d08b1fa06972d0e8ba7f2ae8f47041568bfcc0d4e844a','b83b5af2d2409e7389f4bb1814e47eeca5a9189d2924c76d58542462ae9724d2'],
    };
    for (mode of Object.keys(goldens)) {
      stage='compiled-'+mode;
      restoreJson();active=false;fs.writeFileSync=selectedWriter;syncBuiltinESMExports();
      const profile='callee-'+mode;
      target=utils.getClaudeJsonFile(profile);const codex=utils.getCodexConfigFile(profile);
      owned(target);owned(codex);fs.mkdirSync(path.dirname(target),{recursive:true});fs.mkdirSync(path.dirname(codex),{recursive:true});
      native.writeFileSync(target,'{"retained":true}');native.writeFileSync(host,'{"mcpServers":{"host":{"command":"node"}}}');native.writeFileSync(codex,'model = "keep"\n');
      events=[];parserIndex=0;active=true;
      Object.defineProperty(JSON,'parse',{configurable:true,get(){
        const file=existsFile;events.push(['parser:get',file]);parserIndex++;
        if ((mode==='claude-getter-throw' && parserIndex===1)||(mode==='host-getter-throw' && parserIndex===2)) throw raw;
        return originalParse;
      }});
      Object.defineProperty(JSON,'stringify',{configurable:true,writable:true,value:(...args)=>{
        if(args[2]!==2)return originalStringify(...args);
        events.push('serialize');
        if(mode==='writer-replacement') {fs.writeFileSync=deny('replacement-writer');syncBuiltinESMExports();}
        if(mode==='serializer-throw') throw raw;
        return originalStringify(...args);
      }});
      let failure,result;
      try {result=facade.buildMcpConfig(profile);}catch(error){failure=error;}
      active=false;restoreJson();fs.writeFileSync=selectedWriter;syncBuiltinESMExports();
      assert.equal(failure,mode==='serializer-throw'||mode==='selected-writer-throw'?raw:undefined);
      if(!failure) assert.deepEqual(result,mode==='claude-parser-replacement'||mode==='host-getter-throw'?[]:['host']);
      assert.equal(hash(native.readFileSync(target,'utf8')),goldens[mode][0],mode+' Claude bytes');
      assert.equal(hash(native.readFileSync(codex,'utf8')),goldens[mode][1],mode+' Codex bytes');
      for(const file of [target,host]) {
        const existence=events.findIndex(event=>Array.isArray(event)&&event[0]==='exists'&&event[1]===file);
        const getter=events.findIndex(event=>Array.isArray(event)&&event[0]==='parser:get'&&event[1]===file);
        const read=events.findIndex(event=>Array.isArray(event)&&event[0]==='read'&&event[1]===file);
        assert(getter>existence);assert.equal(read===-1,mode===(file===target?'claude-getter-throw':'host-getter-throw'));
        if(read!==-1)assert(read>getter);
      }
      assert.equal(events.includes('selected-write'),mode!=='serializer-throw');
      if(events.includes('selected-write'))assert(events.indexOf('selected-write')>events.indexOf('serialize'));
    }
    // Public default and named profile regeneration uses real private native locks.
    for(const profile of [undefined,'work']) {
      stage='public-profile-'+(profile??'default');
      mode='public';events=[];active=false;restoreJson();
      target=utils.getClaudeJsonFile(profile);const codex=utils.getCodexConfigFile(profile);
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.mkdirSync(path.dirname(codex),{recursive:true});
      native.writeFileSync(target,'{"retained":true}');native.writeFileSync(codex,'model = "keep"\n');
      native.writeFileSync(host,'{"mcpServers":{"host":{"url":"http://localhost:8181/sse"}}}');
      let restores=0;
      const lockFile=profile===undefined?path.join(privateHome,'.ccc','codex-config.lock'):path.join(privateHome,'.ccc','run','locks',`codex-config-${hash(codex)}.lock`);
      const restore=function(){assert.equal(this,undefined);assert(native.existsSync(lockFile),'actual native lock absent during restoration');restores++;};
      assert.deepEqual(facade.buildMcpConfig(profile,restore),['host']);
      const before=native.readFileSync(codex,'utf8'), inode=fs.statSync(codex).ino;
      assert.deepEqual(facade.buildMcpConfig(profile,restore),['host']);assert.equal(restores,2);
      assert.equal(native.readFileSync(codex,'utf8'),before);assert.equal(fs.statSync(codex).ino,inode);
      assert.equal(events.filter(event=>Array.isArray(event)&&event[0]==='publication'&&event[1]===codex).length,1,'unchanged Codex publication must be skipped');
      assert(before.includes('model = "keep"'));assert(before.includes('http://host.docker.internal:8181/sse'));
      const config=originalParse(native.readFileSync(target,'utf8'));assert.equal(config.retained,true);assert(config.mcpServers['device-lab']);
    }
    // Construction must not select the native publication writer.
    stage='compiled-construction';
    let selections=0;const ports=adapter.createNativeMcpConfigPorts();
    const descriptor=Object.getOwnPropertyDescriptor(ports,'publishClaudeProfile');
    Object.defineProperty(ports,'publishClaudeProfile',{...descriptor,get(){selections++;return descriptor.get.call(ports);}});
    const app=await import(resolve('dist/application/mcp-forward.js'));app.createMcpConfigRegenerator(ports);assert.equal(selections,0);
    assert(ts,'checker-owned TypeScript compiler required for actual payload CLI8');
    stage='payload-mapped-CLI8';
    await mcpPayloadCliConsumer(payload,privateHome,ts,name=>denied.push(name));
    return {parserCases:4,writerCases:4,publicProfiles:2,cliCases:8};
  } catch(error) {
    consumerFailed=true;
    // Preserve the exact failure; cleanup diagnostics must never replace it.
    try { console.error(diagnosticStringify({consumer:'MCP-shipping',stage,
      error:{name:error?.name,message:String(error?.message??error).slice(0,1200)},
      deniedEffects:denied.length,denied:denied.slice(0,8).map(name=>String(name).slice(0,160))}).slice(0,2400)); } catch { /* diagnostic only */ }
    throw error;
  } finally {
    const cleanupFailures=[];
    const restore=operation=>{try{operation();}catch(error){cleanupFailures.push(error);}};
    restore(()=>Object.defineProperty(JSON,'parse',parseDescriptor));
    restore(()=>Object.defineProperty(JSON,'stringify',stringifyDescriptor));
    for(const [object,name,descriptor] of saved.reverse())restore(()=>{
      if(descriptor!==undefined)Object.defineProperty(object,name,descriptor);
      else assert.equal(Reflect.deleteProperty(object,name),true,'restore original property absence');
    });
    restore(()=>syncBuiltinESMExports());
    if(consumerFailed){
      if(cleanupFailures.length)try{console.error(diagnosticStringify({consumer:'MCP-cleanup',stage,cleanupFailures:cleanupFailures.map(error=>String(error?.message??error).slice(0,160)).slice(0,8)}).slice(0,1600));}catch{/* diagnostic only */}
    }else{
      if(cleanupFailures.length)throw cleanupFailures[0];
      assert.deepEqual(denied,[], 'caught forbidden MCP effects');
    }
  }
}

// Parent substitutes a relative emitted-module prefix from its strict .mts location.
function mcpStrictConsumer(prefix) {
  return `
import {buildMcpConfig,readHostMcpServers,rewriteLocalhostUrl,processServerForContainer} from '${prefix}/mcp-forward.js';
import {createMcpConfigRegenerator} from '${prefix}/application/mcp-forward.js';
import type {McpConfigRegenerationPorts} from '${prefix}/ports/mcp-forward.js';
import type {McpServerConfig} from '${prefix}/domain/mcp-forward.js';
const result:string[]=buildMcpConfig();
const named:string[]=buildMcpConfig('work',()=>{});
const explicit:string[]=buildMcpConfig(undefined,undefined);
const host:Record<string,McpServerConfig>=readHostMcpServers();
const url:string=rewriteLocalhostUrl('http://localhost');
const server:McpServerConfig=processServerForContainer('x',{command:'node'});
type Claude={readonly claude:unique symbol};type Codex={readonly codex:unique symbol};
declare const c:Claude;declare const d:Codex;
const ports:McpConfigRegenerationPorts<Claude,Codex>={
 resolveClaudeProfile:()=>c,
 readClaudeProfileDocument:binding=>{const opaque:Claude=binding;return ()=>'';},
 readHostMcpDocument:()=>undefined,
 withCodexProfileLock:<T>(profile:string|undefined,operation:()=>T):T=>operation(),
 prepareCodexProfile:()=>({binding:d,existingText:''}),
 publishCodexProfile:(binding,text)=>{const opaque:Codex=binding;return undefined;},
 publishClaudeProfile:(binding,text)=>{const opaque:Claude=binding;return undefined;}
};
const built:string[]=createMcpConfigRegenerator(ports).build('work',()=>{});
const locked:number=ports.withCodexProfileLock(undefined,()=>1);
const optional:(()=>string)|undefined=ports.readHostMcpDocument();
const codexUndefined:undefined=ports.publishCodexProfile(d,'');
const claudeUndefined:undefined=ports.publishClaudeProfile(c,'');
// @ts-expect-error all seven semantic ports are required
const missing:McpConfigRegenerationPorts<Claude,Codex>={resolveClaudeProfile:()=>c};
// @ts-expect-error public build remains synchronous
const asynchronous:Promise<string[]>=buildMcpConfig();
// @ts-expect-error host reader remains synchronous
const asynchronousHost:Promise<Record<string,McpServerConfig>>=readHostMcpServers();
// @ts-expect-error profile remains a string
buildMcpConfig(1);
// @ts-expect-error distinct opaque binding
ports.publishClaudeProfile(d,'');
// @ts-expect-error distinct opaque binding
ports.publishCodexProfile(c,'');
// @ts-expect-error callback capability remains synchronous
const asyncCapability:McpConfigRegenerationPorts<Claude,Codex>['readHostMcpDocument']=()=>async()=>'';
// @ts-expect-error document capability acquisition remains synchronous
const asyncRead:McpConfigRegenerationPorts<Claude,Codex>['readHostMcpDocument']=async()=>()=>'';
// @ts-expect-error publisher must return undefined, not void
const voidCodex:McpConfigRegenerationPorts<Claude,Codex>['publishCodexProfile']=()=>{};
// @ts-expect-error publisher must return undefined, not void
const voidClaude:McpConfigRegenerationPorts<Claude,Codex>['publishClaudeProfile']=()=>{};
// @ts-expect-error publisher remains synchronous
const asyncCodex:McpConfigRegenerationPorts<Claude,Codex>['publishCodexProfile']=async()=>{};
// @ts-expect-error publisher remains synchronous
const asyncClaude:McpConfigRegenerationPorts<Claude,Codex>['publishClaudeProfile']=async()=>{};
// @ts-expect-error prepare retains binding plus original text
const badPrepare:McpConfigRegenerationPorts<Claude,Codex>['prepareCodexProfile']=()=>d;
// @ts-expect-error build remains synchronous
const badBuild:Promise<string[]>=createMcpConfigRegenerator(ports).build();
`;
}

// Invoke under the same effect fences as mcpPayloadConsumer, before its finally.
// `ts` is the checker-owned compiler, never a candidate source loader.
async function mcpPayloadCliConsumer(payload,privateHome,ts,recordDenied) {
  const {default:assert}=await import('node:assert/strict');
  const fs=await import('node:fs');const path=await import('node:path');
  const {createRequire}=await import('node:module');const {pathToFileURL}=await import('node:url');
  const {runInThisContext}=await import('node:vm');
  const emittedRoot=path.resolve(payload,'dist'), cache=new Map(), observed=new Set();
  const nativeRequire=createRequire(path.join(payload,'dist/index.js'));
  const f={events:[],positions:[],running:false,profile:undefined,locked:false,claude:'',codex:''};
  const noop=()=>{};
  const mockFactories={
    'container-command.js':()=>({runContainerCommand:async(_runtime,args)=>{assert(args.includes('final-id'));assert.equal(f.events.at(-1),'confirm');f.events.push('command');return 0;}}),
    'docker.js':()=>({ensureDockerRunning:noop,ensureCredentialHostDir:noop,getContainerName:()=> 'ccc-fixture',getContainerStatus:()=>({exists:true,running:f.running,imageId:'sha256:old',containerId:'old-id'}),startProjectContainer:(...args)=>{f.events.push('start');if(!f.running)args[9]('final-id');args[7]('final-id',{startedByInvocation:!f.running});return 'ccc-fixture';},isContainerRunning:()=>true,restoreCodexConfigHostOwnership:(id,profile)=>{assert.equal(id,'final-id');assert.equal(profile,f.profile);assert.equal(f.locked,true);f.positions.push(fs.existsSync(f.codex));f.events.push('restore');},prepareCodexConfigForContainer:(id,profile)=>{assert.equal(id,'final-id');assert.equal(profile,f.profile);assert(f.locked);f.events.push('prepare');},syncClipboardShims:()=>f.events.push('clipboard'),ensureContainerManagerSocketAccess:noop}),
    'container-runtime.js':actual=>({...actual,runtimeCli:()=> 'docker',deviceBrokerBindHostForContainer:()=> '127.0.0.1'}),
    'worktree.js':actual=>({...actual,detectWorktreeWorkspaceBranch:()=>null,getWorktreeGitMounts:()=>[]}),
    'profile.js':actual=>({...actual,profileExists:()=>true}),
    'clipboard-server.js':()=>({ensureClipboardServer:async()=>null,hasAnyActiveSessionsExcept:()=>false,retireClipboardServerFromPortFile:noop}),
    'home-layout.js':actual=>({...actual,ensureDefaultProfileDir:noop,migrateHomeLayout:()=>f.events.push('layout')}),
    'home-layout-container-guard.js':()=>({hasLegacyHomeLayoutContainerMounts:()=>false}),
    'device-lab-admin.js':()=>({cleanupOwnerDevices:noop}),
    'container-setup.js':()=>({CLAUDE_BIN_PATH:'/home/ccc/.local/bin/claude',ensureUvAvailable:()=>f.events.push('uv'),ensureClaudeInContainer:id=>{assert.equal(id,'final-id');f.events.push('claude-ready');},ensureTools:(id,tool)=>{assert.equal(id,'final-id');assert(fs.readFileSync(f.codex,'utf8').includes('url = "http://host.docker.internal:8181/sse"'));assert.equal(JSON.parse(fs.readFileSync(f.claude,'utf8')).mcpServers.forwarded.url,'http://host.docker.internal:8181/sse');assert.deepEqual(f.positions,[false,false]);f.events.push('tool:'+tool.name);}}),
    'codex-config-lock.js':actual=>({withCodexConfigLock:(operation,profile)=>{assert.equal(profile,f.profile);assert.equal(f.locked,false);return actual.withCodexConfigLock(()=>{f.locked=true;f.events.push('lock');try{return operation();}finally{f.locked=false;f.events.push('unlock');}},profile);}}),
    'codex-state-ownership.js':()=>({assertCodexStateAccessible:(id,profile)=>{assert.equal(id,'final-id');assert.equal(profile,f.profile);f.events.push('state');}}),
    'codex-harness.js':()=>({ensureCodexHarness:(id,profile)=>{assert.equal(id,'final-id');assert.equal(profile,f.profile);f.events.push('harness');}}),
    'localhost-proxy-setup.js':()=>({setupLocalhostProxy:()=>f.events.push('proxy')}),
    'codex-clipboard-image.js':()=>({maybeAttachCodexClipboardImage:async(_path,args)=>({args})}),
    'codex-launch.js':()=>({prepareCodexLaunch:(_runtime,args,command)=>{assert(args.includes('final-id'));f.events.push('launch-preparation');return{ok:true,command};}}),
    'utils.js':actual=>({...actual,DATA_DIR:path.join(privateHome,'.ccc'),collectForwardedEnv:()=>({forwarded:[],skippedDueToLimit:[],totalBytes:0}),writeOwnedEnvFile:()=>({path:path.join(privateHome,'exec.env'),dispose:()=>f.events.push('unlink')})}),
    'session.js':actual=>({...actual,acquireHostSessionOwnership:async request=>{actual.setSession(path.join(privateHome,'session.lock'),request.projectPath,request.profile,request.toolName);actual.setSessionCleanupEnabled(false);return{lockFile:path.join(privateHome,'session.lock'),existingId:f.running?'old-id':null};},confirmSessionOwnership:async()=>f.events.push('confirm'),createSessionLock:()=>path.join(privateHome,'session.lock'),setupSignalHandlers:noop,getActiveSessionsForContainer:()=>[],cleanupSession:()=>f.events.push('cleanup'),withContainerLifecycleLock:(_key,operation)=>operation(),withContainerSetupLockAsync:async(_key,operation)=>operation()}),
  };
  const partial=new Set(['container-runtime.js','worktree.js','profile.js','home-layout.js','codex-config-lock.js','utils.js','session.js']);
  const load=(file,unmocked=false)=>{
    file=path.resolve(file);assert(file.startsWith(path.resolve(payload)+path.sep),'CLI checkout fallback');
    const key=file+(unmocked?'#actual':'');if(cache.has(key))return cache.get(key).exports;
    const module={exports:{}};cache.set(key,module);
    const base=path.relative(emittedRoot,file);
    if(!unmocked&&mockFactories[base]){module.exports=mockFactories[base](partial.has(base)?load(file,true):undefined);return module.exports;}
    assert(fs.existsSync(file),'missing emitted CLI dependency '+file);observed.add(file);
    const original=fs.readFileSync(file,'utf8');
    const compiled=ts.transpileModule(original.replace(/import\.meta\.url/g,JSON.stringify(pathToFileURL(file).href)),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const requireMapped=specifier=>{
      if(specifier==='child_process'||specifier==='node:child_process')return {...nativeRequire(specifier),spawnSync:(_runtime,args,options)=>{
        try {
        assert.equal(_runtime,'docker');
        if(args[1]==='-d'){assert.deepEqual(args,['exec','-d','final-id','/usr/local/bin/ccc-x11-bridge']);assert.deepEqual(options,{stdio:'ignore'});f.events.push('bridge');return{status:0,stdout:'',stderr:''};}
        assert.deepEqual(options,{stdio:'inherit'});assert.deepEqual(args,['exec','-w',f.projectMount,'final-id','sh','-c','mise trust -a >/dev/null 2>&1 || true; mise install -y || true']);
        assert.equal(f.running,false);f.events.push('mise');return{status:0,stdout:'',stderr:''};
        }catch(error){recordDenied('CLI unallocated subprocess');throw error;}
      }};
      if(specifier==='@ccc/device-lab/device-lab-broker.js')return{DEVICE_BROKER_DEFAULT_HOST:'127.0.0.1',ensureHostDeviceBroker:async()=>({ok:true})};
      if(specifier.startsWith('.'))return load(path.resolve(path.dirname(file),specifier));
      if(specifier.startsWith('@ccc/'))return load(createRequire(file).resolve(specifier));
      return nativeRequire(specifier);
    };
    runInThisContext('(function(require,module,exports,__filename,__dirname){'+compiled+'\n})',{filename:file})(requireMapped,module,module.exports,file,path.dirname(file));
    return module.exports;
  };
  const argv=process.argv,exit=process.exit,cwd=process.cwd();
  const environment=Object.fromEntries(['CCC_PROFILE','DEBUG','container','VITEST'].map(key=>[key,process.env[key]]));
  class Exit extends Error {constructor(status){super('fixture exit');this.status=status;}}
  try {
    process.env.VITEST='1';process.env.DEBUG='';process.env.container='';process.exit=status=>{throw new Exit(Number(status));};
    const project=path.join(privateHome,'cli-project');fs.mkdirSync(project,{recursive:true});fs.writeFileSync(path.join(project,'mise.toml'),'[tools]\n');process.chdir(project);
    const index=load(path.join(emittedRoot,'index.js'));
    const utils=load(path.join(emittedRoot,'utils.js'));
    const session=load(path.join(emittedRoot,'session.js'));
    f.projectMount='/project/'+utils.getProjectId(project);
    for(const running of [false,true])for(const tool of ['codex','claude'])for(const named of [false,true]) {
      f.running=running;f.profile=named?'work':undefined;f.events=[];f.positions=[];f.locked=false;
      process.env.CCC_PROFILE=f.profile??'';process.argv=[process.execPath,'ccc',tool];session.clearSession();
      f.claude=utils.getClaudeJsonFile(f.profile);f.codex=utils.getCodexConfigFile(f.profile);
      fs.mkdirSync(path.dirname(f.claude),{recursive:true});if(fs.existsSync(f.codex))fs.unlinkSync(f.codex);
      fs.writeFileSync(path.join(privateHome,'.claude.json'),'{"mcpServers":{"forwarded":{"url":"http://localhost:8181/sse"}}}');
      let failure;try{await index.main();}catch(error){failure=error;}
      assert(failure instanceof Exit,`actual emitted main() route failed: ${failure?.stack}`);assert.equal(failure.status,0);
      assert(fs.readFileSync(f.codex,'utf8').includes('[mcp_servers.device-lab]'));
      assert(JSON.parse(fs.readFileSync(f.claude,'utf8')).mcpServers['device-lab'].args.includes('/opt/ccc/dist/device-lab-mcp/server.mjs'));
      assert.equal(f.events.includes('uv'),!running);assert(f.events.includes('tool:'+tool));assert.deepEqual(f.positions.slice(0,2),[false,false]);
      assert.equal(f.events.slice(0,f.events.indexOf('tool:'+tool)).filter(event=>event==='restore').length,2);
      assert(f.positions.slice(2).every(Boolean));assert(f.events.indexOf('command')>f.events.indexOf('tool:'+tool));
    }
    for(const relative of ['index.js','mcp-forward.js','application/mcp-forward.js','adapters/mcp-forward.js'])assert(observed.has(path.join(emittedRoot,relative)),`not executed: emitted ${relative}`);
  } finally {
    process.argv=argv;process.exit=exit;process.chdir(cwd);
    for(const [key,value]of Object.entries(environment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
}

const SANDBOX_CREATE_DECLARATION_CONSUMER = `
import { createWindowsSandboxCreate } from "./reviewed-sandbox-declarations/application/lifecycle/windows-sandbox-create.mjs";
import type { WindowsSandboxCreatePorts } from "./reviewed-sandbox-declarations/ports/lifecycle/windows-sandbox-create.mjs";
import { createBrokerWindowsSandboxCreate } from "./dist/packages/device-lab/dist/device-lab/application/lifecycle/windows-sandbox-create.js";
import type { BrokerWindowsSandboxCreatePorts } from "./dist/packages/device-lab/dist/device-lab/ports/lifecycle/windows-sandbox-create.js";
import * as shared from "./reviewed-sandbox-declarations/state/state-file.mjs";
import type { Stats } from "node:fs";
declare const direct: WindowsSandboxCreatePorts<{scratch:string}>;
declare const broker: BrokerWindowsSandboxCreatePorts<{name:string},{id:string;createdAt:string},{ok:boolean;receipt:"native"}>;
const sync = createWindowsSandboxCreate(direct).create({backend:"windows-sandbox"});
const pending: Promise<unknown> = createBrokerWindowsSandboxCreate(broker).create({name:"Sandbox"});
// @ts-expect-error Direct creation remains synchronous.
const deferred: Promise<unknown> = sync;
// @ts-expect-error Helper metadata cannot defer its native operation.
createWindowsSandboxCreate({...direct,ensureHelperWorkspace:async()=>({scratch:"private"})});
// @ts-expect-error Definitions must be read synchronously.
createWindowsSandboxCreate({...direct,readDefinitions:async()=>[]});
// @ts-expect-error Native config publication must complete synchronously.
createBrokerWindowsSandboxCreate({...broker,publishConfig:async()=>"config"});
// @ts-expect-error Native compensation mutation remains synchronous.
createBrokerWindowsSandboxCreate({...broker,removeMatchingClaim:async()=>[]});
// @ts-expect-error Rollback returns asynchronous evidence.
createBrokerWindowsSandboxCreate({...broker,rollbackAfterClaimFailure:()=>({ok:true,receipt:"native" as const})});
// @ts-expect-error Required ports have no native defaults.
createBrokerWindowsSandboxCreate();
const token=Symbol("shared-result");
const generic:typeof token|null=shared.readDeviceLabStateFile("file",()=>token,"prefix");
const callback:{fd:number;stat:Stats}|null=shared.withDeviceLabReadableFile("file","prefix",99,(fd,stat)=>({fd,stat}));
// @ts-expect-error Native callback descriptor remains numeric.
shared.withDeviceLabReadableFile("file","prefix",99,(fd:string)=>fd);
void[pending,deferred,generic,callback];
`;

function verifyGuardianStartupClosure(packageRoot) {
    const visited = new Set();
    const visit = file => {
        if (visited.has(file)) return;
        const within = relative(packageRoot, file);
        assert.ok(within && !within.startsWith(`..${sep}`) && within !== "..",
            `guardian startup dependency must resolve inside shipped payload: ${file}`);
        const shippedPath = within.replaceAll(sep, "/");
        const source = readFileSync(file, "utf8");
        const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        if (shippedPath === "dist/packages/device-lab/providers/application/state-file-read.mjs") {
            // One admitted pure policy dependency; no provider implementation is authorized.
            assert.equal(createHash("sha256").update(source).digest("hex"),
                "691d62cfbdbb2339493ef4d127410a471af8656fa8ba55f09d0d6844713688de",
                "guardian state-read policy must match the immutable admitted source");
            assert.equal(tree.parseDiagnostics.length, 0, "pure startup policy must parse without errors");
            assert.ok(tree.statements.length > 0 && tree.statements.every(statement =>
                ts.isFunctionDeclaration(statement) && statement.name && statement.body),
                "admitted startup policy permits only function declarations, without runtime imports or top-level effects");
        } else {
            assert.doesNotMatch(shippedPath,
                /(?:session-cleanup|composition\/session-ownership\.js|device-lab-admin|device-lab-broker|\/providers\/)/,
                "guardian static startup closure must exclude cleanup/admin/broker/provider implementations");
        }
        visited.add(file);
        for (const statement of tree.statements) {
            if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
            const specifier = statement.moduleSpecifier;
            if (!specifier) continue;
            assert.ok(ts.isStringLiteral(specifier), "startup dependencies must be literal");
            if (isBuiltin(specifier.text)) continue;
            visit(createRequire(pathToFileURL(file)).resolve(specifier.text));
        }
    };
    visit(join(packageRoot, "dist/session-ownership-guardian.js"));
    assert.ok(visited.has(join(packageRoot, "dist/composition/session-ownership-native.js")));
    assert.ok(visited.has(join(packageRoot, "dist/application/session-ownership.js")));
}

function shippingWaveConsumer(consumer, packageRoot, privateHome, golden) {
    const imports = `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {pathToFileURL} from 'node:url';import {syncBuiltinESMExports,registerHooks} from 'node:module';
import cp from 'node:child_process';import net from 'node:net';import http from 'node:http';import https from 'node:https';
import dgram from 'node:dgram';import tls from 'node:tls';import {createHash} from 'node:crypto';`;
    const program = `${imports}
import ts from ${JSON.stringify(pathToFileURL(join(root, "node_modules/typescript/lib/typescript.js")).href)};
${mcpPayloadCliConsumer.toString()}
const createOwnedImportRead=${createOwnedImportRead.toString()};
${fence.toString()}
${compareFrozenRows.toString()}
${verifyControlledRuntimeCore.toString()}
const frozenRuntimeProbeWhitelist=${JSON.stringify(frozenRuntimeProbeWhitelist)};
const result=await (${consumer.toString()})(${JSON.stringify(packageRoot)},${JSON.stringify(privateHome)},${consumer === mcpPayloadConsumer ? "ts" : JSON.stringify(golden)});
console.log(JSON.stringify({shippingConsumerResult:result??{completed:true}}));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
        cwd: privateHome, env: { ...env, HOME: privateHome, USERPROFILE: privateHome },
        encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(result.status, 0, String(result.error || result.stderr || result.stdout).slice(-4000));
    const rows = result.stdout.trim().split("\n").filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
    assert.ok(rows.some(row=>row.shippingConsumerResult), "shipping consumer must produce an executed result");
    return rows.findLast(row=>row.shippingConsumerResult).shippingConsumerResult;
}

async function smoke(packageRoot) {
    const coverage = [];
    const record = (consumer, layer, detail) => { assert.ok(detail, "consumer completion is required"); coverage.push({consumer, result:"PASS", layer, detail}); };
    verifyGuardianStartupClosure(packageRoot);
    const guardianContract = join(packageRoot, "session-guardian-consumer.mts");
    writeFileSync(guardianContract, `import { cleanupSession } from "./dist/session.js";
import { cleanupCapturedNativeSessionOwnership } from "./dist/composition/session-ownership.js";
import { createSessionCleanup } from "./dist/application/session-cleanup.js";
import { createSessionOwnershipGuardian } from "./dist/application/session-ownership.js";
import type { SessionOwnershipGuardianPorts, SessionOwnershipPorts } from "./dist/ports/session-ownership.js";
declare const ports: SessionOwnershipGuardianPorts;
const asyncPorts: SessionOwnershipGuardianPorts = { ...ports, cleanup: async () => {} };
const guardian = createSessionOwnershipGuardian(asyncPorts);
const disconnect: Promise<void> = guardian.disconnect();
const publicCleanup: ReturnType<typeof cleanupSession> = undefined;
const capturedCleanup: ReturnType<typeof cleanupCapturedNativeSessionOwnership> = undefined;
const applicationCleanup: ReturnType<ReturnType<typeof createSessionCleanup>["cleanupSession"]> = undefined;
const parentCleanup: ReturnType<SessionOwnershipPorts["cleanup"]> = undefined;
// @ts-expect-error Public cleanup remains synchronous void.
const publicPending: ReturnType<typeof cleanupSession> = Promise.resolve();
// @ts-expect-error Native captured cleanup remains synchronous void.
const capturedPending: ReturnType<typeof cleanupCapturedNativeSessionOwnership> = Promise.resolve();
// @ts-expect-error Public application cleanup remains synchronous void.
const applicationPending: ReturnType<ReturnType<typeof createSessionCleanup>["cleanupSession"]> = Promise.resolve();
// @ts-expect-error Parent ownership cleanup remains synchronous void.
const parentPending: ReturnType<SessionOwnershipPorts["cleanup"]> = Promise.resolve();
void [guardian, disconnect, publicCleanup, capturedCleanup, applicationCleanup, parentCleanup,
    publicPending, capturedPending, applicationPending, parentPending];
`);
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "false",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots", join(root, "node_modules/@types"), guardianContract]);
    } finally { rmSync(guardianContract); }

    const waveHome=mkdtempSync(join(temporary,'provider-runtime-wave-'));
    const waveResult=spawnSync(process.execPath,['--input-type=module','-e',
        `await (${verifyProviderRuntimeWave.toString()})(${JSON.stringify(packageRoot)},${JSON.stringify(IDENTITY_IMAGE_SHIPPING_BASELINE)});`],
        {cwd:waveHome,env:{...env,HOME:waveHome,USERPROFILE:waveHome},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,windowsHide:true});
    assert.equal(waveResult.status,0,String(waveResult.error||waveResult.stderr||waveResult.stdout).slice(-4000));

    const waveContract=join(packageRoot,'dist/packages/device-lab/provider-runtime-wave-consumer.mts');
    for(const name of ['domain/destructive-admission','domain/device-flow','ports/device-flow','application/device-flow']) {
        assert.ok(existsSync(join(packageRoot,'dist/packages/device-lab/providers',name+'.mjs')));
        assert.ok(existsSync(join(packageRoot,'dist/packages/device-lab/providers',name+'.d.mts')));
    }
    writeFileSync(waveContract,"import { prepareIdentityImage } from \"../../../dist/application/container/identity-image.js\";\nimport { ensureIdentityImage, resolveContainerIdentity, type ContainerIdentity as PublicIdentity } from \"../../../dist/container-identity.js\";\nimport type { ContainerIdentity, IdentityImageObservation } from \"../../../dist/domain/container/identity-image.js\";\nimport type { IdentityImagePorts } from \"../../../dist/ports/container/identity-image.js\";\nimport { evaluateDestructivePolicy } from \"@ccc/device-lab/providers/domain/destructive-admission.mjs\";\nimport { runDeviceFlow } from \"@ccc/device-lab/providers/application/device-flow.mjs\";\nimport type { DeviceFlowPorts } from \"@ccc/device-lab/providers/ports/device-flow.mjs\";\nimport type { FlowValue } from \"@ccc/device-lab/providers/domain/device-flow.mjs\";\nfunction contracts(ports: IdentityImagePorts, publicIdentity: PublicIdentity, image: IdentityImageObservation) {\n    const inward: ContainerIdentity = publicIdentity;\n    const outward: PublicIdentity = inward;\n    const id: string = prepareIdentityImage(\"a\".repeat(64), outward, ports);\n    ports.observeAccount(image);\n    // @ts-expect-error Non-void undefined return rejects asynchronous tagging.\n    const tag: IdentityImagePorts = { ...ports, tagBase: async () => undefined };\n    // @ts-expect-error Builds must complete synchronously.\n    const build: IdentityImagePorts = { ...ports, buildImage: async () => undefined };\n    // @ts-expect-error Removal must complete synchronously before the validation error.\n    const removal: IdentityImagePorts = { ...ports, removeDerivedImage: async () => undefined };\n    // @ts-expect-error A lock cannot return a deferred result.\n    const lock: IdentityImagePorts = { ...ports, withIdentityLock: async () => id };\n    // @ts-expect-error Locked callbacks cannot defer their workflow.\n    ports.withIdentityLock(\"key\", async () => id);\n    // @ts-expect-error Digest capture must occur synchronously before label serialization.\n    const digest: IdentityImagePorts = { ...ports, captureLabelsDigest: async () => ports.captureLabelsDigest() };\n    // @ts-expect-error A captured digest must produce the hash synchronously.\n    const digestResult: IdentityImagePorts = { ...ports, captureLabelsDigest: () => async () => \"hash\" };\n    // @ts-expect-error Inspection is synchronous and observes the original image.\n    const inspect: IdentityImagePorts = { ...ports, inspectImage: async () => image };\n    // @ts-expect-error The account probe retains the lazy inspected observation.\n    ports.observeAccount(\"image-id\");\n    // @ts-expect-error Mutation cleanup is required, not optional.\n    prepareIdentityImage(id, inward, { captureLabelsDigest: ports.captureLabelsDigest });\n    void [tag, build, removal, lock, inspect, digest, digestResult];\n    return id;\n}\ntype Raw = { kind: \"raw\"; failed: boolean };\ntype Presented = { kind: \"presented\"; shown: string };\ntype Content = { kind: \"native\"; id: string };\ntype Reply = { content: Content[]; summary: FlowValue };\ntype Ports = DeviceFlowPorts<Raw, Presented, Content, Reply, { admitted: boolean }>;\n\nfunction requiredSemanticPorts(ports: Ports, raw: Raw, presented: Presented) {\n    const { withBrokerOperation: missingScope, ...incomplete } = ports; void missingScope;\n    // @ts-expect-error A fresh scope effect is required; there is no ambient default.\n    const missing: Ports = incomplete;\n    const asynchronousValidation: Ports = { ...ports,\n        // @ts-expect-error Validation stays synchronous and before dispatch.\n        toolInputError: async () => null,\n    };\n    const wrongDispatch: Ports = { ...ports,\n        // @ts-expect-error Dispatch produces raw provider results, not presentation.\n        dispatchTool: async () => presented,\n    };\n    // @ts-expect-error Action rendering must receive raw observations.\n    ports.actionResult(\"click\", \"device_click\", presented, { detail: undefined });\n    // @ts-expect-error Aggregate renderer accepts a flow outcome, not raw observations.\n    ports.renderFlow(raw, { toolName: \"device_run_flow\", detail: false });\n    // @ts-expect-error The scope callback yields the raw dispatch result.\n    ports.withBrokerOperation(async () => presented);\n    // @ts-expect-error Native content is not the raw provider envelope.\n    ports.summarizeToolResult(\"device_click\", raw, [raw]);\n    void [missing, asynchronousValidation, wrongDispatch];\n}\nvoid requiredSemanticPorts;\n\ndeclare const identityPorts: IdentityImagePorts;\ndeclare const publicIdentity: PublicIdentity;\nconst publicArgs: Parameters<typeof ensureIdentityImage> = [\"image\",publicIdentity];\nconst publicReturn: string = ensureIdentityImage(...publicArgs);\nconst defaultIdentity: PublicIdentity = resolveContainerIdentity();\nconst currentIdentity: string = prepareIdentityImage(\"image\",defaultIdentity,identityPorts);\ndeclare const flowPorts: Ports;\nconst currentFlow: Promise<Reply> = runDeviceFlow({steps:[{tool:\"click\"}],stopOnError:false},{toolName:\"run_flow\",toolAllowed:()=>true},flowPorts);\nconst policy = evaluateDestructivePolicy(\"device_delete\",{confirmDestructive:true});\n// @ts-expect-error Complete operation ports remain required.\nrunDeviceFlow({steps:[]},{toolName:\"run_flow\",toolAllowed:()=>true});\nvoid [publicReturn,currentIdentity,currentFlow,policy];\n");
    try {
        run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--skipLibCheck','false',
            '--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--typeRoots',join(root,'node_modules/@types'),waveContract]);
    } finally { rmSync(waveContract); }
    console.log('PASS provider/runtime wave: payload-only identity eight frozen native witnesses; provider exports and strict synchronous declarations; ordered core flow success/raw failure/native content');
    const codexStateHome = mkdtempSync(join(temporary, "reviewed-codex-state-home-"));
    const codexStateResult = spawnSync(process.execPath, ["--input-type=module", "-e",
        `await (${verifyReviewedCodexStateDelivery.toString()})(${JSON.stringify(packageRoot)});`], {
        cwd: codexStateHome, env: { ...env, HOME: codexStateHome, USERPROFILE: codexStateHome },
        encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(codexStateResult.status, 0, String(codexStateResult.error || codexStateResult.stderr || codexStateResult.stdout).slice(-4000));
    const labHome = mkdtempSync(join(temporary, "reviewed-lab-home-"));
    const labResult = spawnSync(process.execPath, ["--input-type=module", "-e",
        `await (${verifyReviewedLabStateDelivery.toString()})(${JSON.stringify(packageRoot)},${JSON.stringify(LAB_STATE_DELIVERY_BASELINE)});`], {
        cwd: labHome, env: { ...env, HOME: labHome, USERPROFILE: labHome },
        encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(labResult.status, 0, String(labResult.error || labResult.stderr || labResult.stdout).slice(-4000));
    const sandboxHome = mkdtempSync(join(temporary, "reviewed-sandbox-home-"));
    const sandboxResult = spawnSync(process.execPath, ["--input-type=module", "-e",
        `await (${verifyReviewedSandboxDelivery.toString()})(${JSON.stringify(packageRoot)});`], {
        cwd: sandboxHome, env: { ...env, HOME: sandboxHome, USERPROFILE: sandboxHome },
        encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(sandboxResult.status, 0, String(sandboxResult.error || sandboxResult.stderr || sandboxResult.stdout).slice(-4000));
    const directProof = sandboxResult.stdout.split("\n").filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).find(row=>row.consumer==="sandbox-direct-create" && row.result==="PASS");
    record("sandbox-direct-create", "compiled-public/native-helper", directProof);
    const brokerHome = mkdtempSync(join(temporary, "reviewed-broker-home-"));
    const brokerResult = spawnSync(process.execPath, ["--input-type=module", "-e",
        `await (${verifyReviewedBrokerDelivery.toString()})(${JSON.stringify(packageRoot)},${JSON.stringify(brokerHome)});`], {
        cwd: brokerHome, env: { ...env, HOME: brokerHome, USERPROFILE: brokerHome },
        encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(brokerResult.status, 0, String(brokerResult.error || brokerResult.stderr || brokerResult.stdout).slice(-4000));
    const brokerProof = brokerResult.stdout.split("\n").filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).find(row=>row.consumer==="sandbox-authenticated-create" && row.result==="PASS");
    record("sandbox-authenticated-create", "compiled-RPC/compensation/native-writer", brokerProof);
    const stateHome = mkdtempSync(join(temporary, "state-access-shipping-"));
    const stateProof = shippingWaveConsumer(verifyReviewedStateAccessDelivery, packageRoot, stateHome, stateFrozenRowHashes);
    record("state-TS", "compiled-facade/native/golden", stateProof.ts);
    record("state-shared", "compiled-facade/native/golden", stateProof.shared);
    const runtimeHome = mkdtempSync(join(temporary, "runtime-capabilities-shipping-"));
    const runtimeProof = shippingWaveConsumer(verifyRuntimeCapabilitiesDelivery, packageRoot, runtimeHome, runtimeFrozenRowHashes);
    record("runtime55", "compiled-public/core/native-golden", runtimeProof.executed);
    const mcpHome = mkdtempSync(join(temporary, "mcp-forward-shipping-"));
    const mcpProof = shippingWaveConsumer(mcpPayloadConsumer, packageRoot, mcpHome);
    assert.equal(mcpProof.parserCases, 4); assert.equal(mcpProof.writerCases, 4); assert.equal(mcpProof.cliCases, 8);
    record("MCP-parser4", "compiled-public/builtin-callee-order", mcpProof.parserCases);
    record("MCP-writer4", "compiled-public/builtin-publication-order", mcpProof.writerCases);
    record("MCP-launcher8", "payload-mapped-emitted-main/public/core/native-lock", mcpProof.cliCases);
    const requiredConsumers = ["sandbox-direct-create", "sandbox-authenticated-create", "state-TS", "state-shared", "runtime55", "MCP-parser4", "MCP-writer4", "MCP-launcher8"];
    const missing = requiredConsumers.filter(name=>!coverage.some(row=>row.consumer===name && row.result==="PASS"));
    assert.deepEqual(missing, []); assert.equal(coverage.length, 8);
    console.log(JSON.stringify({ payload:relative(temporary, packageRoot), executedConsumerLedger:coverage, missing }));
    const toolSessionHome = mkdtempSync(join(temporary, "reviewed-tool-session-home-"));
    const toolSessionResult = spawnSync(process.execPath, ["--input-type=module", "-e",
        `await (${verifyReviewedToolSessionDelivery.toString()})(${JSON.stringify(packageRoot)});`], {
        cwd: toolSessionHome, env: { ...env, HOME: toolSessionHome, USERPROFILE: toolSessionHome },
        encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(toolSessionResult.status, 0, String(toolSessionResult.error || toolSessionResult.stderr || toolSessionResult.stdout).slice(-4000));
    const workspaceHome = mkdtempSync(join(temporary, "reviewed-workspace-home-"));
    const workspaceResult = spawnSync(process.execPath, ["--input-type=module", "-e",
        `await (${verifyReviewedWorkspaceDelivery.toString()})(${JSON.stringify(packageRoot)},${JSON.stringify(join(workspaceHome, "git-fixtures"))});`], {
        cwd: workspaceHome, env: { ...env, HOME: workspaceHome, USERPROFILE: workspaceHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(workspaceHome, "gitconfig") },
        encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(workspaceResult.status, 0, String(workspaceResult.error || workspaceResult.stderr || workspaceResult.stdout).slice(-4000));
    const clipboardFiles = ["clipboard-server.js", "domain/clipboard/snapshot.js", "domain/clipboard/text-write.js",
        "domain/clipboard/server-lifecycle.js", "application/clipboard/snapshot.js",
        "application/clipboard/text-write.js", "application/clipboard/server-lifecycle.js"];
    function clipboardConsumer(payload, mode, failingFile = "") {
        const home = mkdtempSync(join(temporary, "clipboard-delivery-home-"));
        const result = spawnSync(process.execPath, ["--input-type=module", "-e",
            `await (${verifyClipboardBridgeDelivery.toString()})(...${JSON.stringify([payload, home, mode, failingFile])});`], {
            cwd: home, env: { ...env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home },
            encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
        });
        assert.equal(result.status, 0, String(result.error || result.stderr || result.stdout).slice(-4000));
        return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    }
    const originalClipboard = clipboardConsumer(packageRoot, "operations");
    for (const file of clipboardFiles) {
        const copy = mkdtempSync(join(temporary, "clipboard-policy-copy-"));
        try {
            cpSync(join(packageRoot, "dist"), join(copy, "dist"), { recursive: true });
            writeFileSync(join(copy, "package.json"), '{"type":"module"}');
            const target = join(copy, "dist", file);
            writeFileSync(target, readFileSync(target, "utf8") + "\n// isolated pre-import fingerprint mutation\n");
            assert.notEqual(clipboardConsumer(copy, "hash").version, originalClipboard.version, `fingerprint omitted ${file}`);
            assert.equal(clipboardConsumer(copy, "hash-read-failure", file).version, "unknown");
            rmSync(target);
            const absent = spawnSync(process.execPath, [join(copy, "dist/clipboard-server.js"), "--serve"], {
                cwd: copy, env, encoding: "utf8", timeout: 10000, windowsHide: true,
            });
            assert.equal(absent.status, 1, `missing static policy ${file} must refuse startup`);
            assert.match(absent.stderr, /(?:ERR_)?MODULE_NOT_FOUND/);
        } finally { rmSync(copy, { recursive: true, force: true }); }
    }
    const capturedCopy = mkdtempSync(join(temporary, "clipboard-import-capture-"));
    try {
        cpSync(join(packageRoot, "dist"), join(capturedCopy, "dist"), { recursive: true });
        writeFileSync(join(capturedCopy, "package.json"), '{"type":"module"}');
        assert.equal(clipboardConsumer(capturedCopy, "capture").version, originalClipboard.version);
    } finally { rmSync(capturedCopy, { recursive: true, force: true }); }
    const providerRoot = join(packageRoot, "dist/packages/device-lab/providers");
    const sandboxDeclarations = join(packageRoot, "reviewed-sandbox-declarations");
    run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--allowJs", "--checkJs", "--strict",
        "--skipLibCheck", "false", "--declaration", "--emitDeclarationOnly", "--module", "NodeNext", "--target", "ES2022",
        "--typeRoots", join(root, "node_modules/@types"), "--rootDir", providerRoot, "--outDir", sandboxDeclarations,
        ...["domain", "ports", "application"].flatMap(layer => ["windows-sandbox-stop", "windows-sandbox-create"].map(name => join(providerRoot, layer, `lifecycle/${name}.mjs`))),
        join(providerRoot, "state/state-file.mjs"), join(providerRoot, "adapters/state/state-file.mjs")]);
    const contracts = [...REVIEWED_WAVE_DECLARATION_CONSUMERS, ["sandbox-stop", REVIEWED_SANDBOX_DECLARATION_CONSUMER],
        ["runtime-capabilities", runtimeCapabilitiesDeclarationConsumer], ["state-access", stateAccessDeclarationConsumer],
        ["mcp-forward", mcpStrictConsumer("./dist")], ["sandbox-create", SANDBOX_CREATE_DECLARATION_CONSUMER]].map(([name, text]) => {
        const file = join(packageRoot, `reviewed-wave-${name}-consumer.mts`);
        writeFileSync(file, text);
        return file;
    });
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
            "--skipLibCheck", "false", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
            "--typeRoots", join(root, "node_modules/@types"), ...contracts]);
    } finally { for (const file of contracts) rmSync(file); rmSync(sandboxDeclarations, { recursive: true, force: true }); }
    console.log("PASS reviewed wave current strict declarations and clipboard compiled public/native/auth lifecycle, seven-file framed fingerprint, read refusal and static startup failure");
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
    const migrationUrl = pathToFileURL(join(packageRoot, "dist/application/home-layout-migration.js")).href;
    run(process.execPath, ["--input-type=module", "-e", `await (${verifyHomeMigrationDelivery.toString()})(${JSON.stringify(migrationUrl)}, ${JSON.stringify(homeLayout)});`]);
    const migrationContract = join(packageRoot, "home-layout-migration-consumer.mts");
    writeFileSync(migrationContract, [
        'import { createHomeLayoutMigration } from "./dist/application/home-layout-migration.js";',
        'import type { HomeLayoutMigrationPorts } from "./dist/ports/home-layout-migration.js";',
        'import { migrateHomeLayout, type HomeLayoutMigrationOptions, type HomeLayoutMigrationResult } from "./dist/home-layout.js";',
        'declare const ports: HomeLayoutMigrationPorts<symbol>;',
        'const result: HomeLayoutMigrationResult = createHomeLayoutMigration(ports)();',
        'const facade: (options:HomeLayoutMigrationOptions)=>HomeLayoutMigrationResult = migrateHomeLayout;',
        'const legacy: HomeLayoutMigrationOptions = {hasLiveSessions:()=>false,warn:async()=>{},retireLegacyClipboard:()=>{}};',
        'if(result.status==="migrated") {result.moved.push("mutable");result.failed=[];}',
        '// @ts-expect-error All semantic ports are required.',
        'createHomeLayoutMigration({});',
        '// @ts-expect-error Ports are readonly.',
        'ports.homeExists=()=>true;',
        '// @ts-expect-error New effect contracts reject async implementations.',
        'const asyncPorts: HomeLayoutMigrationPorts<symbol> = {...ports,moveEntry:async()=>undefined};',
        '// @ts-expect-error Config publication mutation is synchronous.',
        'ports.updateConfig(async()=>undefined);',
        '// @ts-expect-error Result remains synchronous.',
        'const asynchronous: Promise<unknown> = result;',
        'void [facade,legacy,asyncPorts,asynchronous];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", migrationContract]);
    } finally { rmSync(migrationContract); }
    console.log("PASS home migration distribution: compiled JSON/claim/finally policy, actual native one-way migration/retained bytes/inodes and synchronous legacy declaration consumers");
    const homePolicyUrls=["application/home/layout-paths","application/home/config","home-layout"].map(name=>pathToFileURL(join(packageRoot,`dist/${name}.js`)).href);
    run(process.execPath,["--input-type=module","-e",`await (${verifyHomeResolutionConfigDelivery.toString()})(...${JSON.stringify(homePolicyUrls)});`]);
    const homePolicyContract=join(packageRoot,"home-resolution-config-consumer.mts");
    writeFileSync(homePolicyContract,[
        'import {createHomeLayoutPaths} from "./dist/application/home/layout-paths.js";',
        'import {createCccConfig} from "./dist/application/home/config.js";',
        'import type {HomePathPorts} from "./dist/ports/home/layout-paths.js";',
        'import type {CccConfigPorts} from "./dist/ports/home/config.js";',
        'import {ensureDefaultProfileDir,updateCccConfig,profileCodexDir} from "./dist/home-layout.js";',
        'declare const paths:HomePathPorts;declare const config:CccConfigPorts;',
        'const home=createHomeLayoutPaths(paths,"default",".ccc-default-profile",["claude","claude.json","codex"]);',
        'const named:string=home.profileCodexDir("work");const marker:undefined=home.ensureDefaultProfileDir();',
        'const changed:undefined=createCccConfig(config).update(async()=>{});',
        'const legacy:()=>void=ensureDefaultProfileDir;const update:(mutate:(value:Record<string,unknown>)=>void)=>void=updateCccConfig;',
        'const profile:(profile?:string)=>string=profileCodexDir;',
        '// @ts-expect-error All path capabilities required.',
        'createHomeLayoutPaths({},"default","marker",[]);',
        '// @ts-expect-error All config capabilities required.',
        'createCccConfig({});',
        '// @ts-expect-error Port readonly.',
        'config.processId=()=>2;',
        '// @ts-expect-error New effects synchronous.',
        'const asyncWrite:CccConfigPorts["writeText"]=async()=>undefined;',
        'config.writeText("path",undefined,{mode:384});void[named,marker,changed,legacy,update,profile,asyncWrite];',
    ].join("\n"));
    try{run(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"--noEmit","--strict","--skipLibCheck","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext",homePolicyContract]);}
    finally{rmSync(homePolicyContract);}
    console.log("PASS home resolution/config distribution: compiled provenance/marker/ordered config policy, actual private native facade bytes/modes/malformed preservation/partial rename state and emitted contracts");
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
        '// @ts-expect-error Numeric registration tokens can be falsy and are not supported.',
        'type NumericRegistration = MultiCreationPorts<object,number,object,object>;',
        '// @ts-expect-error Boolean copied identities can be falsy and are not supported.',
        'type BooleanCopied = MultiCreationPorts<object,object,object,boolean>;',
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
    const removalUrl = pathToFileURL(join(packageRoot, "dist/application/workspace/multi-removal.js")).href;
    run(process.execPath, ["--input-type=module", "-e", `await (${verifyMultiRemovalDelivery.toString()})(${JSON.stringify(removalUrl)});`]);
    const removalContract = join(packageRoot, "multi-removal-consumer.mts");
    writeFileSync(removalContract, [
        'import { createMultiWorkspaceRemoval } from "./dist/application/workspace/multi-removal.js";',
        'import type { MultiRemovalPorts, MultiRemovalRequest } from "./dist/ports/workspace/multi-removal.js";',
        'import { removeWorkspace, type RemoveResult } from "./dist/worktree.js";',
        'import type { RemoveResult as DomainResult } from "./dist/domain/workspace/removal-result.js";',
        'type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;',
        'declare const ports: MultiRemovalPorts<{w:"workspace"},{e:"entry"},{r:"registration"}>;',
        'declare const request: MultiRemovalRequest;',
        'const result: RemoveResult = createMultiWorkspaceRemoval(ports)(request, {w:"workspace"});',
        'result.removed.push("mutable"); result.errors = ["mutable"];',
        'const same: Equal<RemoveResult,DomainResult> = true;',
        'const facade: (source:string,branch:string,opts?:{force?:boolean})=>RemoveResult = removeWorkspace;',
        '// @ts-expect-error Every semantic port is required.',
        'createMultiWorkspaceRemoval({});',
        '// @ts-expect-error Ports are readonly.',
        'ports.pathExists = () => true;',
        '// @ts-expect-error The original options object, including undefined, is explicit.',
        'const missing: MultiRemovalRequest = {repositoryPath:"source",destinationPath:"workspace",branch:"topic"};',
        '// @ts-expect-error Removal remains synchronous.',
        'const asynchronous: Promise<unknown> = result;',
        'void [same,facade,missing,asynchronous];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", removalContract]);
    } finally { rmSync(removalContract); }
    console.log("PASS multi removal distribution: compiled opaque/refusal/error policy, actual multi Git/copy removal and preserved source refs/config/files, mutable legacy declarations");
    const unifiedRemovalUrl = pathToFileURL(join(packageRoot, "dist/application/workspace/unified-removal.js")).href;
    const workspaceFacadeUrl = pathToFileURL(join(packageRoot, "dist/worktree.js")).href;
    run(process.execPath, ["--input-type=module", "-e", `await (${verifyUnifiedRemovalDelivery.toString()})(${JSON.stringify(unifiedRemovalUrl)}, ${JSON.stringify(workspaceFacadeUrl)});`]);
    const unifiedRemovalContract = join(packageRoot, "unified-removal-consumer.mts");
    writeFileSync(unifiedRemovalContract, [
        'import { createUnifiedWorkspaceRemoval } from "./dist/application/workspace/unified-removal.js";',
        'import type { UnifiedRemovalPorts, UnifiedRemovalRequest } from "./dist/ports/workspace/unified-removal.js";',
        'import { removeWorkspace, type RemoveResult } from "./dist/worktree.js";',
        'declare const ports: UnifiedRemovalPorts<{d:"directory"},symbol,{f:"fence"},{r:"registration"},{q:"quarantine"}>;',
        'declare const request: UnifiedRemovalRequest;',
        'const result: RemoveResult = createUnifiedWorkspaceRemoval(ports)(request, {d:"directory"});',
        'result.removed.push("mutable"); result.errors = ["mutable"];',
        'const facade: (source:string,branch:string,opts?:{force?:boolean})=>RemoveResult = removeWorkspace;',
        '// @ts-expect-error Every semantic port is required.',
        'createUnifiedWorkspaceRemoval({});',
        '// @ts-expect-error Source proofs must support truthy identity lookup.',
        'type InvalidSource = UnifiedRemovalPorts<object,number,object,object,object>;',
        '// @ts-expect-error Ports are readonly.',
        'ports.pathExists = () => true;',
        '// @ts-expect-error Observations remain synchronous.',
        'const asyncObservation: UnifiedRemovalPorts<object,symbol,object,object,object>["inspectRootStatus"] = async () => ({kind:"observed",readContent:()=>""});',
        '// @ts-expect-error Opaque directory proof cannot be replaced.',
        'createUnifiedWorkspaceRemoval(ports)(request, {d:"other"});',
        '// @ts-expect-error Removal result remains synchronous.',
        'const asynchronous: Promise<unknown> = result;',
        'void [facade,asyncObservation,asynchronous];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", unifiedRemovalContract]);
    } finally { rmSync(unifiedRemovalContract); }
    console.log("PASS unified removal distribution: compiled opaque quarantine veto, actual nested native removal with preserved source refs/config/files, required readonly synchronous declarations");
    const scannerUrls = ["domain/tooling/version-files", "application/tooling/version-file-scanning", "presentation/tool-version-context", "scanner"]
        .map(name => pathToFileURL(join(packageRoot, `dist/${name}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e", `await (${verifyVersionFileScanningDelivery.toString()})(${scannerUrls.map(value => JSON.stringify(value)).join(",")});`]);
    const scannerContract = join(packageRoot, "version-scanning-consumer.mts");
    writeFileSync(scannerContract, [
        'import { matchesPattern, scanVersionFiles, extractVersionHints, formatScannedFiles, formatVersionHints, type VersionHint } from "./dist/scanner.js";',
        'import { createVersionFileScanner } from "./dist/application/tooling/version-file-scanning.js";',
        'import type { VersionFileScanningPorts, VersionFileScanRequest } from "./dist/ports/tooling/version-file-scanning.js";',
        'declare const ports: VersionFileScanningPorts; declare const request: VersionFileScanRequest;',
        'const legacy: (base:string,dir?:string,depth?:number,maxDepth?:number)=>Map<string,string> = scanVersionFiles;',
        'const result = createVersionFileScanner(ports,new Set<string>())(request); result.set("x","22");',
        'const hints: VersionHint[] = extractVersionHints(result); hints.push({tool:"node",version:"22",source:"x"}); hints[0].version="23";',
        'const texts: string[] = [formatScannedFiles(result),formatVersionHints(hints)]; const matched:boolean = matchesPattern("package.json");',
        '// @ts-expect-error All five observations are required.',
        'createVersionFileScanner({},new Set());',
        '// @ts-expect-error Ignore input has no hidden default.',
        'createVersionFileScanner(ports);',
        '// @ts-expect-error Ports are readonly.',
        'ports.childPath = () => "changed";',
        '// @ts-expect-error Observations remain synchronous.',
        'const asyncRead: VersionFileScanningPorts["readVersionFileText"] = async () => "text";',
        '// @ts-expect-error Scanning remains synchronous.',
        'const asyncResult: Promise<unknown> = result;',
        'void [legacy,texts,matched,asyncRead,asyncResult];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", scannerContract]);
    } finally { rmSync(scannerContract); }
    console.log("PASS version scanner distribution: compiled ordered core, parser/context bytes, actual native byte/depth boundaries and named-read subprocess fault, readonly synchronous legacy declarations");
    const credentialUrls = ["application/credentials/host-refresh", "adapters/credentials/host-refresh", "adapters/credentials/ssh-material", "docker", "ssh-known-hosts"]
        .map(name => pathToFileURL(join(packageRoot, `dist/${name}.js`)).href);
    const credentialBaseline = HOST_CREDENTIAL_ASSET_BASELINE;
    const assetProof = { hashes: credentialBaseline.hashes, names: credentialBaseline.names, arities: credentialBaseline.arities };
    run(process.execPath, ["--input-type=module", "-e", `await (${verifyHostCredentialRefreshDelivery.toString()})(${credentialUrls.map(value => JSON.stringify(value)).join(",")},${JSON.stringify(assetProof)});`]);
    const credentialContract = join(packageRoot, "host-credential-refresh-consumer.mts");
    writeFileSync(credentialContract, [
        'import {createHostCredentialRefresh} from "./dist/application/credentials/host-refresh.js";',
        'import {createNativeHostCredentialRefreshPorts} from "./dist/adapters/credentials/host-refresh.js";',
        'import type {HostCredentialRefreshPorts,CredentialCommandObservation} from "./dist/ports/credentials/host-refresh.js";',
        'import {sshCredentialCopyShell,gitSigningKeyRewriteShell} from "./dist/docker.js";',
        'declare const ports:HostCredentialRefreshPorts; declare const observed:CredentialCommandObservation;',
        'const app=createHostCredentialRefresh(ports); const ssh:undefined=app.refreshSsh("target"); const git:undefined=app.syncGit("target");',
        'const native:HostCredentialRefreshPorts=createNativeHostCredentialRefreshPorts(()=>"podman");',
        'const assets:string[]=[sshCredentialCopyShell(),sshCredentialCopyShell(true),gitSigningKeyRewriteShell()];',
        '// @ts-expect-error All observations/reports are required.',
        'createHostCredentialRefresh({});',
        '// @ts-expect-error Reports are synchronous undefined, not async.',
        'const report:HostCredentialRefreshPorts["reportGitCopyFailure"]=async()=>undefined;',
        '// @ts-expect-error Observations are readonly.',
        'observed.status=0;',
        '// @ts-expect-error Runtime selection has no hidden default.',
        'createNativeHostCredentialRefreshPorts();',
        '// @ts-expect-error Operations remain synchronous.',
        'const pending:Promise<unknown>=git;',
        'void[ssh,git,native,assets,report,pending];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", credentialContract]);
    } finally { rmSync(credentialContract); }
    console.log("PASS host credential distribution: compiled core/native status and capture policy, independent baseline asset hashes/public canonical exports; actual verified-ID lifecycle wrappers exercised separately");
    const hostPathUrls = ["application/credentials/host-paths", "docker"].map(name => pathToFileURL(join(packageRoot, `dist/${name}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e", `await (${verifyHostCredentialPathsDelivery.toString()})(${hostPathUrls.map(value => JSON.stringify(value)).join(",")});`]);
    const hostPathContract = join(packageRoot, "host-credential-paths-consumer.mts");
    writeFileSync(hostPathContract, [
        'import {createHostCredentialPaths} from "./dist/application/credentials/host-paths.js";',
        'import type {HostCredentialPathPorts} from "./dist/ports/credentials/host-paths.js";',
        'import type {CredentialMount} from "./dist/domain/tool-registry.js";',
        'import {resolveCredentialHostPath,ensureCredentialHostDir} from "./dist/docker.js";',
        'declare const ports:HostCredentialPathPorts; declare const mount:CredentialMount;',
        'const app=createHostCredentialPaths(ports,"/home/ccc/.codex/packages");',
        'const values:string[]=[app.resolveCredentialHostPath(mount),app.ensureCredentialHostDir(mount,"work")];',
        'const legacy:(mount:CredentialMount,profile?:string)=>string=resolveCredentialHostPath;',
        'const prepare:typeof legacy=ensureCredentialHostDir; mount.hostDir="changed";',
        '// @ts-expect-error No package path default.',
        'createHostCredentialPaths(ports);',
        '// @ts-expect-error Every observation/effect is required.',
        'createHostCredentialPaths({},"path");',
        '// @ts-expect-error Ports readonly.',
        'ports.homeDirectory=()=>"changed";',
        '// @ts-expect-error Directory effects synchronous undefined.',
        'const asyncMkdir:HostCredentialPathPorts["createDirectory"]=async()=>undefined;',
        'void[values,legacy,prepare,asyncMkdir];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
            "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", hostPathContract]);
    } finally { rmSync(hostPathContract); }
    console.log("PASS host credential paths distribution: compiled ordered/partial policy, actual private native profiles/directories/modes/live env helpers and mutable legacy declarations");
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
    assert.match(readFileSync(join(packageRoot, "dist/docker.js"), "utf8"), /import \{ createOrderedCodexConfigPreparation \} from ["']\.\/application\/credentials\/codex-config-preparation\.js["'];/);
    assert.match(readFileSync(join(packageRoot,"dist/application/credentials/codex-config-preparation.js"),"utf8"), /import \{ createCodexConfigPreparation \} from ["']\.\.\/codex-config-preparation\.js["'];/);
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
    console.log("PASS guardian distribution: payload-only light startup closure, public synchronous/guardian asynchronous declarations, awaited cleanup success/rejection and duplicate terminal effects");
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
    const installationSource=readFileSync(join(root,"src/container-setup.ts"),"utf8").replace(/\r\n/g,"\n");
    const installationTree=ts.createSourceFile("container-setup.ts",installationSource,ts.ScriptTarget.Latest,true);
    const foundInstallationAssets={};
    for(const declaration of installationTree.statements)if(ts.isFunctionDeclaration(declaration)&&declaration.name&&Object.hasOwn(CONTAINER_INSTALLATION_BASELINE.assetHashes,declaration.name.text)){
        foundInstallationAssets[declaration.name.text]=createHash("sha256").update(declaration.getFullText(installationTree)).digest("hex");
    }
    assert.deepEqual(foundInstallationAssets,CONTAINER_INSTALLATION_BASELINE.assetHashes,"unchanged native asset/report source bodies");
    const installationUrls=["application/tooling/container-installation","container-setup","tool-registry","container-runtime"].map(name=>pathToFileURL(join(packageRoot,`dist/${name}.js`)).href);
    run(process.execPath,["--input-type=module","-e",`await (${verifyContainerInstallationDelivery.toString()})(...${JSON.stringify(installationUrls)},${JSON.stringify(CONTAINER_INSTALLATION_BASELINE.cases)});`]);
    const installationContract=join(packageRoot,"container-installation-consumer.mts");
    writeFileSync(installationContract,[
        'import {createContainerToolInstallation} from "./dist/application/tooling/container-installation.js";',
        'import type {ContainerToolInstallationPorts} from "./dist/ports/tooling/container-installation.js";',
        'import {ensureClaudeInContainer,ensureUvAvailable} from "./dist/container-setup.js";',
        'declare const ports:ContainerToolInstallationPorts<symbol>;const app=createContainerToolInstallation(ports);',
        'const effect:undefined=app.ensureClaude("target");const legacy:(target:string)=>void=ensureClaudeInContainer;',
        '// @ts-expect-error Capabilities required.',
        'createContainerToolInstallation({});',
        '// @ts-expect-error Capture synchronous.',
        'const invalid:ContainerToolInstallationPorts<symbol>["captureUvProbe"]=async()=>()=>({status:0});',
        '// @ts-expect-error Readonly capability.',
        'ports.getNpmTools=()=>[];',
        '// @ts-expect-error Core undefined differs from historical void.',
        'const strict:undefined=ensureUvAvailable("target");',
        'void[effect,legacy,invalid,strict];',
    ].join("\n"));
    try{run(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"--noEmit","--strict","--skipLibCheck","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext",installationContract]);}finally{rmSync(installationContract);}
    console.log("PASS container installation distribution: four complete policies, ten old native golden scenarios/31commands and original output, eight asset bodies and strict emitted contracts");
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
    const codexConfigUrls = ["application/codex-config-preparation", "ports/codex-config-preparation", "docker", "container-runtime", "application/credentials/codex-config-preparation"]
        .map(path => pathToFileURL(join(packageRoot, `dist/${path}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `const createOwnedImportRead = ${createOwnedImportRead.toString()}; await (${verifyCodexConfigPreparation.toString()})(...${JSON.stringify(codexConfigUrls)});`]);
    console.log("PASS Codex config distribution: compiled core and actual public facade, strict declarations, commands and observation parity");
    const orderedContract=join(packageRoot,"ordered-codex-config-consumer.mts");
    writeFileSync(orderedContract,[
        'import {createOrderedCodexConfigPreparation} from "./dist/application/credentials/codex-config-preparation.js";',
        'import type {CodexPreparationPorts} from "./dist/ports/credentials/codex-config-preparation.js";',
        'import {prepareCodexConfigForContainer} from "./dist/docker.js";',
        'declare const ports:CodexPreparationPorts;',
        'const result:undefined=createOrderedCodexConfigPreparation(ports).prepare("target","work");',
        'const legacy:(target:string,profile?:string)=>void=prepareCodexConfigForContainer;',
        '// @ts-expect-error Every capability is required.',
        'createOrderedCodexConfigPreparation({});',
        '// @ts-expect-error Capabilities are readonly.',
        'ports.currentHostUid=()=>1;',
        '// @ts-expect-error Native stages synchronous.',
        'const pending:CodexPreparationPorts["probeDirectory"]=async()=>({status:0});',
        'void[result,legacy,pending];',
    ].join("\n"));
    try {
        run(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"--noEmit","--strict","--skipLibCheck",
            "--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext",orderedContract]);
    } finally { rmSync(orderedContract); }
    console.log("PASS ordered Codex preparation distribution: compiled complete outer directory/file order, per-call UID reuse/freshness/negative eligibility, actual native facade retained, emitted synchronous readonly contracts");
    const hostAccessUrls = ["application/credentials/codex-host-access", "docker", "container-runtime"]
        .map(name => pathToFileURL(join(packageRoot, `dist/${name}.js`)).href);
    run(process.execPath, ["--input-type=module", "-e",
        `const createOwnedImportRead = ${createOwnedImportRead.toString()}; await (${verifyCodexHostAccessDelivery.toString()})(...${JSON.stringify(hostAccessUrls)});`]);
    const hostAccessContract = join(packageRoot, "codex-host-access-consumer.mts");
    writeFileSync(hostAccessContract, [
        'import {createCodexHostAccessRestoration} from "./dist/application/credentials/codex-host-access.js";',
        'import type {CodexHostAccessPorts} from "./dist/ports/credentials/codex-host-access.js";',
        'import {restoreCodexConfigHostOwnership} from "./dist/docker.js";',
        'declare const ports:CodexHostAccessPorts;',
        'const value:undefined=createCodexHostAccessRestoration(ports).restore("target","work");',
        'const legacy:(target:string,profile?:string)=>void=restoreCodexConfigHostOwnership;',
        '// @ts-expect-error All capabilities required.',
        'createCodexHostAccessRestoration({});',
        '// @ts-expect-error Capabilities readonly.',
        'ports.currentHostUid=()=>1;',
        '// @ts-expect-error Access is synchronous.',
        'const asyncAccess:CodexHostAccessPorts["accessConfig"]=async()=>undefined;',
        'void[value,legacy,asyncAccess];',
    ].join("\n"));
    try {
        run(process.execPath, [join(root,"node_modules/typescript/bin/tsc"),"--noEmit","--strict","--skipLibCheck",
            "--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext",hostAccessContract]);
    } finally { rmSync(hostAccessContract); }
    console.log("PASS Codex host access distribution: actual compiled facade healthy/repair/failure/recheck, runtime pinning and synchronous readonly declarations");
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
