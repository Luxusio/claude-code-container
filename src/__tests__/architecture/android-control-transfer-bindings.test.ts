import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandReceipt } from "../../../packages/device-lab/providers/ports/android-control-transfer.mjs";
import { androidControlObservation } from "../../../packages/device-lab/providers/adapters/android-control-transfer.mjs";

type NativeToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type AndroidControlHandler = (name: string, args: Record<string, unknown>) => Promise<NativeToolResult | undefined>;

const { jsonResult, textResult, MCP_ERROR_TEXT_LIMIT_BYTES } = await vi.importActual<{
    jsonResult(value: unknown): NativeToolResult;
    textResult(ok: boolean, text: string): NativeToolResult;
    MCP_ERROR_TEXT_LIMIT_BYTES: number;
}>("../../../packages/device-lab/providers/responses.mjs");

const native = vi.hoisted(() => ({
    result: { status: 0, stdout: "native output", stderr: "native diagnostic" } as CommandReceipt,
    leaseLost: false,
    run: vi.fn<(_executable: string, _args: string[]) => CommandReceipt>(),
    timed: vi.fn<(_executable: string, _args: string[], _budget: number) => CommandReceipt>(),
    heartbeat: vi.fn<(_backend: string, _serial: string, _id: string, _claim: { claimId: string; claimNonce: string }) => object>(),
    disposeInput: vi.fn<() => void>(),
    disposeOutput: vi.fn<() => void>(),
    stageInput: vi.fn<(_value: unknown) => { ok: true; path: string; stagedPath: string; cleanup(): void }>(),
    stageOutput: vi.fn<(_value: unknown) => { ok: true; path: string; stagedPath: string; cleanup(): void }>(),
    commit: vi.fn<(_stage: object) => { ok: true; path: string } | { ok: false; message: string }>(),
}));

vi.mock("../../../packages/device-lab/providers/commands.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    commandPath: (name: string) => `/fixture/${name}`,
    run: native.run,
    runWithTimeout: native.timed,
    runBuffer: () => { throw new Error("unexpected binary provider call"); },
    runWithInput: () => { throw new Error("unexpected streamed provider call"); },
}));
vi.mock("../../../packages/device-lab/providers/state/android-state.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    findAndroidDevice: (id: unknown) => id === "emulator-owned" ? { id, port: 5580, status: "running" } : undefined,
}));
vi.mock("../../../packages/device-lab/providers/state/android-device-state.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    findAndroidRealDevice: (id: unknown) => id === "physical-owned"
        ? { id, serial: "USB-owned", status: "running", leaseClaimId: "exact-claim", leaseClaimNonce: "exact-nonce" } : undefined,
}));
vi.mock("../../../packages/device-lab/providers/state/device-store.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    withOwnerDeviceOperation: (_backend: string, _id: string, operation: () => unknown) => operation(),
}));
vi.mock("../../../packages/device-lab/providers/state/physical-lease-store.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    heartbeatPhysicalLease: native.heartbeat,
}));
vi.mock("../../../packages/device-lab/providers/transfer-file.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    stageLocalInputFile: native.stageInput,
    createLocalOutputStage: native.stageOutput,
    commitLocalOutputStage: native.commit,
}));

// Exercise the real native handlers without adding their legacy implementation graph
// to strict inward contracts; genuine package export consumers are checked separately.
const { handleAndroidTool }: { handleAndroidTool: AndroidControlHandler } = await import(
    new URL("../../../packages/device-lab/providers/backends/android.mjs", import.meta.url).href
);
const { handleAndroidRealTool }: { handleAndroidRealTool: AndroidControlHandler } = await import(
    new URL("../../../packages/device-lab/providers/backends/android-device.mjs", import.meta.url).href
);

beforeEach(() => {
    vi.resetAllMocks();
    native.result = { status: 0, stdout: "native output", stderr: "native diagnostic" };
    native.leaseLost = false;
    native.run.mockImplementation(() => native.result);
    native.timed.mockImplementation(() => native.result);
    native.heartbeat.mockImplementation(() => native.leaseLost ? { ok: false, error: "successor claim" } : { ok: true, lease: {} });
    native.stageInput.mockImplementation(() => ({ ok: true, path: "/local/input", stagedPath: "/stage/input", cleanup: native.disposeInput }));
    native.stageOutput.mockImplementation(() => ({ ok: true, path: "/local/output", stagedPath: "/stage/output", cleanup: native.disposeOutput }));
    native.commit.mockImplementation(() => ({ ok: true, path: "/local/committed" }));
});

