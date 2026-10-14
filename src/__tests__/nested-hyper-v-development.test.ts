import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nestedDiagnostic, saveNestedFailure, nestedExecOutput, nestedFailureMessage, prepareNestedHost, nestedLaunchCommand, runNestedDevelopment } from "../../scripts/real-tests/nested-hyper-v.ts";
import { nestedSourceAllowed, snapshotNestedSource } from "../../scripts/real-tests/nested-hyper-v-source.ts";
import { withExclusiveRealProviderRun, realProviderRunLockPath } from "../../scripts/real-tests/exclusive-real-provider-run.ts";

const returnedDeviceId = "windows-vm-13579bdf-2468-4ace-8bdf-13579bdf2468";
const reply = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
describe("nested run-lock diagnostics", () => {
    it("preserves the exclusive-run conflict through saving and CLI output without deleting the lock", async () => {
        const root = mkdtempSync(join(tmpdir(), "nested-lock-diagnostic-"));
        const lock = realProviderRunLockPath({ home: root });
        const operation = vi.fn();
        try {
            mkdirSync(join(root, ".ccc", "devices", "test-runs"), { recursive: true });
            const owner = JSON.stringify({ pid: 45560, host: "test-host", createdAt: "2026-09-30T15:11:04.383Z" });
            writeFileSync(lock, owner);
            const error = await withExclusiveRealProviderRun("nested development", operation, {
                home: root, withLockAsync: async () => { throw Object.assign(new Error("timeout"), { code: "shared-mutation-lock-timeout" }); },
            }).catch(error => error);
            const saved = saveNestedFailure(error, root, "acquire-run-lock");
            expect(JSON.parse(readFileSync(join(root, "failure.json"), "utf8"))).toMatchObject({ code: "real-provider-test-already-running" });
            expect(nestedFailureMessage(saved)).toContain("Wait for it to finish, then retry.");
            expect(nestedFailureMessage(saved)).not.toContain("nested-development-failed");
            expect(readFileSync(lock, "utf8")).toBe(owner);
            expect(operation).not.toHaveBeenCalled();
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it("does not expose arbitrary exception codes", () => {
        const error = Object.assign(new Error("ordinary failure"), { code: "PRIVATE-CODE\nSECRET" });
        expect(nestedDiagnostic(error).code).toBe("nested-development-failed");
    });
});
function scenario({ reboot = false, failed = false, pending = false, nested = true } = {}) {
    const calls: Array<{ name: string; args: any }> = [];
    let runId = "";
    const call = async (name: string, args: any) => {
        calls.push({ name, args });
        if (name === "download") {
            expect(existsSync(args.localPath)).toBe(true);
            expect(readFileSync(args.localPath, "utf8")).toBe("");
        }
        if (name === "create_windows_vm") return reply({ device: { deviceId: returnedDeviceId, name: "Nested Hyper-V development", nestedVirtualization: nested } });
        if (name === "exec") {
            if (args.command.includes("Register-ScheduledTask")) runId = /-RunId ([a-f0-9]{32})/.exec(args.command)![1];
            const output = args.command.includes("Get-Content -Raw") ? pending ? "pending" : JSON.stringify({ runId, status: failed ? "FAIL" : "PASS", stage: failed ? "build" : "complete", sourceSha256: "b".repeat(64) })
                : args.command.includes("Install-WindowsFeature") ? JSON.stringify({ reboot }) : "ok";
            return reply({ result: { status: 0, stdout: output } });
        }
        return reply({ ok: true });
    };
    return { call, calls };
}
async function withRun(input = {}) {
    const outputRoot = mkdtempSync(join(tmpdir(), "ccc-nested-test-"));
    const test = scenario(input);
    try {
        const result = await runNestedDevelopment(test.call, { outputRoot, jobPath: join(outputRoot, "job.ps1"), snapshot: () => ({ archive: join(outputRoot, "source.tar.gz"), sha256: "b".repeat(64) }), sleep: async () => {}, pollLimit: 2 });
        return { ...test, result };
    } catch (error) { Object.assign(error, { calls: test.calls }); throw error; }
    finally { rmSync(outputRoot, { recursive: true, force: true }); }
}

describe("persistent nested Hyper-V development workflow", () => {
    it.each([false, true])("builds a fresh source snapshot and handles feature reboot=%s", async reboot => {
        const { calls, result } = await withRun({ reboot });
        expect(result.status).toBe("PASS");
        expect(result.deviceId).toBe(returnedDeviceId);
        expect(calls[0].args).not.toHaveProperty("deviceId");
        expect(calls[0].args).not.toHaveProperty("incarnationId");
        expect(calls.slice(1).every(c => c.args.deviceId === returnedDeviceId && !("incarnationId" in c.args))).toBe(true);
        expect(calls.filter(c => c.name === "reboot")).toHaveLength(reboot ? 1 : 0);
        expect(calls[0]).toMatchObject({ name: "create_windows_vm", args: { profile: "windows-server", nestedVirtualization: true, memoryMb: 16384 } });
        if (reboot) expect(calls.find(c => c.name === "reboot")?.args).toEqual({
            deviceId: returnedDeviceId,
            force: true, waitForBoot: true, bootTimeoutMs: 1200000,
        });
        expect(calls.filter(c => c.name === "upload")).toHaveLength(2);
        expect(calls.at(-3)!.args.command).toContain("-Operation 'complete'");
        expect(calls.at(-2)).toEqual({ name: "stop", args: { deviceId: returnedDeviceId } });
        expect(calls.at(-1)).toMatchObject({ name: "delete", args: { deviceId: returnedDeviceId, force: true, confirmDestructive: true, preserveNetwork: true } });
        expect(calls.findIndex(c => c.name === "download")).toBeLessThan(calls.length - 3);
    });
    it("refuses an outer broker that silently drops nested virtualization", async () => {
        await expect(withRun({ nested: false })).rejects.toThrow("outer-broker-nesting-not-confirmed");
    });
    it("propagates guest build failure instead of reporting a readiness pass", async () => {
        const failure = await withRun({ failed: true }).catch(error => error);
        expect(failure.message).toContain("nested-development-failed: build");
        expect(failure.calls.at(-2)).toMatchObject({ name: "stop", args: { deviceId: returnedDeviceId } });
        expect(failure.calls.at(-1)).toMatchObject({ name: "delete", args: { deviceId: returnedDeviceId } });
    });
    it("keeps an indeterminate scheduled job claimed after the bounded wait", async () => {
        try { await withRun({ pending: true }); throw new Error("expected timeout"); }
        catch (error) {
            expect(error.message).toContain("nested-development-timeout");
            expect(error.calls.some((c: any) => c.name === "stop" || c.args.command?.includes("-Operation 'complete'"))).toBe(false);
        }
    });
    it.each(["PASS", "FAIL"])("stops after terminal %s and preserves primary failure when stop fails", async status => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-nested-stop-"));
        const normal = scenario({ failed: status === "FAIL" });
        const stop = vi.fn(async () => reply({ ok: false, error: "hyper-v-stop-failed" }));
        try {
            await expect(runNestedDevelopment(async (name, args) => name === "stop" ? stop() : normal.call(name, args), {
                outputRoot, jobPath: "unused", snapshot: () => ({ archive: "source", sha256: "b".repeat(64) }),
            })).rejects.toThrow(status === "FAIL" ? "nested-development-failed: build" : "hyper-v-stop-failed");
            expect(stop).toHaveBeenCalledOnce();
            expect(existsSync(join(outputRoot, "result.json"))).toBe(true);
            const failure = JSON.parse(readFileSync(join(outputRoot, "failure.json"), "utf8"));
            expect(status === "FAIL" ? failure.cleanup : failure).toMatchObject({ stage: "stop-outer-vm", tool: "stop", code: "hyper-v-stop-failed" });
            if (status === "FAIL") expect(failure.stage).toBe("validate-guest-result");
        } finally { rmSync(outputRoot, { recursive: true, force: true }); }
    });
    it.each(["launch", "hash", "status", "runId"])("does not stop an uncertain or unowned guest run: %s", async fault => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-nested-uncertain-"));
        const normal = scenario();
        const calls: string[] = [];
        try {
            await expect(runNestedDevelopment(async (name, args) => {
                calls.push(name);
                if (fault === "claim" && args.command?.includes("-Operation 'acquire'")) throw new Error("claim-conflict");
                if (fault === "launch" && args.command?.includes("Register-ScheduledTask")) throw new Error("launch-uncertain");
                const response = await normal.call(name, args);
                if (name === "exec" && args.command.includes("Get-Content -Raw")) {
                    const outer = JSON.parse(response.content[0].text);
                    const terminal = JSON.parse(outer.result.stdout);
                    terminal[fault === "hash" ? "sourceSha256" : fault] = "invalid";
                    outer.result.stdout = JSON.stringify(terminal);
                    return reply(outer);
                }
                return response;
            }, { outputRoot, jobPath: "unused", snapshot: () => ({ archive: "source", sha256: "b".repeat(64) }) })).rejects.toThrow();
            expect(calls).not.toContain("stop");
            expect(normal.calls.some(c => c.args.command?.includes("-Operation 'complete'"))).toBe(false);
        } finally { rmSync(outputRoot, { recursive: true, force: true }); }
    });
    it.each(["prepare", "download"])("stops the owned VM after safe %s failure", async fault => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-nested-failure-stop-"));
        const normal = scenario();
        try {
            await expect(runNestedDevelopment(async (name, args) => {
                if ((fault === "prepare" && args.command?.includes("Install-WindowsFeature")) || (fault === "download" && name === "download")) throw new Error("test-operation-failed");
                return normal.call(name, args);
            }, { outputRoot, jobPath: "unused", snapshot: () => ({ archive: "source", sha256: "b".repeat(64) }) })).rejects.toThrow("test-operation-failed");
            expect(normal.calls.at(-2)).toMatchObject({ name: "stop", args: { deviceId: returnedDeviceId } });
            expect(normal.calls.at(-1)).toMatchObject({ name: "delete", args: { deviceId: returnedDeviceId } });
            expect(normal.calls.at(-3)?.args.command).toContain("-Operation 'complete'");
        } finally { rmSync(outputRoot, { recursive: true, force: true }); }
    });
    it("cleans the exact returned outer fixture when guest claim fails before launch", async () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-nested-claim-cleanup-"));
        const normal = scenario();
        try {
            await expect(runNestedDevelopment(async (name, args) => {
                if (args.command?.includes("-Operation 'acquire'")) throw new Error("fixture-claim-conflict");
                return normal.call(name, args);
            }, { outputRoot, jobPath: "unused", snapshot: () => { throw new Error("must not snapshot"); } })).rejects.toThrow("fixture-claim-conflict");
            expect(normal.calls.slice(-2).map(call => [call.name, call.args.deviceId])).toEqual([["stop", returnedDeviceId], ["delete", returnedDeviceId]]);
        } finally { rmSync(outputRoot, { recursive: true, force: true }); }
    });
    it("rejects failed guest commands and command injection before launch", () => {
        expect(() => nestedExecOutput({ result: { status: 1, stdout: "{}" } })).toThrow();
        expect(() => nestedLaunchCommand("x';whoami", "b".repeat(64), "22.1.0", "linux")).toThrow();
        expect(() => nestedLaunchCommand("a".repeat(32), "b".repeat(64), "22.1.0", "linux;whoami")).toThrow();
    });
    it("keeps the nested network separate in both allocation and gateway configuration", () => {
        const script = "import {HYPER_V_NETWORK_GATEWAY as gateway,HYPER_V_NETWORK_PREFIX as prefix} from './packages/device-lab/src/host-control/hyper-v/contracts.ts'; import {hyperVDeterministicNetworkAddresses as addresses} from './packages/device-lab/src/device-lab/broker/hyper-v/network.ts'; console.log(JSON.stringify({gateway,prefix,addresses:addresses('owner','vm')}));";
        const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, CCC_HYPER_V_NESTED_HOST: "1" }, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        const network = JSON.parse(result.stdout);
        expect(network.gateway).toBe("172.30.0.1");
        expect(network.prefix).toBe("172.30.0.0/24");
        expect(network.addresses.every((address: string) => address.startsWith("172.30.0."))).toBe(true);
    });
    it("snapshots edited and new source files, excluding ignored data and credentials", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-nested-source-"));
        try {
            const git = (args: string[]) => { const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); expect(result.status, result.stderr).toBe(0); };
            git(["init", "--quiet"]);
            writeFileSync(join(root, "main.ts"), "old");
            git(["add", "main.ts"]);
            writeFileSync(join(root, "main.ts"), "working-tree-change");
            writeFileSync(join(root, "new.ts"), "new-module");
            writeFileSync(join(root, ".gitignore"), "ignored.txt\nresults/\n");
            writeFileSync(join(root, "ignored.txt"), "private");
            writeFileSync(join(root, ".env"), "secret");
            const snapshot = snapshotNestedSource(root, join(root, "results"));
            const extracted = join(root, "unpack"); mkdirSync(extracted);
            const unpack = spawnSync("tar", ["-xzf", snapshot.archive, "-C", extracted]);
            expect(unpack.status).toBe(0);
            expect(readFileSync(join(extracted, "main.ts"), "utf8")).toBe("working-tree-change");
            expect(readFileSync(join(extracted, "new.ts"), "utf8")).toBe("new-module");
            expect(() => readFileSync(join(extracted, ".env"))).toThrow();
            expect(() => readFileSync(join(extracted, "ignored.txt"))).toThrow();
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it.each(["../secret", "/root/key", "C:/secret", "node_modules/a", "src/.env.local", "id.key", "a\\b", ".git/config"])("excludes unsafe snapshot path %s", name => expect(nestedSourceAllowed(name)).toBe(false));
});


