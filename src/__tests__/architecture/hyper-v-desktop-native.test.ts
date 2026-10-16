import { describe, expect, it, vi } from "vitest";
import { observeDesktopDirect, observeDesktopExecution, desktopGuestCommand, desktopRemoteReadCommand, desktopReceiptPresentation } from "../../../packages/device-lab/src/device-lab/broker/hyper-v/desktop-native.js";
import { createHyperVDesktopTransferApplication } from "../../../packages/device-lab/src/device-lab/application/hyper-v-desktop-transfer.js";
import type { DesktopDirectObservation, DesktopExecution, DesktopReceipt } from "../../../packages/device-lab/src/device-lab/domain/hyper-v-desktop-transfer.js";
import type { HyperVDesktopTransferPorts } from "../../../packages/device-lab/src/device-lab/ports/hyper-v-desktop-transfer.js";

function fixture(backend: "windows-vm" | "linux-vm" = "windows-vm") {
    const roots = { deviceRoot: "/owned", privateRoot: "/owned/private", credentialPath: "/owned/private/guest", sshPrivateKeyPath: "/owned/private/key", sshHostPublicKeyPath: "/owned/private/host", knownHostsPath: "/owned/private/known" };
    const device = { vmId: "12345678-1234-1234-1234-123456789abc", vmName: "owned-vm", diskPath: "/owned/disk", ...roots, sshKnownHostsPath: roots.knownHostsPath, guestCredentialPath: roots.credentialPath, guestUsername: "ccc-desktop", networkAddress: "172.29.0.10", sshHostKeyFingerprint: "SHA256:" + "a".repeat(43) };
    const receipt = Object.freeze({}) as DesktopReceipt;
    const execution = vi.fn(async (): Promise<DesktopExecution> => ({ kind: "completed", action: "upload", receipt }));
    const stage = { id: "owned-stage" };
    const ports = {
        executable: () => "powershell", incarnation: () => "incarnation", validIncarnation: (value: unknown): value is string => value === "incarnation",
        pendingJournal: () => false, repair: vi.fn(async () => ({ ok: true as const, device, reconciled: false })), ownershipNotes: () => "owned-notes",
        createConsole: () => ({}), withConsoleLock: async (_owner, _backend, _id, operation) => operation(),
        capture: vi.fn(), cursor: vi.fn(), vms: vi.fn(), input: vi.fn(), frame: () => null, rememberFrame: () => undefined, timestamp: () => "now",
        roots: () => roots, assertPrivateRoot: () => undefined, readableSecret: () => true, sshIdentity: () => true,
        localPath: () => "/destination", readSource: () => Buffer.from("abc"), allocateStage: vi.fn(() => ({ handle: stage, path: "/owned/private/stage" })),
        writeStage: vi.fn(() => undefined), readStage: vi.fn(() => Buffer.from("abc")), disposeStage: vi.fn(() => undefined), writeDestination: vi.fn(() => undefined),
        guestConnection: () => ({}), prepareGuestExec: vi.fn(() => execution), prepareUpload: () => execution, prepareRemoteRead: () => execution,
        direct: vi.fn(async (): Promise<DesktopDirectObservation> => ({ kind: "completed", action: "download", receipt, bytes: 3 })),
        stateErrorCode: () => null, providerError: () => null, boundedErrorCode: (_error, fallback) => fallback,
    } satisfies HyperVDesktopTransferPorts<object, typeof stage, Buffer, object>;
    const app = createHyperVDesktopTransferApplication(ports);
    const invoke = (tool = "device_download", params: Record<string, unknown> = {}) => app.invoke("owner", { deviceId: "device", tool, params, localPath: "/destination", remotePath: "/guest" }, { backend, stateKey: backend, device });
    return { ports, execution, receipt, stage, invoke };
}

