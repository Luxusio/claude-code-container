import { existsSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../commands.mjs";
import { DISPLAY, ownerId } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";

export function x11Available() {
    if (!existsSync("/usr/bin/xdotool") && !existsSync("/bin/xdotool")) return false;
    if (!existsSync("/usr/bin/scrot") && !existsSync("/bin/scrot")) return false;
    return true;
}

export function currentDisplayTarget() {
    return {
        id: "x11-current-display",
        kind: "display",
        backend: "x11",
        creatable: false,
        lifecycle: "current",
        ownerId: ownerId(),
        display: DISPLAY,
        capabilities: [
            "display_screenshot",
            "display_click",
            "display_double_click",
            "display_key",
            "display_type",
            "display_scroll",
            "display_cursor_position",
        ],
        available: x11Available(),
    };
}

export async function handleDisplayTool(name, args) {
    switch (name) {
        case "display_current":
            return jsonResult(currentDisplayTarget());

        case "display_screenshot": {
            const ssPath = join(tmpdir(), `device_lab_x11_${Date.now()}.png`);
            const r = run("scrot", ["-p", "-o", ssPath]);
            if (r.status !== 0) return fail(r);
            const base64 = readFileSync(ssPath).toString("base64");
            try { unlinkSync(ssPath); } catch { /* ignore */ }
            return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
        }

        case "display_click": {
            const { x, y, button = "left" } = args;
            const buttonId = button === "right" ? "3" : "1";
            const r = run("xdotool", ["mousemove", String(x), String(y), "click", buttonId]);
            return r.status === 0 ? textResult(true, `${button} clicked at (${x}, ${y})`) : fail(r);
        }

        case "display_double_click": {
            const { x, y } = args;
            const r = run("xdotool", ["mousemove", String(x), String(y), "click", "--repeat", "2", "1"]);
            return r.status === 0 ? textResult(true, `Double-clicked at (${x}, ${y})`) : fail(r);
        }

        case "display_key": {
            const { key } = args;
            const r = run("xdotool", ["key", "--", key]);
            return r.status === 0 ? textResult(true, `Sent key: ${key}`) : fail(r);
        }

        case "display_type": {
            const { text } = args;
            const r = run("xdotool", ["type", "--clearmodifiers", "--", text]);
            return r.status === 0 ? textResult(true, "Typed text successfully") : fail(r);
        }

        case "display_scroll": {
            const { x, y, direction, amount = 3 } = args;
            const buttonMap = { up: 4, down: 5, left: 6, right: 7 };
            const button = buttonMap[direction];
            if (!button) return textResult(false, `Unknown scroll direction: ${direction}`);
            const r = run("xdotool", [
                "mousemove", String(x), String(y),
                "click", "--repeat", String(amount), String(button),
            ]);
            return r.status === 0 ? textResult(true, `Scrolled ${direction} ${amount}x at (${x}, ${y})`) : fail(r);
        }

        case "display_cursor_position": {
            const r = run("xdotool", ["getmouselocation"]);
            return r.status === 0 ? textResult(true, r.stdout.trim()) : fail(r);
        }

        default:
            return undefined;
    }
}
