import ts from "typescript";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createWindowsSandboxCreate } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-create.mjs";
import { createBrokerWindowsSandboxCreate } from "../../../packages/device-lab/src/device-lab/application/lifecycle/windows-sandbox-create.js";
import { brokerWindowsSandboxRecord, retainAfterWindowsConfigFailure } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-create.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const baselineCommit = "5957235b309121330ea46ab68c998dd8e3c52290";
function baseline(path: string) { const result = spawnSync("git", ["show", `${baselineCommit}:${path}`], { cwd: root, encoding: "utf8" }); if (result.status !== 0) throw Error(result.stderr); return result.stdout; }
function branch(source: string) { const start = source.indexOf('        case "device_create": {'); const end = source.indexOf('        case "device_delete": {', start); if (start < 0 || end < 0) throw Error("Missing actual create branch"); return source.slice(start, end); }
function declaration(source: string, name: string) { const tree = ts.createSourceFile("broker.ts", source, ts.ScriptTarget.Latest, true); const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name); if (!node) throw Error(`Missing native function ${name}`); return node.getText(tree); }
const directPath = "packages/device-lab/providers/backends/windows-sandbox.mjs";
const brokerPath = "packages/device-lab/src/device-lab-broker.ts";
async function broker(source: string, mode: string) {
    const trace: string[] = []; const files: string[] = []; const raw = { mode }; const device = { id: "sandbox", createdAt: "generation" }; let records = [device, { id: "sandbox", createdAt: "successor" }];
    const scope = source.indexOf("async function lifecycleCommandInvokeUnlocked(");
    const candidateStart = source.indexOf("        let sandboxDevice", scope);
    const start = candidateStart >= 0 ? candidateStart : source.indexOf("        let claim;", scope);
    const end = source.indexOf("        return {\n            status: 200,", start);
    if (start < 0 || end < 0) throw Error("Missing actual broker create transaction");
    const env = {
        createBrokerWindowsSandboxCreate, retainAfterWindowsConfigFailure, device, parsed: { backend: "windows-sandbox", deviceId: "sandbox", stateKey: "windows" }, persistedParsed: { create: {} }, ownerId: "owner", normalized: {}, providerCommand: null, hyperVCleanupDeadlineAt: Infinity,
        createOwnerDeviceRecord: () => device, createOwnerDeviceUniqueFields: () => ["id"],
        claimOwnerDevice: () => { trace.push("claim"); if (["claim-throw", "rollback-throw", "rollback-false"].includes(mode)) throw raw; return mode === "conflict" ? { ok: false, error: "owner-device-id-conflict", field: "id", value: "sandbox", existing: { id: "sandbox" } } : { ok: true }; },
        rollbackProviderCreateAfterConflict: async () => { trace.push("rollback"); if (mode === "rollback-throw") throw raw; return { ok: mode !== "rollback-false" }; },
        ownerDeviceStateErrorCode: () => null, ownerDeviceStateFailure: () => ({ status: 500, payload: { error: "state-error" } }), isHyperVBackend: () => false, redactBrokerDeviceSecrets: (value: unknown) => value,
        writeBrokerWindowsConfig: () => { trace.push("config"); files.push("partial-helper"); if (["config-throw", "mutation-throw"].includes(mode)) throw raw; },
        mutateOwnerDevices: (_owner: string, _state: string, update: (devices: typeof records) => typeof records) => { trace.push("mutate"); if (mode === "mutation-throw") throw raw; records = update(records); },
    };
    const code = ts.transpile('async function witness(){' + source.slice(start, end) + 'return {status:200};}', { target: ts.ScriptTarget.ES2022 });
    const invoke = runInNewContext(code + "witness", env); let result: unknown; let error: unknown;
    try { result = await invoke(); } catch (caught) { expect(caught).toBe(raw); error = "raw-error"; }
    return JSON.parse(JSON.stringify({ result, error, trace, records, files }));
}
async function direct(source: string, mode: string) {
    const trace: string[] = []; const files: string[] = []; const records: unknown[] = []; const raw = { mode }; let tick = 0;
    const env = {
        createWindowsSandboxCreate, args: { backend: mode === "skipped" ? "container" : "windows-sandbox", name: "test", memoryMb: null, networking: "truthy" },
        windowsDeviceId: () => { trace.push("derive"); return "sandbox"; },
        readWindowsDevices: () => { trace.push("read"); if (mode === "read-throw") throw raw; return mode === "duplicate" ? [{ id: "sandbox" }] : []; },
        ownerId: () => { trace.push("owner"); if (mode === "owner-throw") throw raw; return "owner"; },
        ensureHelperWorkspace: () => { trace.push("helper"); files.push("helper"); if (mode === "helper-throw") throw raw; return { scratch: "fixture" }; },
        Date: class { toISOString() { trace.push("clock"); if (mode === "clock-throw") throw raw; return `tick-${++tick}`; } },
        claimWindowsDevice: (device: unknown) => { trace.push("claim"); if (mode === "claim-throw") throw raw; if (mode === "conflict") return { ok: false, field: "id", value: "sandbox" }; records.push(device); return { ok: true }; },
        textResult: (ok: boolean, text: string) => ({ ok, text }), withTargetStatus: (device: unknown) => { trace.push("status"); return device; }, jsonResult: (value: unknown) => { trace.push("json"); return value; },
    };
    const invoke = runInNewContext('(async function(){switch("device_create"){' + branch(source) + '}})', env);
    let result: unknown; let error: unknown; try { result = await invoke(); } catch (caught) { expect(caught).toBe(raw); error = "raw-error"; }
    return JSON.parse(JSON.stringify({ result, error, trace, files, records }));
}
describe("frozen actual Sandbox create replay", () => {
    it.each(["success", "conflict", "claim-throw", "rollback-throw", "rollback-false", "config-throw", "mutation-throw"])("preserves actual complete broker transaction %s", async mode => {
        expect(await broker(readFileSync(resolve(root, brokerPath), "utf8"), mode)).toEqual(await broker(baseline(brokerPath), mode));
    });
    it.each(["success", "skipped", "duplicate", "conflict", "read-throw", "owner-throw", "helper-throw", "clock-throw", "claim-throw"])("preserves actual direct branch %s", async mode => {
        expect(await direct(readFileSync(resolve(root, directPath), "utf8"), mode)).toEqual(await direct(baseline(directPath), mode));
    });
    it("retains native helper/config bodies and record variant policy", () => {
        const old = baseline(brokerPath); const current = readFileSync(resolve(root, brokerPath), "utf8");
        expect(declaration(current, "writeBrokerWindowsConfig")).toBe(declaration(old, "writeBrokerWindowsConfig"));
        const record = runInNewContext(ts.transpile(declaration(old, "createOwnerDeviceRecord"), { target: ts.ScriptTarget.ES2022 }) + "createOwnerDeviceRecord", { brokerWindowsConfigPath: () => "/private/config", Date: class { toISOString() { return "shared-time"; } } });
        const device = record("owner", { backend: "windows-sandbox", deviceId: "sandbox", create: { memoryMb: Infinity, networking: 1, clipboard: true } });
        expect(device.memoryMb).toBe(Infinity); expect(device.networking).toBe(false); expect(device.clipboard).toBe(true); expect(device.createdAt).toBe(device.updatedAt);
        const candidateRecord = runInNewContext(ts.transpile(declaration(current, "createOwnerDeviceRecord"), { target: ts.ScriptTarget.ES2022 }) + "createOwnerDeviceRecord", { brokerWindowsSandboxRecord, brokerWindowsConfigPath: () => "/private/config", Date: class { toISOString() { return "shared-time"; } } });
        expect(JSON.parse(JSON.stringify(candidateRecord("owner", { backend: "windows-sandbox", deviceId: "sandbox", create: { memoryMb: Infinity, networking: 1, clipboard: true } })))).toEqual(JSON.parse(JSON.stringify(device)));
    });
    it("retains direct native workspace generators and external lock wrapper", () => {
        const old = baseline(directPath); const current = readFileSync(resolve(root, directPath), "utf8");
        for (const name of ["ensureHelperWorkspace", "windowsHelperMetadata", "windowsHelperScript", "windowsHelperBootstrapScript", "windowsHelperBootstrapLauncherScript"]) expect(declaration(current, name), name).toBe(declaration(old, name));
        const originalWrapper = declaration(old, "handleWindowsTool");
        const wrapperEntry = "export async function handleWindowsTool(name, args) {\n";
        const foreignCreateGuard = '    if (name === "device_create" && args?.backend && args.backend !== "windows-sandbox") return undefined;\n';
        expect(originalWrapper.startsWith(wrapperEntry)).toBe(true);
        expect(declaration(current, "handleWindowsTool")).toBe(originalWrapper.replace(wrapperEntry, wrapperEntry + foreignCreateGuard));
        const oldBroker = baseline(brokerPath); const currentBroker = readFileSync(resolve(root, brokerPath), "utf8");
        expect(declaration(currentBroker, "lifecycleCommandInvoke")).toBe(declaration(oldBroker, "lifecycleCommandInvoke"));
    });
});
