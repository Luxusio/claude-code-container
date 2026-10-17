import { describe, expect, it, vi } from "vitest";
import { waitForMacosGuestHelper } from "@ccc/device-lab/providers/backends/macos-vm.mjs";

const refused = { ok: false, error: "macos-helper-scp-failed", command: { status: 255, stderr: "ssh: connect to host 10.0.0.2 port 22: Connection refused" } };
describe("macOS start helper provisioning", () => {
    it("retries SSH startup under the original deadline without restarting the VM", async () => {
        let clock = 700;
        const provision = vi.fn().mockReturnValueOnce(refused).mockReturnValueOnce({ ok: true, provisioning: { status: "provisioned" } });
        const device = { id: "mac-test" };
        const observed = await waitForMacosGuestHelper(device, 2000, {
            provision, now: () => clock, delay: async (ms: number) => { clock += ms; },
        });
        expect(observed.ok).toBe(true);
        expect(provision.mock.calls).toEqual([[device, { deadlineAt: 2000 }], [device, { deadlineAt: 2000 }]]);
        expect(clock).toBe(1200);
    });
    it("does not reset an exhausted boot budget for provisioning", async () => {
        const provision = vi.fn();
        const observed = await waitForMacosGuestHelper({}, 2000, { provision, now: () => 2000 });
        expect(observed.error).toBe("macos-helper-readiness-timeout");
        expect(provision).not.toHaveBeenCalled();
    });
    it("bounds repeated connection failures by the remaining boot budget", async () => {
        let clock = 700;
        const provision = vi.fn(() => refused);
        const observed = await waitForMacosGuestHelper({}, 1000, {
            provision, now: () => clock, delay: async (ms: number) => { clock += ms; },
        });
        expect(observed.error).toBe("macos-helper-readiness-timeout");
        expect(provision).toHaveBeenCalledTimes(1);
        expect(clock).toBe(1000);
    });
    it("does not retry invalid keys or authentication failure", async () => {
        for (const failure of [{ ok: false, error: "invalid-key" }, { ...refused, command: { status: 255, stderr: "Permission denied (publickey,password)." } }]) {
            const provision = vi.fn(() => failure);
            expect(await waitForMacosGuestHelper({}, 1000, { provision, now: () => 0 })).toBe(failure);
            expect(provision).toHaveBeenCalledTimes(1);
        }
    });
    it("rejects provisioning success that arrives after its deadline", async () => {
        let clock = 0;
        const observed = await waitForMacosGuestHelper({}, 1000, {
            provision: () => { clock = 1001; return { ok: true }; }, now: () => clock,
        });
        expect(observed.error).toBe("macos-helper-readiness-timeout");
    });
    it("keeps the exported numeric deadline and injected legacy callback shape as Unix time", async () => {
        const unix = Date.parse("2026-10-17T12:00:00.000Z"), device = { id: "legacy" };
        let clock = unix;
        const delay = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
        const provision = vi.fn().mockReturnValueOnce(refused).mockReturnValueOnce({ ok: true, provisioning: { updatedAt: new Date(unix).toISOString() } });
        const result = await waitForMacosGuestHelper(device, unix + 700, { now: () => clock, provision, delay });
        expect(result.ok).toBe(true);
        expect(provision.mock.calls).toEqual([[device, { deadlineAt: unix + 700 }], [device, { deadlineAt: unix + 700 }]]);
        expect(delay.mock.calls).toEqual([[500]]);
    });
    it("preserves a genuine legacy provisioning failure that arrives after its numeric deadline", async () => {
        let clock = 0;
        const native = { ok: false, error: "macos-helper-chmod-failed", command: { status: 9, stderr: "Permission denied" } };
        const delay = vi.fn();
        const result = await waitForMacosGuestHelper({}, 1000, {
            now: () => clock, provision: () => { clock = 1001; return native; }, delay,
        });
        expect(result).toBe(native);
        expect(delay).not.toHaveBeenCalled();
    });
    it.each(["scp", "chmod"])("keeps legacy transient %s failure at numeric expiry as timeout with its original callback shape", async stage => {
        const unix = Date.parse("2026-10-17T12:00:00.000Z"), device = { id: "legacy-expiry" };
        let clock = unix;
        const native = { ok: false, error: stage === "scp" ? "macos-helper-scp-failed" : "macos-helper-chmod-failed",
            command: { status: 255, stderr: "Connection refused" } };
        const provision = vi.fn(() => { clock = unix + 1001; return native; }), delay = vi.fn();
        const result = await waitForMacosGuestHelper(device, unix + 1000, { now: () => clock, provision, delay });
        expect(result).toMatchObject({ ok: false, error: "macos-helper-readiness-timeout" });
        expect(result).not.toBe(native);
        expect(provision.mock.calls).toEqual([[device, { deadlineAt: unix + 1000 }]]);
        expect(delay).not.toHaveBeenCalled();
    });
});