function payload(result: { content: readonly { text?: string }[]; isError?: boolean } | undefined) {
    expect(result?.isError).toBe(false);
    const text = result?.content[0]?.text;
    if (typeof text !== "string") throw new Error("missing native control response");
    return JSON.parse(text);
}

function cleanupPayload(result: NativeToolResult | undefined) {
    expect(result?.isError).toBe(true);
    const text = result?.content[0]?.text;
    if (typeof text !== "string") throw new Error("missing native cleanup response");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_ERROR_TEXT_LIMIT_BYTES);
    return { text, value: JSON.parse(text) };
}

describe("Android control native normalization", () => {
    it("uses only status zero while preserving the exact native receipt", () => {
        const receipt = Object.freeze({ status: 0, signal: "SIGTERM", error: { message: "diagnostic only" }, stdout: "opaque output" });
        const result = androidControlObservation(receipt);
        expect(result).toEqual({ ok: true, evidence: receipt });
        expect(result.evidence).toBe(receipt);
        for (const status of [null, 7]) expect(androidControlObservation({ status, stdout: "success-looking output" })).toMatchObject({ ok: false });
    });
});

describe.each([
    { variant: "emulator" as const, backend: "android-emulator", deviceId: "emulator-owned", serial: "emulator-5580", invoke: handleAndroidTool },
    { variant: "physical" as const, backend: "android-device", deviceId: "physical-owned", serial: "USB-owned", invoke: handleAndroidRealTool },
])("Android $variant control backend bindings", ({ variant, backend, deviceId, serial, invoke }) => {
    it("preserves status-zero success with native error/signal and encodes text and zero key", async () => {
        native.result = Object.freeze({ status: 0, stdout: "native output", stderr: "native diagnostic", signal: "SIGTERM", error: { message: "diagnostic only" } });
        expect(payload(await invoke("mobile_tap", { backend, deviceId, x: 0, y: 2 })))
            .toEqual({ tapped: { x: 0, y: 2 }, provider: "adb", stdout: "native output", stderr: "native diagnostic", status: 0 });
        payload(await invoke("mobile_type_text", { backend, deviceId, text: "한글 two\tlines\nnext" }));
        expect(native.run).toHaveBeenLastCalledWith("/fixture/adb", ["-s", serial, "shell", "input", "text", "한글%stwo%slines%snext"]);
        for (const text of [42, undefined]) {
            payload(await invoke("mobile_type_text", { backend, deviceId, text }));
            expect(native.run).toHaveBeenLastCalledWith("/fixture/adb", ["-s", serial, "shell", "input", "text", String(text)]);
        }
        expect(payload(await invoke("mobile_key", { backend, deviceId, key: "HOME", keyCode: 0 }))).toMatchObject({ key: 0 });
        expect(native.run).toHaveBeenLastCalledWith("/fixture/adb", ["-s", serial, "shell", "input", "keyevent", "0"]);
        payload(await invoke("mobile_key", { backend, deviceId, key: "arbitrary-key" }));
        expect(native.run).toHaveBeenLastCalledWith("/fixture/adb", ["-s", serial, "shell", "input", "keyevent", "arbitrary-key"]);
        expect(native.result).toMatchObject({ status: 0, signal: "SIGTERM", error: { message: "diagnostic only" } });
    });

    it("materializes the native navigation code and preserves its variant-specific payload", async () => {
        expect(payload(await invoke("mobile_home", { backend, deviceId }))).toEqual({
            ...(variant === "physical" ? { key: 3 } : { home: true }),
            provider: "adb", stdout: "native output", stderr: "native diagnostic", status: 0,
        });
        expect(native.run).toHaveBeenLastCalledWith("/fixture/adb", ["-s", serial, "shell", "input", "keyevent", "3"]);
    });

    it("omits both native streams and status after a successful double tap", async () => {
        expect(payload(await invoke("mobile_double_tap", { backend, deviceId, x: 1, y: 2 })))
            .toEqual({ doubleTapped: { x: 1, y: 2 }, provider: "adb" });
        expect(native.run).toHaveBeenCalledTimes(2);
    });

    it("retains the failed second tap diagnostic", async () => {
        native.run.mockReturnValueOnce(native.result).mockReturnValueOnce({ status: 9, stderr: "second tap denied" });
        const result = await invoke("mobile_double_tap", { backend, deviceId, x: 1, y: 2 });
        expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Error: second tap denied" }] });
        expect(native.run).toHaveBeenCalledTimes(2);
    });

    it("disables auto rotation before materializing rotation and preserves gesture defaults", async () => {
        expect(payload(await invoke("mobile_rotate_right", { backend, deviceId }))).toEqual({
            orientation: "reverse-landscape", rotation: "3", provider: "adb", stdout: "native output", stderr: "native diagnostic", status: 0,
        });
        expect(native.run.mock.calls).toEqual([
            ["/fixture/adb", ["-s", serial, "shell", "settings", "put", "system", "accelerometer_rotation", "0"]],
            ["/fixture/adb", ["-s", serial, "shell", "settings", "put", "system", "user_rotation", "3"]],
        ]);
        payload(await invoke("mobile_long_press", { backend, deviceId, x: 5, y: 6 }));
        expect(native.run).toHaveBeenLastCalledWith("/fixture/adb", ["-s", serial, "shell", "input", "swipe", "5", "6", "5", "6", "700"]);
    });

    it.each(["upload", "download"] as const)("retains completed %s in the public response after local cleanup fails", async operation => {
        const cleanup = Object.assign(new Error("private cleanup /stage/secret"), { code: "EACCES", path: "/stage/secret", data: "private-data" });
        (operation === "upload" ? native.disposeInput : native.disposeOutput).mockImplementation(() => { throw cleanup; });
        const response = cleanupPayload(await invoke(operation === "upload" ? "device_upload" : "device_download", {
            backend, deviceId, localPath: "/requested/file", remotePath: "/sdcard/file",
        }));
        const ordinary = jsonResult({
            ...(operation === "upload"
                ? { uploaded: { localPath: "/local/input", remotePath: "/sdcard/file" } }
                : { downloaded: { remotePath: "/sdcard/file", localPath: "/local/committed" } }),
            provider: "adb", stdout: "native output", stderr: "native diagnostic", status: 0,
        });
        expect(response.value).toEqual({ ok: false, error: "android-transfer-cleanup-failed",
            cause: { kind: "completed", result: ordinary }, cleanup: { operation: "local", failed: true, code: "EACCES" },
            result: { kind: "completed", completed: true },
        });
        for (const secret of ["private cleanup", "/stage/secret", "private-data"]) expect(response.text).not.toContain(secret);
        expect(native.timed).toHaveBeenCalledOnce();
        expect(native.disposeInput).toHaveBeenCalledTimes(operation === "upload" ? 1 : 0);
        expect(native.disposeOutput).toHaveBeenCalledTimes(operation === "download" ? 1 : 0);
        if (operation === "download") expect(native.commit).toHaveBeenCalledExactlyOnceWith(native.stageOutput.mock.results[0]?.value, { label: "download-local-path" });
        else expect(native.commit).not.toHaveBeenCalled();
    });

    it.each(["upload", "download"] as const)("retains the original native %s failure alongside a safe local-cleanup diagnostic", async operation => {
        native.result = { status: 9, stderr: "native transfer denied" };
        (operation === "upload" ? native.disposeInput : native.disposeOutput).mockImplementation(() => { throw { code: "EBUSY", private: "/stage/failure" }; });
        const response = cleanupPayload(await invoke(operation === "upload" ? "device_upload" : "device_download", {
            backend, deviceId, localPath: "/requested/file", remotePath: "/sdcard/file",
        }));
        expect(response.value).toEqual({ ok: false, error: "android-transfer-cleanup-failed",
            cause: { kind: "command-failure", result: textResult(false, "Error: native transfer denied") },
            cleanup: { operation: "local", failed: true, code: "EBUSY" },
        });
        expect(response.text).not.toContain("/stage/failure");
        expect(native.timed).toHaveBeenCalledOnce();
        expect(native.commit).not.toHaveBeenCalled();
    });

    it("retains a publication refusal in the public response when output-stage cleanup also fails", async () => {
        native.commit.mockReturnValue({ ok: false, message: "destination changed" });
        native.disposeOutput.mockImplementation(() => { throw { code: "EPERM" }; });
        const response = cleanupPayload(await invoke("device_download", { backend, deviceId, localPath: "/requested/file", remotePath: "/sdcard/file" }));
        expect(response.value).toEqual({ ok: false, error: "android-transfer-cleanup-failed",
            cause: { kind: "text", result: textResult(false, "destination changed") },
            cleanup: { operation: "local", failed: true, code: "EPERM" },
        });
        expect(native.timed).toHaveBeenCalledOnce(); expect(native.commit).toHaveBeenCalledOnce();
        expect(native.disposeOutput).toHaveBeenCalledOnce();
    });

    it.each(["upload", "download", "commit"] as const)("projects thrown %s and cleanup failures without exposing raw exception data", async phase => {
        const primary = Object.assign(new Error("private primary /internal/transfer"), { code: "EIO", path: "/internal/transfer" });
        const cleanup = Object.assign(new Error("private cleanup /internal/stage"), { code: "EACCES", path: "/internal/stage" });
        if (phase === "commit") native.commit.mockImplementation(() => { throw primary; });
        else native.timed.mockImplementation(() => { throw primary; });
        (phase === "upload" ? native.disposeInput : native.disposeOutput).mockImplementation(() => { throw cleanup; });
        const response = cleanupPayload(await invoke(phase === "upload" ? "device_upload" : "device_download", {
            backend, deviceId, localPath: "/requested/file", remotePath: "/sdcard/file",
        }));
        expect(response.value).toEqual({ ok: false, error: "android-transfer-cleanup-failed",
            cause: { kind: "thrown", code: "EIO" }, cleanup: { operation: "local", failed: true, code: "EACCES" },
        });
        expect(response.text).not.toContain("private"); expect(response.text).not.toContain("/internal/");
        expect(native.timed).toHaveBeenCalledOnce();
        expect(native.commit).toHaveBeenCalledTimes(phase === "commit" ? 1 : 0);
        expect(native.disposeInput).toHaveBeenCalledTimes(phase === "upload" ? 1 : 0);
        expect(native.disposeOutput).toHaveBeenCalledTimes(phase === "upload" ? 0 : 1);
    });

    it("keeps the completed destination marker after bounding a large native download receipt", async () => {
        native.result = { status: 0, stdout: "큰 native output\"".repeat(50000) };
        native.disposeOutput.mockImplementation(() => { throw { code: "EACCES", private: "/stage/secret" }; });
        const response = cleanupPayload(await invoke("device_download", { backend, deviceId, localPath: "/requested/file", remotePath: "/sdcard/file" }));
        expect(response.value).toMatchObject({ ok: false, error: "android-transfer-cleanup-failed", diagnosticTruncated: true,
            cause: { kind: "completed" }, cleanup: { operation: "local", failed: true, code: "EACCES" },
            result: { kind: "completed", completed: true },
        });
        expect(response.text).not.toContain("/stage/secret");
        expect(native.commit).toHaveBeenCalledOnce(); expect(native.disposeOutput).toHaveBeenCalledOnce();
    });

    it("uses owned transfer stages, the fixed native timeout and committed output path", async () => {
        expect(payload(await invoke("device_upload", { backend, deviceId, localPath: "/requested/input", remotePath: "/sdcard/file" })))
            .toEqual({ uploaded: { localPath: "/local/input", remotePath: "/sdcard/file" }, provider: "adb", stdout: "native output", stderr: "native diagnostic", status: 0 });
        expect(native.timed).toHaveBeenLastCalledWith("/fixture/adb", ["-s", serial, "push", "/stage/input", "/sdcard/file"], 300000);
        expect(native.disposeInput).toHaveBeenCalledOnce();
        expect(payload(await invoke("device_download", { backend, deviceId, localPath: "/requested/output", remotePath: "/sdcard/file" })))
            .toEqual({ downloaded: { remotePath: "/sdcard/file", localPath: "/local/committed" }, provider: "adb", stdout: "native output", stderr: "native diagnostic", status: 0 });
        expect(native.timed).toHaveBeenLastCalledWith("/fixture/adb", ["-s", serial, "pull", "/sdcard/file", "/stage/output"], 300000);
        expect(native.commit).toHaveBeenCalledWith(native.stageOutput.mock.results[0]?.value, { label: "download-local-path" });
        expect(native.disposeOutput).toHaveBeenCalledOnce();
    });
});

describe("Android physical control attachment guard", () => {
    it.each(["outer admission", "control target"])("refuses a lost exact lease at %s before control, validation or staging", async stage => {
        if (stage === "outer admission") native.leaseLost = true;
        else native.heartbeat.mockReturnValueOnce({ ok: true, lease: {} }).mockReturnValueOnce({ ok: false, error: "successor claim" });
        const result = await handleAndroidRealTool("device_upload", { backend: "android-device", deviceId: "physical-owned", remotePath: "relative" });
        expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("lease is not owned by this attachment") }] });
        expect(native.heartbeat).toHaveBeenCalledWith("android-device", "USB-owned", "physical-owned", { claimId: "exact-claim", claimNonce: "exact-nonce" });
        expect(native.run).not.toHaveBeenCalled();
        expect(native.timed).not.toHaveBeenCalled();
        expect(native.stageInput).not.toHaveBeenCalled();
    });
});
