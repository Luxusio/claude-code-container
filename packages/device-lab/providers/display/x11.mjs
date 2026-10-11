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

export function x11Available() {
    if (!existsSync("/usr/bin/xdotool") && !existsSync("/bin/xdotool")) return false;
    if (!existsSync("/usr/bin/scrot") && !existsSync("/bin/scrot")) return false;
    return true;
}

/** @type {import('../ports/desktop-control-transfer.mjs').X11Ports} */
const x11Ports = {
    variant: "x11",
    command: argv => run("xdotool", argv),
    boundedCommand: (argv, timeoutMs) => runWithTimeout("xdotool", argv, timeoutMs),
    windowList: timeoutMs => runWithTimeout("bash", ["-c", X11_WINDOW_LIST_COMMAND], timeoutMs, { maxBuffer: 1024 * 1024 }),
    parseWindowList: parseX11WindowList,
    drag: (x1, y1, x2, y2, durationMs) => runWithTimeout("bash", ["-c", X11_DRAG_COMMAND, "ccc-drag", ...[x1, y1, x2, y2, durationMs].map(String)], 15000),
};
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
    capture: stage => runWithTimeout("scrot", ["-p", "-o", stage.localPath], 30_000),
    readScreenshot: stage => readScreenshotFile(stage.localPath, "x11-screenshot"),
    disposeScreenshot: stage => { rmSync(stage.tempRoot, { recursive: true, force: true }); return undefined; },
};
const displayAccess = createDisplayDeviceAccess(displayAccessPorts);

export function currentDisplayTarget() { return displayAccess.current(); }

/** @param {string} name @param {import('../domain/desktop-control-transfer.mjs').DesktopArguments} args */
export async function handleDisplayTool(name, args) {
    switch (name) {
        case "display_current":
        case "display_screenshot": {
            const outcome = await displayAccess.handle(name);
            if (!outcome) return undefined;
            if (outcome.kind === "json") return jsonResult(outcome.value);
            if (outcome.kind === "command-failure") return fail(outcome.receipt);
            if (outcome.kind === "native") return outcome.value;
            if (outcome.kind === "text") return textResult(false, outcome.text);
            return { content: [{ type: "image", data: outcome.data, mimeType: "image/png" }] };
        }

        default: {
            const outcome = await desktopControls.handle(name, args);
            if (!outcome) return undefined;
            if (outcome.kind === "json") return jsonResult(outcome.value);
            if (outcome.kind === "text") return textResult(outcome.ok, outcome.text);
            if (outcome.kind === "command-failure") return fail(outcome.receipt);
            return outcome.value;
        }
    }
}
