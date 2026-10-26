import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commands from "@ccc/device-lab/providers/commands.mjs";
import { handleIosTool } from "@ccc/device-lab/providers/backends/ios-simulator.mjs";
import { ownerId } from "@ccc/device-lab/providers/context.mjs";
import { jsonResult } from "@ccc/device-lab/providers/responses.mjs";
import * as iosState from "@ccc/device-lab/providers/state/ios-state.mjs";
import * as deviceStore from "@ccc/device-lab/providers/state/device-store.mjs";
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";
import { presentBrokerTool } from "../../device-lab-mcp/src/device-request-presenter.mjs";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";

type NativeReceipt = {
    status: number | null;
    signal?: string | null;
    timedOut?: boolean;
    stdout: string;
    stderr: string;
    error?: { code?: string; message?: string; path?: string; spawnargs?: string[] };
};

const privateOutput = "private output /Users/private/secret token=fixture-secret";
const privateCommand = "printf '%s' 'fixture-secret'";
const nativeFailure = (extra: Partial<NativeReceipt> = {}): NativeReceipt => ({
    status: 7, signal: null, stdout: privateOutput, stderr: "native command refused", ...extra,
});

describe("iOS observation failure evidence through native and MCP presentation", () => {
    let home: string;
    let restoreEnvironment: () => void;
    let receipt: NativeReceipt;
    let native: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ccc-ios-failure-evidence-"));
        restoreEnvironment = isolateDeviceLabTestEnvironment(home);
        const device = { id: "ios-evidence", udid: "EVIDENCE-UDID", simulatorName: `ccc-${ownerId()}-evidence` };
        receipt = nativeFailure();
        vi.spyOn(iosState, "findIosDevice").mockReturnValue(device);
        vi.spyOn(deviceStore, "withOwnerDeviceOperation").mockImplementation((_backend, _id, operation) => operation());
        vi.spyOn(commands, "commandPath").mockReturnValue("/fixture/xcrun");
        native = vi.spyOn(commands, "run").mockImplementation((_executable, args) => {
            if (JSON.stringify(args) === JSON.stringify(["simctl", "list", "devices", "-j"])) {
                return { status: 0, signal: null, stdout: JSON.stringify({ devices: { runtime: [{
                    udid: device.udid, name: device.simulatorName, state: "Booted",
                }] } }), stderr: "" };
            }
            expect(args).toEqual(["simctl", "spawn", device.udid, "/bin/sh", "-lc", privateCommand]);
            return receipt;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreEnvironment();
        rmSync(home, { recursive: true, force: true });
    });

    const cases = [
        { name: "nonzero exit", receipt: nativeFailure(), execution: { status: 7, signal: null, timedOut: false, errorCode: null, diagnosticCode: "native-nonzero-exit" } },
        { name: "native signal", receipt: nativeFailure({ status: null, signal: "SIGTERM" }), execution: { status: null, signal: "SIGTERM", timedOut: false, errorCode: null, diagnosticCode: "native-signal" } },
        { name: "explicit timeout", receipt: nativeFailure({ status: null, signal: "SIGTERM", timedOut: true }), execution: { status: null, signal: "SIGTERM", timedOut: true, errorCode: null, diagnosticCode: "native-timeout" } },
        { name: "native timeout errno", receipt: nativeFailure({ status: null, error: { code: "ETIMEDOUT" } }), execution: { status: null, signal: null, timedOut: true, errorCode: "ETIMEDOUT", diagnosticCode: "native-timeout" } },
        { name: "missing executable", receipt: nativeFailure({ status: null, error: { code: "ENOENT" } }), execution: { status: null, signal: null, timedOut: false, errorCode: "ENOENT", diagnosticCode: "native-not-found" } },
        { name: "native permission denial", receipt: nativeFailure({ status: null, error: { code: "EACCES" } }), execution: { status: null, signal: null, timedOut: false, errorCode: "EACCES", diagnosticCode: "native-permission-denied" } },
        { name: "operation permission denial", receipt: nativeFailure({ status: null, error: { code: "EPERM" } }), execution: { status: null, signal: null, timedOut: false, errorCode: "EPERM", diagnosticCode: "native-permission-denied" } },
        { name: "other known errno", receipt: nativeFailure({ status: null, error: { code: "EIO" } }), execution: { status: null, signal: null, timedOut: false, errorCode: "EIO", diagnosticCode: "native-unknown" } },
        { name: "unknown observation", receipt: nativeFailure({ status: null }), execution: { status: null, signal: null, timedOut: false, errorCode: null, diagnosticCode: "native-unknown" } },
    ];

    it.each(cases)("retains $name facts and existing failure content in detail and compact modes", async ({ receipt: failure, execution }) => {
        receipt = failure;
        const raw = await handleIosTool("device_exec", { deviceId: "ios-evidence", command: privateCommand });
        expect(native).toHaveBeenCalledTimes(2);
        expect(raw).toMatchObject({ isError: true, content: [{ type: "text", text: "Error: native command refused" }] });
        const expected = { ok: false, error: "provider-command-failed", execution };
        expect(raw?.structuredContent).toEqual(expected);

        // The broker presenter returns the actual native mcpResult carrier;
        // both public presentation modes must retain its standard MCP metadata.
        const presented = presentBrokerTool({ ok: true, result: { mcpResult: raw } }, {}, jsonResult);
        for (const detail of [true, false]) {
            const result = actionResult("exec", "device_exec", presented, { detail });
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toEqual(expected);
            expect(detail ? result.content[0].text : JSON.parse(result.content[0].text).error)
                .toBe("Error: native command refused");
            expect(JSON.stringify(result.structuredContent)).not.toContain(privateOutput);
            expect(JSON.stringify(result.structuredContent)).not.toContain(privateCommand);
        }
    });

    it("omits unrecognized signal, error code, paths and arguments from structured native evidence", async () => {
        receipt = nativeFailure({
            status: Number.MAX_SAFE_INTEGER + 1,
            signal: "SIG/private/sensitive",
            error: { code: "PRIVATE_SECRET", message: privateOutput, path: "/Users/private/secret", spawnargs: [privateCommand] },
        });
        const raw = await handleIosTool("device_exec", { deviceId: "ios-evidence", command: privateCommand });
        expect(raw?.structuredContent).toEqual({
            ok: false, error: "provider-command-failed",
            execution: { status: null, signal: null, timedOut: false, errorCode: null, diagnosticCode: "native-unknown" },
        });
        expect(raw?.content).toEqual([{ type: "text", text: "Error: native command refused" }]);
    });

    it.each([
        { receipt: nativeFailure({ stderr: "", stdout: "original native stdout" }), text: "Error: original native stdout" },
        { receipt: nativeFailure({ status: null, stderr: "", stdout: "", error: { code: "EIO", message: "original native error" } }), text: "Error: original native error" },
        { receipt: nativeFailure({ status: null, stderr: "", stdout: "", signal: "SIGTERM" }), text: "Error: signal SIGTERM" },
        { receipt: nativeFailure({ stderr: "", stdout: "" }), text: "Error: exit 7" },
    ])("preserves the original failure text fallback: $text", async ({ receipt: failure, text }) => {
        receipt = failure;
        const raw = await handleIosTool("device_exec", { deviceId: "ios-evidence", command: privateCommand });
        expect(raw).toMatchObject({ isError: true, content: [{ type: "text", text }] });
        const presented = presentBrokerTool({ ok: true, result: { mcpResult: raw } }, {}, jsonResult);
        for (const detail of [true, false]) {
            const result = actionResult("exec", "device_exec", presented, { detail });
            expect(detail ? result.content[0].text : JSON.parse(result.content[0].text).error).toBe(text);
            expect(result.isError).toBe(true);
        }
    });

    it("keeps successful native exec content and presentation unchanged without failure metadata", async () => {
        receipt = { status: 0, signal: null, stdout: "completed", stderr: "" };
        const raw = await handleIosTool("device_exec", { deviceId: "ios-evidence", command: privateCommand });
        expect(raw).toEqual(jsonResult({ stdout: "completed", stderr: "", status: 0 }));
        const presented = presentBrokerTool({ ok: true, result: { mcpResult: raw } }, {}, jsonResult);
        for (const detail of [true, false]) {
            const result = actionResult("exec", "device_exec", presented, { detail });
            expect(result.isError).toBe(false);
            expect(result).not.toHaveProperty("structuredContent");
            expect(JSON.parse(result.content[0].text)).toEqual({ stdout: "completed", stderr: "", status: 0 });
        }
    });
});
