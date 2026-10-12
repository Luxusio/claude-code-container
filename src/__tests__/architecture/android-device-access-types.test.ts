import { describe, expect, it } from "vitest";
import { createAndroidDeviceAccess, createAndroidAccessWait } from "../../../packages/device-lab/providers/application/android-device-access.mjs";
import type { AndroidEmulatorAccessPorts, AndroidPhysicalAccessPorts, AndroidAccessWaitPorts, AndroidAccessOutcome, AndroidTextWaitResult, AndroidAppWaitResult } from "../../../packages/device-lab/providers/ports/android-device-access.mjs";

function accessContracts(ports: AndroidEmulatorAccessPorts, physical: AndroidPhysicalAccessPorts) {
    const app = createAndroidDeviceAccess(ports);
    const observed: AndroidAccessOutcome | undefined = app.request("device_status", { deviceId: "guest" });
    const pending: Promise<AndroidAccessOutcome | undefined> = app.waitFor("mobile_wait_for_text", { deviceId: "guest", text: "needle" });
    const { capture, ...withoutCapture } = ports;
    // @ts-expect-error bounded binary screenshot observations are a required capability
    createAndroidDeviceAccess(withoutCapture);
    const { target, ...withoutTarget } = ports;
    // @ts-expect-error UI and waits require native guarded target selection
    createAndroidDeviceAccess(withoutTarget);
    const { refreshLease, ...withoutLease } = physical;
    // @ts-expect-error physical status requires exact native lease admission
    createAndroidDeviceAccess(withoutLease);
    // @ts-expect-error plain owned record observations are synchronous
    createAndroidDeviceAccess({ ...ports, device: async () => undefined });
    // @ts-expect-error native discovery observations are synchronous
    createAndroidDeviceAccess({ ...ports, discovery: async () => ({ adbAvailable: false, native: {} }) });
    // @ts-expect-error one-command native effects settle synchronously
    createAndroidDeviceAccess({ ...ports, executeShell: async () => ({ ok: true, value: undefined }) });
    // @ts-expect-error bounded binary observations settle synchronously
    createAndroidDeviceAccess({ ...ports, capture: async () => ({ kind: "image", data: "" }) });
    // @ts-expect-error physical lease observations cannot defer admission
    createAndroidDeviceAccess({ ...physical, refreshLease: async () => ({ ok: true }) });
    void [observed, pending, capture, target, refreshLease];
}

function waitContracts(ports: AndroidAccessWaitPorts<string>) {
    const app = createAndroidAccessWait(ports);
    const text: Promise<AndroidTextWaitResult> = app.text("target", "/sdcard/window.xml", "needle", 100, 10);
    const running: Promise<AndroidAppWaitResult> = app.app("target", "com.example.App", 100, 10);
    const { observeApp, ...withoutCommand } = ports;
    // @ts-expect-error wait-only policy still requires one native timed command capability
    createAndroidAccessWait(withoutCommand);
    const { budget, ...withoutBudget } = ports;
    // @ts-expect-error a shared bounded wait budget is required
    createAndroidAccessWait(withoutBudget);
    // @ts-expect-error native timed command observations remain synchronous
    createAndroidAccessWait({ ...ports, observeApp: async () => ({ ok: false, diagnostic: {} }) });
    // @ts-expect-error the budget observation is acquired synchronously
    createAndroidAccessWait({ ...ports, budget: async () => ({ timeoutMs: 100, remaining: () => 0, requestTimeout: () => 0, pause: async () => undefined }) });
    void [text, running, observeApp, budget];
}
void [accessContracts, waitContracts];

describe("Android device access asynchronous wait consumer", () => {
    it("retains the admitted PID result that completes exactly at the deadline", async () => {
        let remaining = 100;
        const ports: AndroidAccessWaitPorts<string> = {
            budget: () => ({ timeoutMs: 100, remaining: () => remaining, requestTimeout: () => remaining,
                pause: async () => { throw new Error("successful-terminal-observation-must-not-pause"); } }),
            dumpUi: () => { throw new Error("app-wait-must-not-dump"); },
            readUi: () => { throw new Error("app-wait-must-not-read-ui"); },
            observeApp: (_target, _package, timeoutMs) => {
                if (remaining <= 0) throw new Error("deadline-must-not-admit-another-command");
                expect(timeoutMs).toBe(100);
                remaining = 0;
                return { ok: true, value: { running: true, pid: "123", diagnostic: "terminal" } };
            },
        };
        const observed: Promise<AndroidAppWaitResult> = createAndroidAccessWait(ports).app("target", "com.example.App", 100, 10);
        expect(await observed).toEqual({ running: true, pid: "123", diagnostic: "terminal" });
    });
});
