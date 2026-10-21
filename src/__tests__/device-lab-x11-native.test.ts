import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const isolated = vi.hoisted(() => ({ display: "", handlers: [] as any[], commands: [] as string[] }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: any) { isolated.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@ccc/device-lab/providers/commands.mjs", async original => {
    const actual = await original<typeof import("@ccc/device-lab/providers/commands.mjs")>();
    function optionsForOwnedDisplay(options: { env?: NodeJS.ProcessEnv } = {}) {
        if (!/^:\d+$/.test(isolated.display) || isolated.display === ":99") throw new Error("native-test-refuses-unowned-or-shared-display");
        return { ...options, env: { ...options.env, DISPLAY: isolated.display } };
    }
    return {
        ...actual,
        run: (command: string, args: string[], options = {}) => {
            isolated.commands.push(command);
            return actual.run(command, args, optionsForOwnedDisplay(options));
        },
        runWithTimeout: (command: string, args: string[], timeoutMs: number, options = {}) => {
            isolated.commands.push(command);
            return actual.runWithTimeout(command, args, timeoutMs, optionsForOwnedDisplay(options));
        },
    };
});

import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { currentDisplayTarget, handleDisplayTool } from "@ccc/device-lab/providers/display/x11.mjs";

// XSetInputFocus directs XTEST key events to this fixture's own window without a WM.
const WINDOW_PROGRAM = String.raw`
import ctypes, ctypes.util, json, os, select, sys
x = ctypes.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
Display = ctypes.c_void_p
Window = ctypes.c_ulong
x.XOpenDisplay.argtypes = [ctypes.c_char_p]; x.XOpenDisplay.restype = Display
x.XDefaultScreen.argtypes = [Display]; x.XDefaultScreen.restype = ctypes.c_int
x.XRootWindow.argtypes = [Display, ctypes.c_int]; x.XRootWindow.restype = Window
x.XCreateSimpleWindow.argtypes = [Display, Window, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
x.XCreateSimpleWindow.restype = Window
x.XSelectInput.argtypes = [Display, Window, ctypes.c_long]
x.XMapWindow.argtypes = [Display, Window]
x.XSetInputFocus.argtypes = [Display, Window, ctypes.c_int, ctypes.c_ulong]
x.XSync.argtypes = [Display, ctypes.c_int]
x.XPending.argtypes = [Display]; x.XPending.restype = ctypes.c_int
x.XDestroyWindow.argtypes = [Display, Window]
x.XCloseDisplay.argtypes = [Display]
class XKeyEvent(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
        ('display', Display), ('window', Window), ('root', Window), ('subwindow', Window),
        ('time', ctypes.c_ulong), ('x', ctypes.c_int), ('y', ctypes.c_int), ('x_root', ctypes.c_int),
        ('y_root', ctypes.c_int), ('state', ctypes.c_uint), ('keycode', ctypes.c_uint), ('same_screen', ctypes.c_int)]
class XEvent(ctypes.Union):
    _fields_ = [('type', ctypes.c_int), ('xkey', XKeyEvent), ('pad', ctypes.c_long * 24)]
x.XNextEvent.argtypes = [Display, ctypes.POINTER(XEvent)]
x.XLookupKeysym.argtypes = [ctypes.POINTER(XKeyEvent), ctypes.c_int]; x.XLookupKeysym.restype = ctypes.c_ulong
x.XKeysymToString.argtypes = [ctypes.c_ulong]; x.XKeysymToString.restype = ctypes.c_char_p
d = x.XOpenDisplay(os.environ['DISPLAY'].encode())
if not d: raise RuntimeError('owned display could not be opened')
w = x.XCreateSimpleWindow(d, x.XRootWindow(d, x.XDefaultScreen(d)), 20, 20, 200, 100, 0, 0, 0)
events = []
try:
    x.XSelectInput(d, w, (1 << 0) | (1 << 1))
    x.XMapWindow(d, w)
    x.XSync(d, 0)
    x.XSetInputFocus(d, w, 2, 0)
    x.XSync(d, 0)
    print(json.dumps({'ready': int(w)}), flush=True)
    while True:
        while x.XPending(d):
            event = XEvent(); x.XNextEvent(d, ctypes.byref(event))
            if event.type == 2:
                name = x.XKeysymToString(x.XLookupKeysym(ctypes.byref(event.xkey), 0))
                events.append(name.decode() if name else str(event.xkey.keycode))
        if select.select([sys.stdin], [], [], 0.02)[0]:
            command = sys.stdin.readline().strip()
            if command == 'snapshot':
                x.XSync(d, 0)
                while x.XPending(d):
                    event = XEvent(); x.XNextEvent(d, ctypes.byref(event))
                    if event.type == 2:
                        name = x.XKeysymToString(x.XLookupKeysym(ctypes.byref(event.xkey), 0))
                        events.append(name.decode() if name else str(event.xkey.keycode))
                print(json.dumps({'events': events}), flush=True)
            elif command == 'quit' or not command: break
finally:
    x.XDestroyWindow(d, w)
    x.XCloseDisplay(d)
`;