describe("Hyper-V native desktop observations", () => {
    it("decodes Unicode binary download framing and rejects malformed framing", () => {
        const bytes = Buffer.from("한글\u0000abc");
        expect(observeDesktopExecution({ status: 0, stdout: bytes.toString("base64") }, "download")).toMatchObject({ kind: "completed", action: "download", artifact: bytes });
        for (const stdout of ["%%%", "YQ=", "YQ==\nnoise"]) expect(observeDesktopExecution({ status: 0, stdout }, "download")).toMatchObject({ kind: "completed", action: "download", artifactInvalid: true });
        expect(observeDesktopExecution({ status: 1, stdout: "%%%", error: "native-failed" }, "download")).toMatchObject({ kind: "failed", reason: "provider", category: "provider-failed" });
    });
    it("rejects a successful native action different from the requested download", () => {
        expect(observeDesktopDirect({ action: "exec", status: 0, stdout: "abc", stderr: "" }, { action: "download", localPath: "/stage", remotePath: "/guest", maxBytes: 8 })).toMatchObject({ kind: "failed", reason: "invalid-result" });
    });
    it("projects Windows windows and focus only from successful native guest results", () => {
        const action = { action: "exec" as const, command: "native-command" };
        expect(observeDesktopDirect({ action: "exec", status: 0, stdout: '{"windows":[{"handle":"42","title":"한글","processId":3,"extra":true}]}', stderr: "" }, action, { kind: "window-list" })).toMatchObject({ kind: "completed", windows: { windows: [{ handle: "42", title: "한글", processId: 3 }] } });
        expect(observeDesktopDirect({ action: "exec", status: 0, stdout: "{}", stderr: "" }, action, { kind: "window-list" })).toMatchObject({ kind: "window-failed", reason: "window-list-invalid-result" });
        expect(observeDesktopDirect({ action: "exec", status: 0, stdout: '{"error":"window-focus-denied"}', stderr: "" }, action, { kind: "focus", handle: "42" })).toMatchObject({ kind: "window-failed", reason: "window-focus-denied" });
        expect(observeDesktopDirect({ action: "exec", status: 9, stdout: "{}", stderr: "denied" }, action, { kind: "window-list" })).toMatchObject({ kind: "guest-failed", action: "exec" });
    });
    it("keeps native process data in an opaque receipt until outward presentation", () => {
        const native = { mode: "exec", provider: "hyper-v-ssh", status: 0, stdout: "guest output 한글", stderr: "guest error" };
        const observation = observeDesktopExecution(native, "exec");
        expect(observation).toMatchObject({ kind: "completed", action: "exec" });
        for (const key of ["mode", "provider", "status", "stdout", "stderr", "error", "result"]) expect(observation).not.toHaveProperty(key);
        expect(JSON.stringify(observation.receipt)).not.toContain("guest output");
        expect(desktopReceiptPresentation(observation.receipt)).toMatchObject({ kind: "execution", execution: native });
    });
    it("frames Unicode paths and keeps native commands inside guest limits", () => {
        const path = "/tmp/한글 ' $(id)";
        expect(desktopRemoteReadCommand(path, 8)).toContain(Buffer.from(path).toString("base64"));
        expect(desktopRemoteReadCommand(path, 8)).toContain("head -c 9");
        expect(desktopGuestCommand("windows-vm", { kind: "window-list" }).length).toBeLessThanOrEqual(4096);
        expect(desktopGuestCommand("windows-vm", { kind: "focus", handle: "42" }).length).toBeLessThanOrEqual(4096);
    });
});

