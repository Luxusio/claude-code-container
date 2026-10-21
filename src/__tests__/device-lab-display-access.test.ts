import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ failure: false, missingOutput: false, emptyOutput: false, screenshotPath: "", unavailable: false,
    focusReceipt: { status: 1, stdout: "", stderr: "active-window-unavailable" } as { status: number | null; stdout: string; stderr: string },
    focusTimeouts: [] as number[],
}));
vi.mock("fs", async (original) => {
    const actual = await original<typeof import("fs")>();
    return {
        ...actual,
        existsSync: (path: import("fs").PathLike) =>
            ["/usr/bin/xdotool", "/bin/xdotool", "/usr/bin/scrot", "/bin/scrot"].includes(String(path)) ? !fixture.unavailable : actual.existsSync(path),
    };
});
vi.mock("@ccc/device-lab/providers/commands.mjs", async (original) => {
    const actual = await original<typeof import("@ccc/device-lab/providers/commands.mjs")>();
    const fs = await import("node:fs");
    return {
        ...actual,
        run: () => { throw new Error("display-access-must-not-run-pointer-commands"); },
        runWithTimeout: (command: string, args: string[], timeoutMs: number) => {
            if (command === "xdotool") {
                expect(args).toEqual(["getactivewindow"]);
                expect(timeoutMs).toBeGreaterThan(0);
                expect(timeoutMs).toBeLessThanOrEqual(1000);
                fixture.focusTimeouts.push(timeoutMs);
                return fixture.focusReceipt;
            }
            expect(command).toBe("scrot");
            expect(args.slice(0, 2)).toEqual(["-p", "-o"]);
            expect(timeoutMs).toBe(30_000);
            fixture.screenshotPath = args[2];
            if (fixture.failure) return { status: 7, stdout: "", stderr: "capture unavailable" };
            if (fixture.missingOutput) return { status: 0, stdout: "", stderr: "" };
            fs.writeFileSync(fixture.screenshotPath, fixture.emptyOutput ? Buffer.alloc(0) : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]));
            return { status: 0, stdout: "", stderr: "" };
        },
    };
});
import { existsSync } from "node:fs";
import { currentDisplayTarget, handleDisplayTool } from "@ccc/device-lab/providers/display/x11.mjs";

beforeEach(() => { fixture.failure = false; fixture.missingOutput = false; fixture.emptyOutput = false; fixture.screenshotPath = "";
    fixture.unavailable = false; fixture.focusReceipt = { status: 1, stdout: "", stderr: "active-window-unavailable" }; fixture.focusTimeouts.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("actual X11 display access facade", () => {
    it("refuses empty native capture bytes and disposes the allocated directory", async () => {
        fixture.emptyOutput = true;
        await expect(handleDisplayTool("display_screenshot", {})).resolves.toEqual({ isError: true, content: [{ type: "text", text: "x11-screenshot-output-missing" }] });
        expect(fixture.screenshotPath).not.toBe("");
        expect(existsSync(fixture.screenshotPath)).toBe(false);
        expect(existsSync(dirname(fixture.screenshotPath))).toBe(false);
    });

    it("returns the synchronous current target with its native metadata", () => {
        const target = currentDisplayTarget();
        expect(target).toMatchObject({ id: "x11-current-display", kind: "display", backend: "x11", creatable: false, lifecycle: "current", available: true,
            capabilities: expect.arrayContaining(["device_status", "device_screenshot", "display_screenshot"]), ownerId: expect.any(String), display: expect.any(String) });
    });

    it("regression: advertises focus after a bounded positive native active-window observation", () => {
        fixture.focusReceipt = { status: 0, stdout: " \n42\t", stderr: "native warning" };
        const target = currentDisplayTarget();
        expect(target.available).toBe(true);
        expect(target.capabilities).toContain("device_focus_window");
        expect(target.capabilities).toContain("device_window_list");
        expect(fixture.focusTimeouts).toHaveLength(1);
    });

    it.each([
        { status: 1, stdout: "42", stderr: "no active-window support" },
        { status: null, stdout: "42", stderr: "probe interrupted" },
        ...["", "0", "-42", "042", "42\n43", "123456789012345678901", "not-a-window"].map(stdout => ({ status: 0, stdout, stderr: "" })),
    ])("regression: omits focus after an unqualified native observation $status/$stdout while preserving display availability", receipt => {
        fixture.focusReceipt = receipt;
        const target = currentDisplayTarget();
        expect(target.available).toBe(true);
        expect(target.capabilities).not.toContain("device_focus_window");
        expect(target.capabilities).toContain("device_key");
        expect(fixture.focusTimeouts).toHaveLength(1);
    });

    it("regression: an unavailable display stays unavailable independently of focus support", () => {
        fixture.unavailable = true;
        const target = currentDisplayTarget();
        expect(target.available).toBe(false);
        expect(target.capabilities).not.toContain("device_focus_window");
    });

    it("returns captured bytes through the native guarded image reader and disposes the allocated directory", async () => {
        const result = await handleDisplayTool("display_screenshot", {});
        expect(result).toEqual({ content: [{ type: "image", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]).toString("base64") }] });
        expect(fixture.screenshotPath).not.toBe("");
        expect(existsSync(fixture.screenshotPath)).toBe(false);
        expect(existsSync(dirname(fixture.screenshotPath))).toBe(false);
    });

    it("retains capture failure and still disposes the allocated directory", async () => {
        fixture.failure = true;
        const result = await handleDisplayTool("display_screenshot", {});
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result)).toContain("capture unavailable");
        expect(fixture.screenshotPath).not.toBe("");
        expect(existsSync(dirname(fixture.screenshotPath))).toBe(false);
    });

    it("refuses a successful capture without output and disposes the allocated directory", async () => {
        fixture.missingOutput = true;
        const result = await handleDisplayTool("display_screenshot", {});
        expect(result).toEqual({ isError: true, content: [{ type: "text", text: "x11-screenshot-output-missing" }] });
        expect(fixture.screenshotPath).not.toBe("");
        expect(existsSync(fixture.screenshotPath)).toBe(false);
        expect(existsSync(dirname(fixture.screenshotPath))).toBe(false);
    });
});
