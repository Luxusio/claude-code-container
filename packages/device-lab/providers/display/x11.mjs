import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run, runWithTimeout } from "../commands.mjs";
import { DISPLAY, ownerId } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { readScreenshotFile } from "../screenshot-file.mjs";
import { withTargetStatus } from "../status.mjs";
import { X11_WINDOW_LIST_COMMAND, parseX11WindowList } from "./window-list.mjs";

import { X11_DRAG_COMMAND } from "./desktop-input.mjs";
import { createDesktopControlTransfer } from "../application/desktop-control-transfer.mjs";
import { createDisplayDeviceAccess } from "../application/desktop-device-access.mjs";
import { createDesktopAccessResult } from "../adapters/desktop-access-result.mjs";

export function x11Available() {
    if (!existsSync("/usr/bin/xdotool") && !existsSync("/bin/xdotool")) return false;
    if (!existsSync("/usr/bin/scrot") && !existsSync("/bin/scrot")) return false;
    return true;
}

/** @param {string} stdout */
function decodeCursorPosition(stdout) {
    const fields = Object.fromEntries(String(stdout || "").trim().split(/\s+/).map(part => part.split(":")).filter(([key, value]) => key && value !== undefined));
    const x = Number(fields.x), y = Number(fields.y), screen = Number(fields.screen);
    return { x: Number.isFinite(x) ? x : null, y: Number.isFinite(y) ? y : null, screen: Number.isFinite(screen) ? screen : null, window: fields.window || null, raw: String(stdout || "").trim(), provider: "xdotool" };
}

/** @typedef {{receipt:ReturnType<typeof run>,windows?:ReturnType<typeof parseX11WindowList>,cursor?:ReturnType<typeof decodeCursorPosition>,invalidWindowList?:boolean}} X11Evidence */
/** @param {ReturnType<typeof run>} receipt */
function observeCommand(receipt) {
    return { ok: receipt.status === 0, evidence: { receipt } };
}

/** @type {import('../ports/desktop-control-transfer.mjs').X11Ports} */
const x11Ports = {
    variant: "x11",
    windowList: timeoutMs => {
        const receipt = runWithTimeout("bash", ["-c", X11_WINDOW_LIST_COMMAND], timeoutMs, { maxBuffer: 1024 * 1024 });
        if (receipt.status !== 0) return observeCommand(receipt);
        try { return { ok: true, evidence: { receipt, windows: parseX11WindowList(receipt.stdout) } }; }
        catch { return { ok: false, evidence: { receipt, invalidWindowList: true } }; }
    },
    activateWindow: (handle, timeoutMs) => observeCommand(runWithTimeout("xdotool", ["windowactivate", "--sync", handle], timeoutMs)),
    activeWindow: timeoutMs => {
        const receipt = runWithTimeout("xdotool", ["getactivewindow"], timeoutMs);
        return { ...observeCommand(receipt), handle: receipt.status === 0 ? receipt.stdout.trim() : "" };
    },
    movePointer: (x, y) => observeCommand(run("xdotool", ["mousemove", String(x), String(y)])),
    click: (x, y, button) => observeCommand(run("xdotool", ["mousemove", String(x), String(y), "click", button === "right" ? "3" : "1"])),
    doubleClick: (x, y, button) => observeCommand(run("xdotool", ["mousemove", String(x), String(y), "click", "--repeat", "2", button === "right" ? "3" : "1"])),
    key: key => observeCommand(run("xdotool", ["key", "--", key])),
    type: text => observeCommand(run("xdotool", ["type", "--clearmodifiers", "--", text])),
    scroll: (x, y, direction, amount) => {
        const buttonId = direction === "up" ? 4 : direction === "down" ? 5 : direction === "left" ? 6 : 7;
        return observeCommand(run("xdotool", ["mousemove", String(x), String(y), "click", "--repeat", String(amount), String(buttonId)]));
    },
    cursorPosition: () => {
        const receipt = run("xdotool", ["getmouselocation"]);
        return { ok: receipt.status === 0, evidence: { receipt, cursor: receipt.status === 0 ? decodeCursorPosition(receipt.stdout) : undefined } };
    },
    drag: args => observeCommand(runWithTimeout("bash", ["-c", X11_DRAG_COMMAND, "ccc-drag", ...[args.x1, args.y1, args.x2, args.y2, args.durationMs].map(String)], 15000)),
};

/** @param {Exclude<import('../domain/desktop-control-transfer.mjs').DesktopOutcome,undefined>} outcome */
function renderDesktopControl(outcome) {
    if (outcome.kind === "refused") return textResult(false, outcome.message);
    const evidence = /** @type {X11Evidence} */ (outcome.evidence);
    if (outcome.kind === "failed") return evidence.invalidWindowList ? textResult(false, "window-list-invalid-result") : fail(evidence.receipt);
    const { name, args } = outcome;
    const { x, y, button = "left", key, text, direction, amount = 3 } = args;
    const { stdout, stderr, status } = evidence.receipt;
    if (name === "display_window_list") return jsonResult(evidence.windows);
    if (name === "display_cursor_position") return jsonResult(evidence.cursor);
    if (name === "display_drag" || name === "display_move" || name === "display_focus_window") return jsonResult({ ok: true });
    if (name === "display_click" || name === "display_double_click") return jsonResult({ [name === "display_click" ? "clicked" : "doubleClicked"]: { x, y, button }, provider: "xdotool", stdout, stderr, status });
    if (name === "display_key") return jsonResult({ key, provider: "xdotool", stdout, stderr, status });
    if (name === "display_type") return jsonResult({ typed: true, length: String(text || "").length, provider: "xdotool", stdout, stderr, status });
    return jsonResult({ scrolled: { x, y, direction, amount }, provider: "xdotool", stdout, stderr, status });
}
const desktopControls = createDesktopControlTransfer(x11Ports);

/** @type {import('../ports/desktop-device-access.mjs').X11DeviceAccessPorts<ReturnType<typeof withTargetStatus>,{tempRoot:string,localPath:string}>} */
const displayAccessPorts = {
    variant: "x11",
    owner: () => ownerId(),
    display: () => DISPLAY,
    available: () => x11Available(),
    publicTarget: target => withTargetStatus(target),
    stageScreenshot: () => {
        const tempRoot = mkdtempSync(join(tmpdir(), "ccc-x11-screenshot-"));
        return { tempRoot, localPath: join(tempRoot, "screenshot.png") };
    },
    capture: stage => {
        const receipt = runWithTimeout("scrot", ["-p", "-o", stage.localPath], 30_000);
        return {ok:receipt.status === 0,receipt};
    },
    readScreenshot: stage => readScreenshotFile(stage.localPath, "x11-screenshot"),
    disposeScreenshot: stage => { rmSync(stage.tempRoot, { recursive: true, force: true }); return undefined; },
};
const displayAccess = createDisplayDeviceAccess(displayAccessPorts);
const displayAccessResult = createDesktopAccessResult({jsonResult,textResult,fail});

export function currentDisplayTarget() { return displayAccess.current(); }

/** @param {string} name @param {import('../domain/desktop-control-transfer.mjs').DesktopArguments} args */
export async function handleDisplayTool(name, args) {
    switch (name) {
        case "display_current":
        case "display_screenshot": {
            return displayAccessResult(await displayAccess.handle(name));
        }

        default: {
            const outcome = await desktopControls.handle(name, args);
            if (!outcome) return undefined;
            return renderDesktopControl(outcome);
        }
    }
}