function lineReader(stream: Readable) {
    const lines = createInterface({ input: stream });
    const queued: string[] = [];
    let waiting: ((line: string) => void) | undefined;
    lines.on("line", line => {
        if (waiting) { const resolve = waiting; waiting = undefined; resolve(line); }
        else queued.push(line);
    });
    return {
        next: (timeoutMs = 5000) => queued.length ? Promise.resolve(queued.shift()!) : new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => { waiting = undefined; reject(new Error("owned-X11-fixture-output-timeout")); }, timeoutMs);
            waiting = line => { clearTimeout(timer); resolve(line); };
        }),
        close: () => lines.close(),
    };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
        const finish = (exited: boolean) => { clearTimeout(timer); child.removeListener("exit", exitedNormally); resolve(exited); };
        const exitedNormally = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", exitedNormally);
    });
}

async function stopOwned(child: ChildProcess | undefined) {
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (await waitForExit(child, 1500)) return;
    child.kill("SIGKILL");
    expect(await waitForExit(child, 1500), "the exact owned X11 child must terminate").toBe(true);
}

const nativeAvailable = process.platform === "linux"
    && ["/usr/bin/Xvfb", "/usr/bin/xdotool", "/usr/bin/scrot", "/usr/bin/python3"].every(path => existsSync(path));

describe.skipIf(!nativeAvailable)("isolated native X11 public input", () => {
    let displayServer: ChildProcess | undefined;
    let windowOwner: ChildProcess | undefined;
    let displayLines: ReturnType<typeof lineReader> | undefined;
    let windowLines: ReturnType<typeof lineReader> | undefined;
    let handle = "";
    let diagnostics = "";
    const call = (name: string, args: Record<string, unknown> = {}) => isolated.handlers[1]({ params: { name, arguments: {
        deviceId: "x11-current-display", implicitBroker: false, detail: true, ...args,
    } } });
    async function observedKeys(): Promise<string[]> {
        windowOwner!.stdin!.write("snapshot\n");
        return JSON.parse(await windowLines!.next()).events;
    }

    beforeAll(async () => {
        displayServer = spawn("/usr/bin/Xvfb", ["-displayfd", "3", "-screen", "0", "800x600x24", "-nolisten", "tcp", "-noreset"], {
            stdio: ["ignore", "ignore", "pipe", "pipe"],
        });
        displayServer.on("error", error => { diagnostics += error.message; });
        displayServer.stderr!.on("data", chunk => { diagnostics += String(chunk); });
        displayLines = lineReader(displayServer.stdio[3] as Readable);
        const number = await displayLines.next();
        expect(number, diagnostics).toMatch(/^\d+$/);
        isolated.display = `:${number}`;
        expect(isolated.display, "shared :99 must never receive fixture input").not.toBe(":99");
        windowOwner = spawn("/usr/bin/python3", ["-I", "-u", "-c", WINDOW_PROGRAM], {
            env: { ...process.env, DISPLAY: isolated.display }, stdio: ["pipe", "pipe", "pipe"],
        });
        windowOwner.on("error", error => { diagnostics += error.message; });
        windowOwner.stderr!.on("data", chunk => { diagnostics += String(chunk); });
        windowLines = lineReader(windowOwner.stdout!);
        handle = String(JSON.parse(await windowLines.next()).ready);
        expect(handle, diagnostics).toMatch(/^[1-9][0-9]*$/);
        await startServer();
    });

    afterAll(async () => {
        try {
            if (windowOwner?.exitCode === null && windowOwner.stdin?.writable) {
                windowOwner.stdin.write("quit\n");
                await waitForExit(windowOwner, 1500);
            }
        } finally {
            try { await stopOwned(windowOwner); }
            finally {
                try { await stopOwned(displayServer); }
                finally { windowLines?.close(); displayLines?.close(); isolated.display = ""; }
            }
        }
    });

    it("regression: Return proves the owned event path before Enter and invalid public key checks", async () => {
        const control = await call("key", { key: "Return" });
        expect(control.isError, diagnostics).not.toBe(true);
        expect(await observedKeys(), "Return positive control must reach the owned window before judging Enter").toEqual(["Return"]);

        const enter = await call("key", { key: "Enter" });
        expect(enter.isError).not.toBe(true);
        expect(await observedKeys()).toEqual(["Return", "Return"]);

        const invalid = await call("key", { key: "CCC_NATIVE_UNKNOWN_KEY_1236" });
        expect(invalid.isError).toBe(true);
        expect(await observedKeys(), "invalid key must not generate an event in the owned window").toEqual(["Return", "Return"]);
        expect(isolated.commands).not.toContain("bash");
    });

    it("regression: an owned display without a window manager omits focus and refuses activation", async () => {
        const target = currentDisplayTarget();
        expect(target.available).toBe(true);
        expect(target.capabilities).not.toContain("device_focus_window");
        const focus = await handleDisplayTool("display_focus_window", { handle });
        expect(focus?.isError).toBe(true);
    });
});
