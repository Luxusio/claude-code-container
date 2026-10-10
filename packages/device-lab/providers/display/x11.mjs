import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run, runWithTimeout } from "../commands.mjs";
import { DISPLAY, ownerId } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { screenshotFileResult } from "../screenshot-file.mjs";
import { withTargetStatus } from "../status.mjs";
import { X11_WINDOW_LIST_COMMAND, parseX11WindowList } from "./window-list.mjs";

import { X11_DRAG_COMMAND } from "./desktop-input.mjs";
import { createDesktopControlTransfer } from "../application/desktop-control-transfer.mjs";

export function x11Available() {
    if (!existsSync("/usr/bin/xdotool") && !existsSync("/bin/xdotool")) return false;
    if (!existsSync("/usr/bin/scrot") && !existsSync("/bin/scrot")) return false;
    return true;
}

export function currentDisplayTarget() {
    return withTargetStatus({
        id: "x11-current-display",
        kind: "display",
        backend: "x11",
        creatable: false,
        lifecycle: "current",
        ownerId: ownerId(),
        display: DISPLAY,
        capabilities: [
            "device_status",
            "device_screenshot",
            "device_click",
            "device_double_click",
            "device_key",
            "device_type",
            "device_scroll",
            "device_cursor_position",
            "device_window_list",
            "device_drag",
            "device_focus_window",
            "display_screenshot",
            "display_click",
            "display_double_click",
            "display_key",
            "display_type",
            "display_scroll",
            "display_cursor_position",
        ],
        available: x11Available(),
    });
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

/** @param {string} name @param {import('../domain/desktop-control-transfer.mjs').DesktopArguments} args */
export async function handleDisplayTool(name, args) {
    switch (name) {
        case "display_current":
            return jsonResult(currentDisplayTarget());

        case "display_screenshot": {
            const tempRoot = mkdtempSync(join(tmpdir(), "ccc-x11-screenshot-"));
            const ssPath = join(tempRoot, "screenshot.png");
            try {
                const r = runWithTimeout("scrot", ["-p", "-o", ssPath], 30_000);
                if (r.status !== 0) return fail(r);
                return screenshotFileResult(ssPath, "x11-screenshot");
            } finally {
                rmSync(tempRoot, { recursive: true, force: true });
            }
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
