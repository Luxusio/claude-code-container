import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ failure: false, screenshotPath: "" }));
vi.mock("fs", async (original) => {
    const actual = await original<typeof import("fs")>();
    return {
        ...actual,
        existsSync: (path: import("fs").PathLike) =>
            path === "/usr/bin/xdotool" || path === "/usr/bin/scrot" ? true : actual.existsSync(path),
    };
});
vi.mock("@ccc/device-lab/providers/commands.mjs", async (original) => {
    const actual = await original<typeof import("@ccc/device-lab/providers/commands.mjs")>();
    const fs = await import("node:fs");
    return {
        ...actual,
        run: () => { throw new Error("display-access-must-not-run-pointer-commands"); },
        runWithTimeout: (command: string, args: string[], timeoutMs: number) => {
            expect(command).toBe("scrot");
            expect(args.slice(0, 2)).toEqual(["-p", "-o"]);
            expect(timeoutMs).toBe(30_000);
            fixture.screenshotPath = args[2];
            if (fixture.failure) return { status: 7, stdout: "", stderr: "capture unavailable" };
            fs.writeFileSync(fixture.screenshotPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]));
            return { status: 0, stdout: "", stderr: "" };
        },
    };
});
import { existsSync } from "node:fs";
import { currentDisplayTarget, handleDisplayTool } from "@ccc/device-lab/providers/display/x11.mjs";

beforeEach(() => { fixture.failure = false; fixture.screenshotPath = ""; });
afterEach(() => { vi.restoreAllMocks(); });

describe("actual X11 display access facade", () => {
    it("returns the synchronous current target with its native metadata", () => {
        const target = currentDisplayTarget();
        expect(target).toMatchObject({ id: "x11-current-display", kind: "display", backend: "x11", creatable: false, lifecycle: "current", available: true,
            capabilities: expect.arrayContaining(["device_status", "device_screenshot", "display_screenshot"]), ownerId: expect.any(String), display: expect.any(String) });
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
});