describe("Hyper-V normalized native failure composition", () => {
    it("maps malformed Linux download to the established artifact failure without publication", async () => {
        const f = fixture("linux-vm");
        f.execution.mockResolvedValueOnce(observeDesktopExecution({ status: 0, stdout: "%%%" }, "download"));
        expect(await f.invoke()).toMatchObject({ kind: "failure", category: "provider-failed", facts: { error: "hyper-v-linux-guest-download-invalid-artifact" } });
        expect(f.ports.writeDestination).not.toHaveBeenCalled();
        expect(f.execution).toHaveBeenCalledTimes(1);
    });
    it.each([
        ["device_focus_window", "window-focus-denied", "focus"],
        ["device_window_list", "window-list-session-changed", "window-list"],
    ] as const)("preserves bounded native %s failure through the application", async (tool, code, kind) => {
        const f = fixture();
        const intent = kind === "focus" ? { kind, handle: "42" } : { kind };
        f.ports.direct.mockResolvedValueOnce(observeDesktopDirect({ action: "exec", status: 0, stdout: JSON.stringify({ error: code }), stderr: "" }, { action: "exec", command: "native-command" }, intent));
        expect(await f.invoke(tool, { handle: "42" })).toMatchObject({ kind: "failure", category: "provider-failed", facts: { error: code } });
        expect(f.ports.direct).toHaveBeenCalledTimes(1);
        expect(f.ports.writeDestination).not.toHaveBeenCalled();
    });
    it("normalizes arbitrary window error text instead of publishing a native diagnosis", async () => {
        const f = fixture();
        const secret = "native password=PRIVATE diagnostic";
        f.ports.direct.mockResolvedValueOnce(observeDesktopDirect({ action: "exec", status: 0, stdout: JSON.stringify({ error: secret }), stderr: "" }, { action: "exec", command: "native-command" }, { kind: "window-list" }));
        const outcome = await f.invoke("device_window_list");
        expect(outcome).toMatchObject({ kind: "failure", facts: { error: "window-list-invalid-result" } });
        expect(JSON.stringify(outcome)).not.toContain(secret);
    });
    it("keeps a nonzero guest exit separate from window framing failure", async () => {
        const f = fixture();
        f.ports.direct.mockResolvedValueOnce(observeDesktopDirect({ action: "exec", status: 9, stdout: '{"error":"window-focus-denied"}', stderr: "guest failed" }, { action: "exec", command: "native-command" }, { kind: "focus", handle: "42" }));
        expect(await f.invoke("device_focus_window", { handle: "42" })).toMatchObject({ kind: "failure", category: "guest-failed", facts: { error: "hyper-v-guest-command-failed" } });
    });
    it("uses recursive semantic windows and focus without constructing legacy payloads", async () => {
        const f = fixture("linux-vm");
        const listing = { windows: [{ handle: "42", title: "semantic 한글", processId: 3 }], truncated: true };
        f.execution.mockResolvedValueOnce({ kind: "completed", action: "exec", receipt: f.receipt, windows: listing });
        const windows = await f.invoke("device_window_list");
        expect(windows).toMatchObject({ kind: "success", completion: { kind: "window-list", deviceId: "device", listing } });
        expect(windows.facts).not.toHaveProperty("result");
        expect(f.ports.prepareGuestExec).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { kind: "window-list" });
        expect(f.ports.repair).toHaveBeenCalledTimes(2);
        f.execution.mockResolvedValueOnce({ kind: "completed", action: "exec", receipt: f.receipt, focused: true });
        expect(await f.invoke("device_focus_window", { handle: "42" })).toMatchObject({ kind: "success", completion: { kind: "focus", deviceId: "device" } });
        expect(f.ports.prepareGuestExec).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { kind: "focus", handle: "42" });
        expect(f.ports.repair).toHaveBeenCalledTimes(4);
    });
    it("passes an opaque receipt through guest completion without reading its properties", async () => {
        const f = fixture("linux-vm");
        const read = vi.fn(() => { throw new Error("application read native receipt"); });
        const receipt = new Proxy(Object.create(null), { get: read, ownKeys: read }) as DesktopReceipt;
        f.execution.mockResolvedValueOnce({ kind: "completed", action: "exec", receipt });
        const outcome = await f.invoke("device_exec", { command: "true" });
        expect(outcome).toMatchObject({ kind: "success", completion: { kind: "guest", action: "exec" } });
        expect(outcome.kind === "success" && outcome.completion.kind === "guest" && outcome.completion.receipt).toBe(receipt);
        expect(read).not.toHaveBeenCalled();
        expect(outcome.facts).not.toHaveProperty("result");
    });
    it("keeps a Linux native failure ahead of successful-looking focus output", async () => {
        const f = fixture("linux-vm");
        const observed = observeDesktopExecution({ status: 255, stdout: '{"ok":true}', stderr: "private provider output" }, "exec", { kind: "focus", handle: "42" });
        f.execution.mockResolvedValueOnce(observed);
        const result = await f.invoke("device_focus_window", { handle: "42" });
        expect(result).toMatchObject({ kind: "failure", category: "provider-failed", facts: { error: "hyper-v-linux-guest-provider-failed", tool: "device_focus_window" } });
        expect(result.kind === "failure" && result.receipt).toBe(observed.receipt);
        expect(result.facts).not.toHaveProperty("execution");
    });
});