describe("nested run failure artifacts", () => {
    it.each([
        ["mcp", "create_windows_vm", "create-outer-vm"], ["structured", "create_windows_vm", "create-outer-vm"],
        ["thrown", "create_windows_vm", "create-outer-vm"], ["mcp", "start", "start-outer-vm"],
    ])("saves early provider %s failures from %s with the actual path", async (kind, failedTool, stage) => {
        const root = mkdtempSync(join(tmpdir(), "ccc-nested-failure-"));
        const outputRoot = join(root, "run");
        const providerFailure = { ok: false, error: "provider-command-failed", detail: "Nested virtualization could not be enabled",
            execution: { status: 1, stderr: "Set-VMProcessor: The operation is not supported" } };
        const normal = scenario();
        const call = vi.fn(async (name: string, args: any) => {
            if (name !== failedTool) return normal.call(name, args);
            if (kind === "thrown") throw new Error(JSON.stringify(providerFailure));
            return { ...reply(providerFailure), ...(kind === "mcp" ? { isError: true } : {}) };
        });
        try {
            const failure = await runNestedDevelopment(call, { outputRoot, jobPath: "unused", snapshot: () => { throw new Error("must not snapshot"); } })
                .then(() => { throw new Error("unexpected success"); }, error => error);
            expect(call).toHaveBeenCalledTimes(failedTool === "start" ? 4 : 1);
            if (failedTool === "start") expect(call.mock.calls.slice(-2).map(([tool, args]) => [tool, args.deviceId])).toEqual([["stop", returnedDeviceId], ["delete", returnedDeviceId]]);
            const diagnosticPath = join(outputRoot, "failure.json");
            const artifact = JSON.parse(readFileSync(diagnosticPath, "utf8"));
            expect(artifact).toMatchObject({ stage, tool: failedTool, code: "provider-command-failed" });
            expect(artifact.diagnostics).toContainEqual(expect.objectContaining({ status: 1, stderr: "Set-VMProcessor: The operation is not supported" }));
            expect(nestedFailureMessage(failure)).toContain(diagnosticPath);
            expect(nestedFailureMessage(failure)).toContain(`${stage}/${failedTool}: provider-command-failed`);
            expect(existsSync(join(outputRoot, "job.log"))).toBe(false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it("keeps the primary preparation error when claim cleanup also fails", async () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-nested-cleanup-"));
        const primary = new Error("nested-feature-install-failed");
        const normal = scenario();
        const call = async (name: string, args: any) => {
            if (args.command?.includes("Install-WindowsFeature")) throw primary;
            if (args.command?.includes("-Operation 'complete'")) throw new Error("nested-claim-complete-failed");
            return normal.call(name, args);
        };
        try {
            await expect(runNestedDevelopment(call, { outputRoot, jobPath: "unused", snapshot: () => { throw new Error("unused"); } })).rejects.toBe(primary);
            const artifact = JSON.parse(readFileSync(join(outputRoot, "failure.json"), "utf8"));
            expect(artifact).toMatchObject({ stage: "prepare-nested-hyper-v", tool: "exec", code: "nested-feature-install-failed",
                cleanup: { stage: "complete-guest-claim", tool: "exec", code: "nested-claim-complete-failed" } });
        } finally { rmSync(outputRoot, { recursive: true, force: true }); }
    });
    it("retains bounded command failure diagnostics without request material or credentials", () => {
        const text = JSON.stringify(nestedDiagnostic(new Error("nested-guest-command-failed"), {
            ownerId: "PRIVATE_OWNER", auth: { token: "PRIVATE_AUTH" }, command: "Write-Output PRIVATE_SCRIPT", args: ["PRIVATE_ARG"],
            result: { status: 1, stdout: "PRIVATE_STDOUT", stderr: "Access denied\nAuthorization: Bearer PRIVATE_BEARER\npassword=PRIVATE_PASSWORD\n+ $pw = 'PRIVATE_SCRIPT_PASSWORD'\n" + "x".repeat(100000),
                execution: { input: "PRIVATE_INPUT", command: { status: 1, stderr: "Hyper-V feature missing" } } },
        }));
        expect(text).toContain("nested-guest-command-failed");
        expect(text).toContain("Access denied");
        expect(text).toContain("Hyper-V feature missing");
        expect(text).not.toContain("PRIVATE_");
        expect(text.length).toBeLessThan(10000);
    });
    it("distinguishes a successful host start from failed guest readiness", () => {
        const result = nestedDiagnostic(new Error("hyper-v-guest-not-ready"), {
            error: "hyper-v-guest-not-ready", body: { result: {
                boot: { ready: false, error: "powershell-direct-unavailable", attempts: 4,
                    errorDetail: { structured: true, status: 1, timedOut: false, stdoutBytes: 143, stderrBytes: 0 },
                    diagnostic: { state: "Running", heartbeatEnabled: true, heartbeatPrimaryStatus: 2,
                        stdout: "PRIVATE_GUEST", vmName: "PRIVATE_VM", bootEntries: ["PRIVATE_PATH"] } },
                execution: { command: { status: 0, outputRedacted: true,
                    guestReadiness: { error: "powershell-direct-unavailable", diagnosticAvailable: true,
                        errorDetail: { structured: true, status: 1 } } } },
            } },
        });
        expect(result.code).toBe("hyper-v-guest-not-ready");
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: "$.body.result.boot", ready: false, attempts: 4, error: "powershell-direct-unavailable" }),
            expect.objectContaining({ path: "$.body.result.boot.errorDetail", structured: true, status: 1, stdoutBytes: 143 }),
            expect.objectContaining({ path: "$.body.result.boot.diagnostic", state: "Running", heartbeatEnabled: true }),
            expect.objectContaining({ path: "$.body.result.execution.command", status: 0 }),
            expect.objectContaining({ path: "$.body.result.execution.command.guestReadiness.errorDetail", status: 1 }),
        ]));
        expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    });
    it("bounds recursive diagnostics and filters sensitive or invalid readiness facts", () => {
        const payload: any = { error: "hyper-v-guest-not-ready", boot: {
            ready: "PRIVATE_READY", attempts: -1, diagnosticError: "token=PRIVATE_TOKEN",
            errorDetail: { status: null, structured: "PRIVATE_STRUCTURED", stdoutBytes: Infinity, stderrBytes: "PRIVATE_BYTES", stderr: "password=PRIVATE_PASSWORD" },
            diagnostic: { state: "credential=PRIVATE_CREDENTIAL", heartbeatPrimaryStatus: NaN, uptimeMs: -1 },
        } };
        payload.result = payload;
        let deep = payload;
        for (let i = 0; i < 100; i++) { deep.command = { error: "bounded-failure" }; deep = deep.command; }
        const result = nestedDiagnostic(new Error("failure"), payload);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "$.boot.errorDetail", status: null }));
        expect(result.diagnostics.length).toBeLessThanOrEqual(24);
        expect(result.diagnostics.every(value => String(value.path).split(".").length <= 9)).toBe(true);
        expect(JSON.stringify(result)).not.toContain("PRIVATE_");
        expect(result.diagnostics.find(value => value.path === "$.boot")).toBeUndefined();
    });
    it("retains deep readiness details when HTTP envelopes duplicate the result", () => {
        const providerResult = {
            boot: { ready: false, error: "powershell-direct-unavailable", errorDetail: { status: 1, structured: true },
                diagnostic: { state: "Running" } },
            execution: { command: { status: 0, guestReadiness: { error: "powershell-direct-unavailable",
                errorDetail: { status: null, structured: false, timedOut: true } } } },
            provisioning: { status: 0 }, launch: { status: 0 },
        };
        const result = nestedDiagnostic(new Error("failure"), JSON.parse(JSON.stringify({
            error: "hyper-v-guest-not-ready", body: { result: providerResult }, result: providerResult,
        })));
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
            path: "$.body.result.execution.command.guestReadiness.errorDetail", status: null, structured: false, timedOut: true,
        }));
    });
    it("preserves the original error and never claims a saved file when writing fails", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-nested-write-failure-"));
        const outputRoot = join(root, "not-a-directory");
        writeFileSync(outputRoot, "occupied");
        try {
            const primary = new Error("provider-command-failed");
            expect(saveNestedFailure(primary, outputRoot, "start-outer-vm", "start")).toBe(primary);
            expect(nestedFailureMessage(primary)).toContain("Could not save failure diagnostics");
            expect(nestedFailureMessage(primary)).not.toContain("Diagnostics:");
            expect(readFileSync(outputRoot, "utf8")).toBe("occupied");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

describe("nested host preflight and concise errors", () => {
    it("builds before broker repair on Windows", async () => {
        const steps: string[] = [];
        await prepareNestedHost("/repo", { platform: "win32",
            build: () => { steps.push("build"); return 0; },
            ready: async () => { steps.push("ready"); return 0; },
        });
        expect(steps).toEqual(["build", "ready"]);
    });
    it("never repairs after failed build and saves bounded diagnostics", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-preflight-"));
        const ready = vi.fn(async () => 0);
        try {
            const diagnosticPath = join(root, "preflight.log");
            await expect(prepareNestedHost("/repo", { platform: "win32", diagnosticPath,
                build: (_repo, options) => { options.writeError("compiler failure".repeat(10000)); return 1; }, ready,
            })).rejects.toThrow("nested-host-build-failed");
            expect(ready).not.toHaveBeenCalled();
            expect(readFileSync(diagnosticPath, "utf8")).toHaveLength(65536);
        } finally { rmSync(root, {recursive: true, force: true}); }
    });
    it("fails preflight when identity-safe repair fails", async () => {
        await expect(prepareNestedHost("/repo", { platform: "win32", build: () => 0, ready: async () => 1 }))
            .rejects.toThrow("host-broker-preflight-failed");
    });
    it("does not launch a container-local broker for a remote host", async () => {
        const build = vi.fn(() => 0);
        const ready = vi.fn(async () => 0);
        await prepareNestedHost("/repo", { platform: "linux", build, ready });
        expect(build).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
    });
    it("collapses huge RPC errors without leaking metadata", () => {
        const text = nestedFailureMessage(new Error(JSON.stringify({error: "host-broker-incompatible", ownerId: "private-owner", attempts: ["SECRET".repeat(100000)]})));
        expect(text.length).toBeLessThan(250);
        expect(text).toContain("host-broker-incompatible");
        expect(text).toContain("devices broker status");
        expect(text).not.toMatch(/SECRET|private-owner|attempts/);
        expect(nestedFailureMessage(new Error('{"error":"\\u001b[31mSECRET"}'))).not.toContain("SECRET");
    });
});

describe("nested live progress", () => {
    it("reports guest stage transitions before accepting only the terminal result", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-nested-progress-complete-"));
        const base = scenario();
        const messages: string[] = [];
        let runId = "";
        let poll = 0;
        try {
            const result = await runNestedDevelopment(async (name, args) => {
                if (args.command?.includes("Register-ScheduledTask")) runId = /-RunId ([a-f0-9]{32})/.exec(args.command)![1];
                if (name === "exec" && args.command.includes("Get-Content -Raw") && poll++ < 2)
                    return reply({ result: { status: 0, stdout: JSON.stringify({ kind: "progress", runId, stage: poll === 1 ? "install" : "test" }) } });
                return base.call(name, args);
            }, { outputRoot: root, jobPath: "job.ps1", snapshot: () => ({ archive: "source", sha256: "b".repeat(64) }),
                progress: message => messages.push(message), sleep: async () => {}, pollLimit: 3 });
            expect(result.status).toBe("PASS");
            expect(messages.filter(m => m.includes("last reported"))).toEqual([
                expect.stringContaining("guest-install"), expect.stringContaining("guest-test"),
            ]);
            expect(base.calls.filter(c => c.name === "download")).toHaveLength(1);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it("reports each stage and continues reporting during a pending RPC, then clears its timer", async () => {
        vi.useFakeTimers();
        const root = mkdtempSync(join(tmpdir(), "ccc-nested-progress-"));
        const messages: string[] = [];
        const base = scenario();
        let resume!: () => void;
        const pending = new Promise<void>(resolve => { resume = resolve; });
        const run = runNestedDevelopment(async (name, args) => {
            if (name === "start") await pending;
            return base.call(name, args);
        }, { outputRoot: root, jobPath: "job.ps1", snapshot: () => ({ archive: "source.tar.gz", sha256: "b".repeat(64) }), progress: message => messages.push(message) });
        try {
            await vi.advanceTimersByTimeAsync(90000);
            expect(messages.filter(m => m.includes("start-outer-vm (waiting)"))).toHaveLength(3);
            expect(messages.some(m => m.includes("elapsed 90s"))).toBe(true);
            resume();
            await run;
            expect(messages.some(m => m.includes("create-outer-vm"))).toBe(true);
            expect(messages.some(m => m.includes("validate-guest-result"))).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally { resume(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
    });
    it("clears progress timers on failure", async () => {
        vi.useFakeTimers();
        const root = mkdtempSync(join(tmpdir(), "ccc-nested-progress-fail-"));
        try {
            await expect(runNestedDevelopment(async () => { throw new Error("fail"); }, {
                outputRoot: root, jobPath: "job.ps1", snapshot: () => ({ archive: "source", sha256: "b".repeat(64) }), progress: () => {},
            })).rejects.toThrow("fail");
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
    });
    it.each(["valid", "wrong-run", "wrong-stage"])("never treats %s progress as a completed result", async kind => {
        const root = mkdtempSync(join(tmpdir(), "ccc-nested-progress-poll-"));
        const base = scenario();
        let runId = "";
        const messages: string[] = [];
        try {
            await expect(runNestedDevelopment(async (name, args) => {
                if (args.command?.includes("Register-ScheduledTask")) runId = /-RunId ([a-f0-9]{32})/.exec(args.command)![1];
                if (name === "exec" && args.command.includes("Get-Content -Raw")) return reply({ result: { status: 0, stdout: JSON.stringify({ kind: "progress", runId: kind === "wrong-run" ? "0".repeat(32) : runId, stage: kind === "wrong-stage" ? "PASS secret" : "build" }) } });
                return base.call(name, args);
            }, { outputRoot: root, jobPath: "job.ps1", snapshot: () => ({ archive: "source", sha256: "b".repeat(64) }),
                progress: message => messages.push(message), sleep: async () => {}, pollLimit: 2 })).rejects.toThrow("nested-development-timeout");
            expect(messages.some(m => m.includes("guest-build"))).toBe(kind === "valid");
            expect(messages.join(" ")).not.toContain("secret");
            expect(base.calls.some(c => c.name === "download")).toBe(false);
            expect(base.calls.some(c => c.name === "stop" || c.args.command?.includes("-Operation 'complete'"))).toBe(false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
