import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commands from "@ccc/device-lab/providers/commands.mjs";
import { handleMacosTool } from "@ccc/device-lab/providers/backends/macos-vm.mjs";
import { writeMacosDevices } from "@ccc/device-lab/providers/state/macos-state.mjs";
import { jsonResult } from "@ccc/device-lab/providers/responses.mjs";
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";
import { presentBrokerTool } from "../../device-lab-mcp/src/device-request-presenter.mjs";
import { finishStartReadiness } from "../../device-lab-mcp/src/start-readiness.mjs";
import { brokerToolFailureEvidence } from "../../scripts/real-tests/device-lab-mcp-client.ts";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";

type NativeReceipt = {
    status: number | null;
    signal?: string | null;
    timedOut?: boolean;
    stdout: string;
    stderr: string;
    error?: { code?: string; message?: string; path?: string; spawnargs?: string[] };
};
const privateOutput = "PRIVATE-OUTPUT /Users/PRIVATE-PATH token=PRIVATE-CREDENTIAL";
const failure = (extra: Partial<NativeReceipt> = {}): NativeReceipt => ({
    status: 255, signal: null, stdout: privateOutput, stderr: "original SSH refusal", ...extra,
});
const device = { id: "macos-failure-evidence", name: "Private Evidence Fixture", provider: "tart", status: "running",
    ssh: { host: "PRIVATE-HOST", user: "PRIVATE-USER" }, helper: { remoteScriptPath: "/tmp/PRIVATE-HELPER.sh" } };
const start = () => jsonResult({ device: { id: device.id, backend: "macos-vm" } });

