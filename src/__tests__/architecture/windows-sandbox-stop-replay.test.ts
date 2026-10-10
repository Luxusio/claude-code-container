import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createWindowsSandboxStop } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-stop.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const path = "packages/device-lab/providers/backends/windows-sandbox.mjs";
const baselineCommit = "c284ead3a637d4d31ca93661920ee0f0200b9077";
const baselineResult = spawnSync("git", ["show", `${baselineCommit}:${path}`], { cwd: root, encoding: "utf8", timeout: 10000 });
if (baselineResult.status !== 0) throw new Error(`Cannot read actual Sandbox baseline: ${baselineResult.stderr}`);
const baseline = baselineResult.stdout;
const candidate = readFileSync(resolve(root, path), "utf8");
const evidenceDirectory = process.env.CCC_SANDBOX_STOP_EVIDENCE_DIR;
function saveCapture(name: string, value: unknown) {
    if (!evidenceDirectory) return;
    if (resolve(evidenceDirectory) !== resolve(root, "doc/harness/checkpoints/recovery-evidence")) throw new Error("Replay capture must use this task's owned checkpoint directory");
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(join(evidenceDirectory, name), JSON.stringify(value, null, 2) + "\n");
}
function sourceFunction(source: string, name: string) {
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing actual source function ${name}`);
    return declaration.getText(tree).replace(/^export /, "");
}
function program(source: string) {
    const helpers = ["isGuid", "windowsLifecycleConflict", "claimWindowsLifecycle", "currentWindowsLifecycleDevice", "abortWindowsLifecycle", "bindWindowsLifecycleSingleton", "stopWindowsSandboxDevice", "cleanupWindowsSandboxMinimizeWatchdogs", "cancelWindowsMinimizeWatchdog", "handleWindowsTool"];
    if (source.includes("function windowsSandboxStopPorts(")) helpers.push("windowsSandboxStopPorts");
    const a = source.indexOf('        case "device_stop": {'); const b = source.indexOf('        case "device_exec": {', a);
    const executable = '"use strict";\nconst WINDOWS_SANDBOX_STOP_TIMEOUT_MS=60000;\n'
        + helpers.map(name => sourceFunction(source, name)).join("\n")
        + '\nasync function handleWindowsToolUnlocked(name,args){switch(name){\n' + source.slice(a, b) + '\ndefault:return undefined;}}\n'
        + '({handleWindowsTool,handleWindowsToolUnlocked,claimWindowsLifecycle,currentWindowsLifecycleDevice,abortWindowsLifecycle,bindWindowsLifecycleSingleton,stopWindowsSandboxDevice,cleanupWindowsSandboxMinimizeWatchdogs})';
    // VM globals translate throwing accessors into ReferenceError. Explicit
    // getter bindings preserve the imported callee lookup and detached receiver.
    return executable.replace(/\b(runWithTimeout|jsonResult|withTargetStatus)\b/g, "(0, bindings.$1)");
}
const programs = [program(baseline), program(candidate)];
const guid = "11111111-1111-4111-8111-111111111111";
type RecordValue = Record<string, unknown>;
function capture(value: unknown): unknown {
    if (value === undefined) return { undefined: true };
    if (typeof value === "symbol") return { symbol: value.description };
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.getOwnPropertyNames(value).sort().map(key => [key, capture((value as RecordValue)[key])]));
}
function execution(script: string, mode: string) {
    const trace: unknown[] = []; let findCount = 0, casCount = 0, tick = 0, alternateRun = false, alternateResponse = false;
    const original: RecordValue = { id: "sandbox", status: mode === "stopped-runtime" ? "stopped" : "running", ...(mode === "stopped-runtime" ? {} : { sandboxId: mode === "bind-guid" || mode === "runtime-guid" ? "invalid" : guid }), singletonClaimId: "old", recording: { active: true, runtimeId: "recording" }, minimizeWatchdogLaunch: { pid: 17 }, helperSessionLaunch: { ok: true, minimizeWatchdogPid: 17 }, retained: "CURRENT" };
    let current: RecordValue | undefined = mode === "missing" ? undefined : original;
    let singleton: RecordValue | null = mode === "bind-foreign" || mode === "bind-guid" || mode === "bind-cas" || mode === "bind-success" || mode === "cas-throw-bind" ? null : { claimId: "old", deviceId: "sandbox", sandboxId: guid };
    const fault = new Error(`fault:${mode}`);
    const rawTimeout = Object.assign(new Error("lock-timed-out"), { code: "shared-mutation-lock-timeout" });
    const opaqueTimeout = { code: "shared-mutation-lock-timeout", toString: () => "opaque-lock" };
    function failHere(name: string) { trace.push(["throw", name]); throw fault; }
    const globals: RecordValue = {
        createWindowsSandboxStop, Error, Buffer,
        Date: class extends Date { constructor() { super(0); trace.push("date:new"); if (mode === "clock-throw") failHere("clock"); } toISOString() { trace.push("date:iso"); return `2026-10-08T00:00:00.00${++tick}Z`; } },
        randomUUID: function(this: unknown) { trace.push(["id", this === undefined]); if (mode === "id-throw") failHere("id"); return "operation"; },
        findWindowsDevice: (id: string) => { trace.push(["find", ++findCount, id]); if (mode === "pre-lock-timeout" && findCount === 1) throw rawTimeout; if (mode === "lookup-throw" && findCount === 2) failHere("find"); if (mode === "locked-timeout" && findCount === 2) throw rawTimeout; if (mode === "locked-opaque-timeout" && findCount === 2) throw opaqueTimeout; return current; },
        transitionWindowsDevice: (id: string, expected: RecordValue, replacement: RecordValue) => {
            trace.push(["cas", ++casCount, id, capture(expected), capture(replacement)]);
            if (mode === "cas-throw-claim" && casCount === 1 || mode === "cas-throw-bind" && casCount === 2 || mode === "cas-throw-abort" && casCount === 2 || mode === "cas-throw-complete" && casCount === 2) failHere("cas");
            const matched = !(mode === "claim-conflict" && casCount === 1 || mode === "bind-cas" && casCount === 2 || mode === "complete-conflict" && casCount === 2);
            if (matched) current = replacement;
            return { found: true, matched, currentDevice: expected, device: matched ? replacement : null };
        },
        readWindowsSingletonLock: () => { trace.push("singleton:read"); if (mode === "singleton-throw") failHere("singleton"); return singleton; },
        sameWindowsSingletonOwner: (lock: RecordValue | null, item: RecordValue) => { trace.push("singleton:owner"); return lock?.deviceId === item.id; },
        claimWindowsSingleton: (item: RecordValue, sandboxId: string, claimId: string) => { trace.push(["singleton:claim", sandboxId, claimId]); if (mode === "bind-foreign") return { ok: false, error: "foreign" }; singleton = { claimId, sandboxId, deviceId: item.id }; return { ok: true, lock: singleton }; },
        releaseWindowsSingleton: (item: RecordValue, claimId: string) => { trace.push(["singleton:release", capture(item), claimId]); if (mode === "release-throw") failHere("release"); if (mode !== "release-false" && singleton?.claimId === claimId) singleton = null; return mode !== "release-false"; },
        windowsSingletonGenerationMatches: () => { trace.push("generation"); if (mode === "generation-throw") failHere("generation"); return mode !== "generation-refusal" && mode !== "cas-throw-abort"; },
        windowsHelperMetadata: function(this: unknown, item: RecordValue) { trace.push(["helper", this === undefined, item.id]); if (mode === "helper-throw") failHere("helper"); return { minimizeWatchdogCancelPath: "private/cancel" }; },
        mkdirSync: () => { trace.push("mkdir"); if (mode === "cancel-failure") throw new Error("denied"); },
        dirname: () => "private", writeFileSync: (cancelPath: string, timestamp: string, options: unknown) => { trace.push(["cancel", cancelPath, timestamp, options]); },
        windowsDiscovery: () => { trace.push("discovery"); if (mode === "discovery-throw") failHere("discovery"); return { get available() { trace.push("available:get"); return mode !== "discovery-missing"; }, get missing() { trace.push("missing:get"); return ["wsb"]; }, get wsb() { trace.push("wsb:get"); alternateRun = true; return "fixture-wsb"; } }; },
        requiresOwnerDeviceOperation: (backend: string, tool: string) => { trace.push(["policy", backend, tool]); return tool === "device_stop"; },
        withOwnerDeviceOperation: (backend: string, id: string, operation: () => unknown) => { trace.push(["lock", backend, id]); if (mode === "acquire-timeout") throw rawTimeout; if (mode === "acquire-other") failHere("acquire"); return operation(); },
        textResult: (ok: boolean, text: string) => { trace.push(["text", ok]); return { ok, text }; },
        fail: (evidence: unknown) => { trace.push(["fail", capture(evidence)]); return { failed: evidence }; },
    };
    Object.defineProperty(globals, "runWithTimeout", { configurable: true, get() {
        trace.push("run:get"); if (mode === "callee-throw") failHere("callee"); const selected = alternateRun;
        return function(this: unknown, command: string, args: string[], timeout: number) {
            trace.push(["run", this === undefined, selected, command, args, timeout]);
            if (mode === "native-throw") failHere("native");
            if (mode === "successor") { current = { ...current, lifecycle: { runtimeId: "successor" }, singletonClaimId: "successor", status: "running" }; singleton = { ...singleton, claimId: "successor" }; }
            return { get status() { trace.push("status:get"); if (mode === "status-throw") failHere("status"); return mode === "native-failure" ? 7 : mode === "native-timeout" ? null : 0; }, error: mode === "native-timeout" ? { code: "ETIMEDOUT", message: "timeout" } : undefined, stderr: mode === "native-failure" ? "failed" : "", stdout: "" };
        };
    } });
    Object.defineProperty(globals, "jsonResult", { configurable: true, get() { trace.push("json:get"); if (mode === "json-lookup-throw") failHere("json:get"); const selected = alternateResponse; return function(this: unknown, value: unknown) { trace.push(["json", this === undefined, selected]); if (mode === "json-call-throw") failHere("json"); return value; }; } });
    Object.defineProperty(globals, "withTargetStatus", { configurable: true, get() { trace.push("target:get"); alternateResponse = true; if (mode === "target-lookup-throw") failHere("target:get"); return function(this: unknown, value: unknown) { trace.push(["target", this === undefined]); if (mode === "target-call-throw") failHere("target"); return value; }; } });
    const bindings = {};
    for (const name of ["runWithTimeout", "jsonResult", "withTargetStatus"]) {
        Object.defineProperty(bindings, name, Object.getOwnPropertyDescriptor(globals, name)!);
    }
    globals.bindings = bindings;
    const api = runInNewContext(script, globals) as Record<string, (...args: unknown[]) => unknown>;
    let argumentReads = 0; const args = { get deviceId() { trace.push(["args:get", ++argumentReads]); return "sandbox"; } };
    return { api, trace, original, globals, args, fault, current: () => current, singleton: () => singleton };
}
async function replay(mode: string) {
    const results = [];
    for (const script of programs) {
        const f = execution(script, mode); let value: unknown, error: unknown;
        try { const pending = f.api.handleWindowsTool(mode === "unsupported" ? "unsupported" : "device_stop", f.args); value = await pending; } catch (caught) { if (["callee-throw", "json-lookup-throw", "target-lookup-throw"].includes(mode)) expect(caught).toBe(f.fault); error = caught instanceof Error ? { name: caught.name, message: caught.message, code: (caught as { code?: string }).code } : caught; }
        results.push(capture({ value, error, trace: f.trace, current: f.current(), singleton: f.singleton() }));
    }
    expect(results[1], mode).toEqual(results[0]);
    saveCapture(`replay-${mode}.json`, { baselineCommit, baselineSourceSha256: createHash("sha256").update(baseline).digest("hex"), candidateSourceSha256: createHash("sha256").update(candidate).digest("hex"), baseline: results[0], candidate: results[1] });
    return results;
}
const schedules = ["missing", "unsupported", "claim-conflict", "bind-foreign", "bind-guid", "bind-cas", "bind-success", "generation-refusal", "cancel-failure", "discovery-missing", "runtime-guid", "native-failure", "native-timeout", "successor", "complete-conflict", "stopped-runtime", "success", "lookup-throw", "id-throw", "clock-throw", "singleton-throw", "generation-throw", "helper-throw", "discovery-throw", "callee-throw", "native-throw", "status-throw", "json-lookup-throw", "json-call-throw", "target-lookup-throw", "target-call-throw", "cas-throw-claim", "cas-throw-bind", "cas-throw-abort", "cas-throw-complete", "release-false", "release-throw", "pre-lock-timeout", "locked-timeout", "locked-opaque-timeout", "acquire-timeout", "acquire-other"];

describe("actual baseline/candidate Sandbox stop replay", () => {
    it.each(schedules)("preserves all state/result/ordered effects for %s", async mode => { await replay(mode); });
    it("captures native and response callees before argument getters and preserves bare receivers", async () => {
        await replay("success"); const f = execution(programs[1], "success"); await f.api.handleWindowsTool("device_stop", f.args);
        const run = f.trace.find(value => Array.isArray(value) && value[0] === "run"); expect(run).toEqual(["run", true, false, "fixture-wsb", ["stop", "--id", guid], 60000]);
        expect(f.trace.indexOf("run:get")).toBeLessThan(f.trace.indexOf("wsb:get")); expect(f.trace.indexOf("json:get")).toBeLessThan(f.trace.indexOf("target:get"));
        expect(f.trace).toContainEqual(["json", true, false]); expect(f.trace).toContainEqual(["helper", true, "sandbox"]);
        expect(f.trace.filter(value => Array.isArray(value) && value[0] === "args:get")).toHaveLength(3);
    });
    it.each([undefined, null, false, 0, "", {}, [], { minimizeWatchdogPid: 17 }])("retains own helper/null/falsy/array cleanup for %j", helper => {
        const outputs = programs.map(script => { const f = execution(script, "success"); const callback = function(this: unknown, cancelPath: string) { f.trace.push(["supplied-cancel", this === undefined]); return { attempted: true, ok: true, cancelPath }; }; return capture({ result: f.api.cleanupWindowsSandboxMinimizeWatchdogs({ id: "sandbox", status: "stopped", helperSessionLaunch: helper }, callback), trace: f.trace }); });
        expect(outputs[1]).toEqual(outputs[0]);
    });
    it.each([undefined, null, "17", 1.5, 0, -1, 17])("retains PID filter %j, metadata resolution and single cancellation", pid => {
        const outputs = programs.map(script => { const f = execution(script, "success"); return capture({ result: f.api.cleanupWindowsSandboxMinimizeWatchdogs({ id: "sandbox", status: "stopped", helperSessionLaunch: { minimizeWatchdogPid: pid } }), trace: f.trace }); }); expect(outputs[1]).toEqual(outputs[0]);
    });
    it.each([null, undefined, false, 0, "", {}, { pid: 17 }])("retains nonnull watchdog %j truth table", launch => {
        const outputs = programs.map(script => { const f = execution(script, "success"); return capture({ result: f.api.cleanupWindowsSandboxMinimizeWatchdogs({ id: "sandbox", status: "stopped", minimizeWatchdogLaunch: launch }), trace: f.trace }); }); expect(outputs[1]).toEqual(outputs[0]);
    });
    it.each(["false", "null", "undefined", "throw"])("retains bare supplied cancel %s boundary and public arity 1", mode => {
        const outputs = programs.map(script => { const f = execution(script, "success"); let value, error; const callback = function(this: unknown) { f.trace.push(["supplied-cancel", this === undefined]); if (mode === "throw") throw "raw-cancel"; return mode === "false" ? { attempted: true, ok: false, cancelPath: "cancel" } : mode === "null" ? null : undefined; }; try { value = f.api.cleanupWindowsSandboxMinimizeWatchdogs({ id: "sandbox", status: "running", minimizeWatchdogLaunch: {} }, callback); } catch (caught) { error = caught; } expect(f.api.cleanupWindowsSandboxMinimizeWatchdogs.length).toBe(1); return capture({ value, error, trace: f.trace }); }); expect(outputs[1]).toEqual(outputs[0]);
    });
    it.each(["start", "stop", "delete"])("replays shared %s claim", operation => {
        const outputs = programs.map(script => { const f = execution(script, "success"); return capture({ result: f.api.claimWindowsLifecycle("sandbox", f.original, operation), trace: f.trace }); }); expect(outputs[1]).toEqual(outputs[0]);
    });
    it.each(["absent", "undefined", "null", "value", "current-missing"])("replays abort restoration and second lookup for %s", mode => {
        const outputs = programs.map(script => { const f = execution(script, mode === "current-missing" ? "missing" : "success"); const claimed = f.api.claimWindowsLifecycle("sandbox", f.original, "stop") as { lifecycle: unknown }; const prior = { ...f.original }; if (mode === "absent") { delete prior.lifecycle; delete prior.singletonClaimId; } else { prior.lifecycle = mode === "undefined" ? undefined : mode === "null" ? null : { runtimeId: "prior" }; prior.singletonClaimId = mode === "undefined" ? undefined : mode === "null" ? null : "prior"; } return capture({ result: f.api.abortWindowsLifecycle("sandbox", mode === "current-missing" ? { runtimeId: "foreign" } : claimed.lifecycle, prior, { helperSessionLaunch: undefined }), current: f.current(), trace: f.trace }); }); expect(outputs[1]).toEqual(outputs[0]);
    });
    it.each(["stopped", "claimed"])("replays bind %s bypass", mode => {
        const outputs = programs.map(script => { const f = execution(script, "success"); const claim = { lifecycle: { runtimeId: "operation", ...(mode === "claimed" ? { singletonClaimId: "old" } : {}) }, claimed: f.original, transition: { matched: true, found: true } }; return capture({ result: f.api.bindWindowsLifecycleSingleton("sandbox", claim, { ...f.original, status: mode === "stopped" ? "stopped" : "running" }), trace: f.trace }); }); expect(outputs[1]).toEqual(outputs[0]);
    });
    it("captures unchanged generated helper/bootstrap/launcher bytes", () => {
        const helper = { guestInboxDir: "C:\\ccc\\scratch\\inbox", guestOutboxDir: "C:\\ccc\\scratch\\outbox", guestUploadsDir: "C:\\ccc\\scratch\\uploads", guestDownloadsDir: "C:\\ccc\\scratch\\downloads", guestToolsDir: "C:\\ccc\\tools", guestHelperScript: "C:\\ccc\\scratch\\ccc-guest-helper.ps1", guestBootstrapScript: "C:\\ccc\\tools\\ccc-guest-helper-bootstrap.ps1" };
        const names = ["windowsHelperScript", "windowsHelperBootstrapScript", "windowsHelperBootstrapLauncherScript"];
        const hashes = [baseline, candidate].map(source => {
            const functions = ["windowsHelperMutexScriptLines", ...names].map(name => sourceFunction(source, name)).join("\n");
            const generators = runInNewContext('"use strict";\n' + functions + '\n({' + names.join(",") + '})') as Record<string, (metadata: typeof helper) => string>;
            return Object.fromEntries(names.map(name => [name, createHash("sha256").update(generators[name](helper)).digest("hex")]));
        });
        expect(hashes[1]).toEqual(hashes[0]); saveCapture("generated-native-assets.json", { baselineCommit, helper, baseline: hashes[0], candidate: hashes[1] });
    });
    it("retains native helpers and the original wrapper plus the approved 2b7045 create guard", () => {
        for (const [name, next] of [["device_start", "device_stop"], ["device_delete", "device_status"]]) {
            const body = (source: string) => source.slice(source.indexOf(`        case "${name}": {`), source.indexOf(`        case "${next}": {`)); expect(body(candidate)).toBe(body(baseline));
        }
        const retained = ["claimWindowsSingleton", "releaseWindowsSingleton", "updateWindowsSingletonRuntimeId", "windowsSingletonGenerationMatches", "windowsHelperMutexScriptLines", "windowsHelperScript", "windowsHelperBootstrapScript", "windowsHelperBootstrapLauncherScript", "cancelWindowsMinimizeWatchdog", "runWindowsSandboxCommand", "startWindowsSandboxDeviceRuntime", "launchWindowsSandboxSession", "windowsMinimizedStartProcessArgs", "windowsReadyMinimizeWatchdogArgs", "windowsWsbConfigLaunchArgs", "windowsSandboxMinimizeWatchdogArgs", "windowsSandboxWindowMinimizeScriptLines"];
        for (const name of retained) expect(sourceFunction(candidate, name), name).toBe(sourceFunction(baseline, name));
        // Independently reviewed 2b7045 adds only this first statement to the c284 wrapper.
        const originalWrapper = sourceFunction(baseline, "handleWindowsTool");
        const wrapperHeader = "async function handleWindowsTool(name, args) {\n";
        expect(originalWrapper.startsWith(wrapperHeader)).toBe(true);
        const expectedWrapper = wrapperHeader
            + '    if (name === "device_create" && args?.backend && args.backend !== "windows-sandbox") return undefined;\n'
            + originalWrapper.slice(wrapperHeader.length);
        expect(sourceFunction(candidate, "handleWindowsTool")).toBe(expectedWrapper);
        const nativePath = "packages/device-lab/providers/backends/windows-helper.ps1";
        const native = spawnSync("git", ["show", `${baselineCommit}:${nativePath}`], { cwd: root, encoding: "buffer", timeout: 10000 }); expect(native.status).toBe(0);
        expect(createHash("sha256").update(readFileSync(resolve(root, nativePath))).digest("hex")).toBe(createHash("sha256").update(native.stdout).digest("hex"));
    });
});
