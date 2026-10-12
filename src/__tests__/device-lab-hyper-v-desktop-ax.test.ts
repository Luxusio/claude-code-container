import { describe, expect, it, vi } from "vitest";
import { createHyperVWindowsClient, type HyperVWindowsExecutionRequest } from "@ccc/hyper-v/low-level/index.js";
import { linuxFocusWindowCommand, windowsFocusWindowCommand, parseGuestFocusWindow, windowsWindowListCommand } from "@ccc/device-lab/device-lab/broker/hyper-v/window-list.js";
const identity = { selector: { kind: "id" as const, id: "12345678-1234-1234-1234-123456789abc" }, expectedName: "owned", expectedNotes: "owner-record" };
const drag = { ...identity, action: "drag" as const, x: 0, y: 0, x2: 639, y2: 479, width: 640, height: 480, nativeWidth: 1920, nativeHeight: 1080, durationMs: 700 };
describe("Hyper-V desktop AX", () => {
    it("sends typed drag and rejects invalid endpoints and durations before native execution", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest) => ({ status: 0, stdout: JSON.stringify({schemaVersion:1,operation:request.operation,ok:true,items:[]}) }));
        const client = createHyperVWindowsClient({execute});
        await client.sendVMConsoleInput(drag);
        expect(execute.mock.calls[0][0]).toMatchObject(drag);
        for (const change of [{x2:640},{y2:480},{x2:-1},{y2:0.5},{durationMs:0},{durationMs:10001},{durationMs:NaN},{durationMs:1.5},{nativeWidth:0},{width:800}]) {
            await expect(client.sendVMConsoleInput({...drag,...change})).rejects.toMatchObject({category:"validation"});
        }
        expect(execute).toHaveBeenCalledTimes(1);
    });
    it("uses verified interactive Windows user, session and actual foreground result", () => {
        const command = windowsFocusWindowCommand("42");
        expect(command.length).toBeLessThanOrEqual(4096);
        expect(windowsWindowListCommand().length).toBeLessThanOrEqual(4096);
    });
    it("uses managed guest X11, waits for focus, and rejects shell input", () => {
        const command = linuxFocusWindowCommand("42");
        expect(command).toContain("sudo -n -u ccc-desktop env DISPLAY=:0 XAUTHORITY=/home/ccc-desktop/.Xauthority");
        expect(command).toContain("windowactivate --sync 42");
        expect(command).toContain('getactivewindow)" = "42"');
        for (const handle of ["0", "-1", "42;id", "$(id)", "1.5", "9999999999999999"]) {
            expect(() => linuxFocusWindowCommand(handle)).toThrow("window-handle-invalid");
            expect(() => windowsFocusWindowCommand(handle)).toThrow("window-handle-invalid");
        }
    });
    it("refuses guest false success or denied focus", () => {
        expect(parseGuestFocusWindow('{"ok":true}')).toEqual({ok:true});
        for (const stdout of ["", "{}", '{"ok":false}', "x".repeat(2049)]) expect(() => parseGuestFocusWindow(stdout)).toThrow("window-focus-invalid-result");
        expect(() => parseGuestFocusWindow('{"error":"window-focus-denied"}')).toThrow("window-focus-denied");
    });
});