describe("Hyper-V owned transfer stage lifetime", () => {
    it("disposes stage and refuses publication for a wrong Windows action", async () => {
        const f = fixture();
        f.ports.direct.mockResolvedValueOnce(observeDesktopDirect({ action: "upload", localPath: "/owned/private/stage", remotePath: "/guest", bytes: 3 }, { action: "download", localPath: "/owned/private/stage", remotePath: "/guest", maxBytes: 16 * 1024 * 1024 }));
        expect(await f.invoke()).toMatchObject({ kind: "failure" });
        expect(f.ports.writeDestination).not.toHaveBeenCalled();
        expect(f.ports.disposeStage).toHaveBeenCalledExactlyOnceWith(f.stage);
    });
    it("disposes Linux upload stage when prepared native execution throws", async () => {
        const f = fixture("linux-vm");
        f.execution.mockRejectedValueOnce(new Error("native disconnected"));
        expect(await f.invoke("device_upload")).toMatchObject({ kind: "failure" });
        expect(f.ports.disposeStage).toHaveBeenCalledExactlyOnceWith(f.stage);
        expect(f.ports.writeDestination).not.toHaveBeenCalled();
    });
    it("preserves primary and cleanup failure together", async () => {
        const f = fixture("linux-vm");
        f.execution.mockRejectedValueOnce(new Error("native disconnected"));
        f.ports.disposeStage.mockImplementationOnce(() => { throw new Error("stage locked"); });
        const result = await f.invoke("device_upload");
        expect(result).toMatchObject({ kind: "failure", cleanup: { error: "stage locked", publicationCompleted: false, primary: { kind: "failure" } } });
        expect(JSON.stringify(result)).toContain("native disconnected");
        expect(f.ports.disposeStage).toHaveBeenCalledTimes(1);
    });
    it("retains completed publication evidence when disposal fails", async () => {
        const f = fixture();
        f.ports.disposeStage.mockImplementationOnce(() => { throw new Error("stage locked"); });
        expect(await f.invoke()).toMatchObject({ kind: "failure", cleanup: { publicationCompleted: true, primary: { kind: "success", completion: { kind: "guest", transfer: { localPath: "/destination", bytes: 3 } } } } });
        expect(f.ports.writeDestination).toHaveBeenCalledExactlyOnceWith("/destination", Buffer.from("abc"), "hyper-v-guest-download");
    });
    it("refuses invalid stored private incarnation before native execution or allocation", async () => {
        const f = fixture();
        f.ports.incarnation = () => "invalid-private-generation";
        expect(await f.invoke("device_download")).toMatchObject({ kind: "failure", category: "conflict" });
        expect(f.ports.allocateStage).not.toHaveBeenCalled();
        expect(f.ports.direct).not.toHaveBeenCalled();
    });
    it("checks staged byte count before publication and always disposes", async () => {
        const f = fixture();
        f.ports.readStage.mockReturnValueOnce(Buffer.from("different"));
        expect(await f.invoke()).toMatchObject({ kind: "failure", facts: { error: "hyper-v-guest-download-invalid-artifact" } });
        expect(f.ports.writeDestination).not.toHaveBeenCalled();
        expect(f.ports.disposeStage).toHaveBeenCalledExactlyOnceWith(f.stage);
    });
    it("refuses a failed destination commit and disposes the observed download stage", async () => {
        const f = fixture();
        f.ports.writeDestination.mockImplementationOnce(() => { throw new Error("destination is read-only"); });
        expect(await f.invoke()).toMatchObject({ kind: "failure", category: "provider-failed", facts: { error: "hyper-v-guest-download-invalid-artifact" } });
        expect(f.ports.readStage).toHaveBeenCalledExactlyOnceWith(f.stage, 16 * 1024 * 1024);
        expect(f.ports.writeDestination).toHaveBeenCalledTimes(1);
        expect(f.ports.disposeStage).toHaveBeenCalledExactlyOnceWith(f.stage);
    });
    it("requires the current frame before pointer input", async () => {
        const f = fixture();
        expect(await f.invoke("device_click", { x: 1, y: 1 })).toMatchObject({ kind: "failure", category: "conflict", facts: { error: "hyper-v-console-screenshot-required" } });
        expect(f.ports.input).not.toHaveBeenCalled();
        expect(f.ports.direct).not.toHaveBeenCalled();
    });
    it("refuses Linux guest typing when the observed VM ownership identity differs", async () => {
        const f = fixture("linux-vm");
        f.ports.vms.mockResolvedValueOnce([{ id: "12345678-1234-1234-1234-123456789abc", name: "owned-vm", notes: "foreign-owner", state: "Running" }]);
        expect(await f.invoke("device_type", { text: "한글" })).toMatchObject({ kind: "failure", category: "conflict", facts: { error: "hyper-v-console-identity-mismatch" } });
        expect(f.execution).not.toHaveBeenCalled();
        expect(f.ports.input).not.toHaveBeenCalled();
        expect(f.ports.direct).not.toHaveBeenCalled();
    });
    it("uses deviceId alone and passes exact repaired VM and private incarnation authority to native download", async () => {
        const f = fixture();
        expect(await f.invoke()).toMatchObject({ kind: "success" });
        expect(f.ports.direct).toHaveBeenCalledWith("powershell", 30000, {
            selector: { kind: "id", id: "12345678-1234-1234-1234-123456789abc" }, expectedName: "owned-vm", expectedNotes: "owned-notes", credentialPath: "/owned/private/guest",
        }, { action: "download", localPath: "/owned/private/stage", remotePath: "/guest", maxBytes: 16 * 1024 * 1024 }, undefined);
    });
    it("disposes allocated stage when writing the upload stage fails", async () => {
        const f = fixture();
        f.ports.writeStage.mockImplementationOnce(() => { throw new Error("disk full"); });
        expect(await f.invoke("device_upload")).toMatchObject({ kind: "failure" });
        expect(f.ports.disposeStage).toHaveBeenCalledExactlyOnceWith(f.stage);
        expect(f.ports.direct).not.toHaveBeenCalled();
    });
    it("keeps Linux decoded bytes bounded before destination publication", async () => {
        const f = fixture("linux-vm");
        f.execution.mockResolvedValueOnce({ kind: "completed", action: "download", receipt: f.receipt, artifact: Buffer.alloc(9) });
        expect(await f.invoke("device_download", { maxFileBytes: 8 })).toMatchObject({ kind: "failure", category: "too-large" });
        expect(f.ports.writeDestination).not.toHaveBeenCalled();
        expect(f.execution).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 30000, outputLimit: 9 });
    });
});