describe("Mac desktop native failures through public presentation and readiness", () => {
    let home: string;
    let restoreEnvironment: () => void;
    let receipt: NativeReceipt;
    let native: ReturnType<typeof vi.spyOn>;
    let transferDirectory: string | undefined;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ccc-macos-failure-evidence-"));
        restoreEnvironment = isolateDeviceLabTestEnvironment(home);
        writeMacosDevices([device]);
        receipt = failure();
        vi.spyOn(commands, "commandPath").mockImplementation(name => `/PRIVATE-NATIVE/${name}`);
        native = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => receipt as ReturnType<typeof commands.runWithTimeout>);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        restoreEnvironment();
        rmSync(home, { recursive: true, force: true });
        if (transferDirectory) rmSync(transferDirectory, { recursive: true, force: true });
        transferDirectory = undefined;
    });

    it.each([
        { name: "SSH exit 255", receipt: failure(), execution: { status: 255, signal: null, timedOut: false, errorCode: null, diagnosticCode: "native-nonzero-exit" } },
        { name: "guest helper exit 1", receipt: failure({ status: 1 }), execution: { status: 1, signal: null, timedOut: false, errorCode: null, diagnosticCode: "native-nonzero-exit" } },
        { name: "native signal", receipt: failure({ status: null, signal: "SIGTERM" }), execution: { status: null, signal: "SIGTERM", timedOut: false, errorCode: null, diagnosticCode: "native-signal" } },
        { name: "explicit timeout", receipt: failure({ status: null, timedOut: true }), execution: { status: null, signal: null, timedOut: true, errorCode: null, diagnosticCode: "native-timeout" } },
        { name: "native timeout errno", receipt: failure({ status: null, error: { code: "ETIMEDOUT" } }), execution: { status: null, signal: null, timedOut: true, errorCode: "ETIMEDOUT", diagnosticCode: "native-timeout" } },
        { name: "missing executable", receipt: failure({ status: null, error: { code: "ENOENT" } }), execution: { status: null, signal: null, timedOut: false, errorCode: "ENOENT", diagnosticCode: "native-not-found" } },
        { name: "native permission denial", receipt: failure({ status: null, error: { code: "EACCES" } }), execution: { status: null, signal: null, timedOut: false, errorCode: "EACCES", diagnosticCode: "native-permission-denied" } },
        { name: "operation permission denial", receipt: failure({ status: null, error: { code: "EPERM" } }), execution: { status: null, signal: null, timedOut: false, errorCode: "EPERM", diagnosticCode: "native-permission-denied" } },
        { name: "other observed errno", receipt: failure({ status: null, error: { code: "EIO" } }), execution: { status: null, signal: null, timedOut: false, errorCode: "EIO", diagnosticCode: "native-unknown" } },
    ])("retains $name and original failure content through detail and compact modes", async ({ receipt: observed, execution }) => {
        receipt = observed;
        const raw = await handleMacosTool("device_cursor_position", { deviceId: device.id, helperTimeoutMs: 700 });
        expect(native).toHaveBeenCalledTimes(1);
        expect(native.mock.calls[0].slice(0, 3)).toEqual(["/PRIVATE-NATIVE/ssh", [
            "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "PRIVATE-USER@PRIVATE-HOST", "'/tmp/PRIVATE-HELPER.sh' cursor_position",
        ], 700]);
        expect(raw).toMatchObject({ isError: true, content: [{ type: "text", text: "Error: original SSH refusal" }] });
        expect(raw?.structuredContent).toEqual({ ok: false, error: "provider-command-failed", execution });
        const presented = presentBrokerTool({ ok: true, result: { mcpResult: raw } }, {}, jsonResult);
        for (const detail of [true, false]) {
            const publicResult = actionResult("cursor_position", "device_cursor_position", presented, { detail });
            expect(publicResult.isError).toBe(true);
            expect(publicResult.structuredContent).toEqual(raw?.structuredContent);
            expect(detail ? publicResult.content[0].text : JSON.parse(publicResult.content[0].text).error).toBe("Error: original SSH refusal");
            let clock = 500;
            const notReady = await finishStartReadiness(start(), { deviceId: device.id, bootTimeoutMs: 1000 }, 0, async () => publicResult, {
                now: () => clock, sleep: async (ms: number) => { clock += ms; },
            });
            const value = JSON.parse(notReady.content[0].text);
            const selectedExecution = { ...execution } as Record<string, unknown>;
            if (selectedExecution.errorCode === null) delete selectedExecution.errorCode;
            const expectedReadiness = { attempts: 1, lastProbe: "provider-error", failureAttempt: 1,
                failure: { stage: "provider", error: "provider-command-failed", execution: selectedExecution } };
            expect(value).toMatchObject({ ok: false, error: "device-start-not-ready", readiness: expectedReadiness });
            expect(brokerToolFailureEvidence(value).readiness).toEqual(expectedReadiness);
            expect(JSON.stringify([raw?.structuredContent, value.readiness, brokerToolFailureEvidence(value).readiness])).not.toContain("PRIVATE");
        }
        expect(native).toHaveBeenCalledTimes(1);
    });

    it("omits unrecognized native fields while retaining the original failure text", async () => {
        receipt = failure({ status: Number.MAX_SAFE_INTEGER + 1, signal: "SIG/PRIVATE-SIGNAL", timedOut: false,
            error: { code: "PRIVATE-CODE", message: privateOutput, path: "/PRIVATE-PATH", spawnargs: ["PRIVATE-ARG"] } });
        const raw = await handleMacosTool("device_cursor_position", { deviceId: device.id });
        expect(raw?.structuredContent).toEqual({ ok: false, error: "provider-command-failed", execution: {
            status: null, signal: null, timedOut: false, errorCode: null, diagnosticCode: "native-unknown",
        } });
        expect(raw?.content).toEqual([{ type: "text", text: "Error: original SSH refusal" }]);
        expect(JSON.stringify(raw?.structuredContent)).not.toContain("PRIVATE");
    });

    it("preserves an actual failed SCP receipt without publishing or committing the download", async () => {
        const outputRoot = join(process.cwd(), "results", ".tmp");
        mkdirSync(outputRoot, { recursive: true });
        transferDirectory = mkdtempSync(join(outputRoot, "ccc-macos-failure-transfer-"));
        const destination = join(transferDirectory, "download.bin");
        receipt = failure({ status: 1 });
        const raw = await handleMacosTool("device_download", { deviceId: device.id, remotePath: "/tmp/PRIVATE-REMOTE.bin",
            localPath: destination, helperTimeoutMs: 700 });
        expect(native).toHaveBeenCalledTimes(1);
        expect(native.mock.calls[0][0]).toBe("/PRIVATE-NATIVE/scp");
        expect(native.mock.calls[0][2]).toBe(700);
        expect(raw?.content).toEqual([{ type: "text", text: "Error: original SSH refusal" }]);
        expect(raw?.structuredContent).toEqual({ ok: false, error: "provider-command-failed", execution: {
            status: 1, signal: null, timedOut: false, errorCode: null, diagnosticCode: "native-nonzero-exit",
        } });
        expect(existsSync(destination)).toBe(false);
        expect(JSON.stringify(raw?.structuredContent)).not.toContain("PRIVATE");
    });

    it("keeps a bridge preflight refusal unclassified when no native command ran", async () => {
        writeMacosDevices([{ ...device, ssh: null }]);
        const raw = await handleMacosTool("device_cursor_position", { deviceId: device.id });
        expect(raw?.isError).toBe(true);
        expect(raw).not.toHaveProperty("structuredContent");
        expect(native).not.toHaveBeenCalled();
        let clock = 500;
        const notReady = await finishStartReadiness(start(), { deviceId: device.id, bootTimeoutMs: 1000 }, 0, async () => raw, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        });
        expect(JSON.parse(notReady.content[0].text).readiness).toEqual({ attempts: 1, lastProbe: "provider-error" });
    });

    it("preserves successful cursor content and readiness without adding failure metadata", async () => {
        receipt = { status: 0, signal: null, stdout: JSON.stringify({ ok: true, cursor: { x: 3, y: 4 } }), stderr: "" };
        const raw = await handleMacosTool("device_cursor_position", { deviceId: device.id });
        expect(raw).toEqual(jsonResult({ provider: "ssh-macos-helper", remoteScriptPath: device.helper.remoteScriptPath,
            stdout: receipt.stdout, stderr: "", status: 0, cursor: { x: 3, y: 4 } }));
        expect(raw).not.toHaveProperty("structuredContent");
        const presented = presentBrokerTool({ ok: true, result: { mcpResult: raw } }, {}, jsonResult);
        for (const detail of [true, false]) {
            const publicResult = actionResult("cursor_position", "device_cursor_position", presented, { detail });
            expect(publicResult.isError).toBe(false);
            expect(publicResult).not.toHaveProperty("structuredContent");
            expect(JSON.parse(publicResult.content[0].text)).toEqual(detail
                ? JSON.parse(raw!.content[0].text)
                : { x: 3, y: 4 });
            // Start dispatch probes the native broker presentation before the
            // public action formatter compacts cursor coordinates to {x,y}.
            const invoke = vi.fn(async () => presented);
            let clock = 500;
            const original = start();
            expect(await finishStartReadiness(original, { deviceId: device.id, bootTimeoutMs: 1000 }, 0, invoke, {
                now: () => clock, sleep: async (ms: number) => { clock += ms; },
            })).toBe(original);
            expect(invoke).toHaveBeenCalledTimes(1);
        }
        expect(native).toHaveBeenCalledTimes(1);
    });
});
