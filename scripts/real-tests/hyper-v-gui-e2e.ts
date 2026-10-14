import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { markExpectedToolError, parseToolPayload } from "./device-lab-mcp-client.ts";
import { unfilteredHyperVConsolePixels } from "./hyper-v-console-host.ts";

const GUI_TOOLS = ["screenshot", "click", "key", "type", "scroll", "cursor_position", "move", "window_list", "focus_window", "drag"] as const;

function accepted(result: any, tool: string): any {
    const value = parseToolPayload(result);
    const diagnostic = `hyper-v-gui-${tool.replaceAll("_", "-")}-failed`;
    assert.notEqual(result?.isError, true, diagnostic);
    assert.notEqual(value?.ok, false, diagnostic);
    return value?.result || value;
}

function screenshot(result: any, deviceId: string): Buffer {
    assert.notEqual(result?.isError, true, "hyper-v-gui-screenshot-failed");
    const image = result?.content?.find((item: any) => item?.type === "image" && item?.mimeType === "image/png");
    const text = result?.content?.find((item: any) => item?.type === "text")?.text;
    assert.ok(image && typeof image.data === "string", "hyper-v-gui-screenshot-png-missing");
    let metadata: any;
    try { metadata = JSON.parse(String(text || "{}")); }
    catch { throw new Error("hyper-v-gui-screenshot-metadata-invalid"); }
    assert.equal(metadata.width, 640, "hyper-v-gui-screenshot-width-invalid");
    assert.equal(metadata.height, 480, "hyper-v-gui-screenshot-height-invalid");
    assert.equal(metadata.deviceId, deviceId, "hyper-v-gui-screenshot-device-invalid");
    const png = Buffer.from(image.data, "base64");
    assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "hyper-v-gui-screenshot-png-invalid");
    return png;
}

export function changedHyperVGuiViewportBytes(beforePng: Buffer, afterPng: Buffer): number {
    let before: Buffer;
    let after: Buffer;
    try {
        before = unfilteredHyperVConsolePixels(beforePng);
        after = unfilteredHyperVConsolePixels(afterPng);
    } catch {
        throw new Error("hyper-v-gui-screenshot-pixel-format-invalid");
    }
    assert.ok(before.length === after.length, "hyper-v-gui-screenshot-pixel-format-changed");
    const channels = before.length / (640 * 480);
    let changed = 0;
    // Compare the app's central document/terminal viewport. Exclude taskbars, title
    // chrome and the cursor at the wheel target; a blinking caret cannot clear this bar.
    for (let y = 100; y < 400; y++) {
        for (let x = 80; x < 560; x++) {
            if (x >= 304 && x <= 336 && y >= 224 && y <= 256) continue;
            const offset = (y * 640 + x) * channels;
            for (let channel = 0; channel < channels; channel++) {
                if (before[offset + channel] !== after[offset + channel]) changed++;
            }
        }
    }
    return changed;
}

export async function proveHyperVLinuxGuiKeyboardFile(
    callTool: (tool: string, args: Record<string, unknown>) => Promise<any>,
    direct: Record<string, unknown>,
    nonce: string,
    wait: (milliseconds: number) => Promise<unknown> = delay,
): Promise<void> {
    const path = `/tmp/cccgui${nonce}`;
    const fileExists = async (attempts: number): Promise<boolean> => {
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                const result = accepted(await callTool("exec", { detail: true, ...direct, command: `test -f ${path} && printf ${nonce}` }), "exec");
                if (String(result.stdout || "").trim() === nonce) return true;
            } catch { /* keyboard input may still be reaching the guest */ }
            await wait(500);
        }
        return false;
    };
    const typeFileCommand = async () => {
        accepted(await callTool("type", { detail: true, ...direct, text: `touch ${path}` }), "type");
        accepted(await callTool("key", { detail: true, ...direct, key: "Enter" }), "key");
    };
    const focusTerminal = async (): Promise<{ focused: boolean; stage: string }> => {
        const command = [
            "set -uo pipefail",
            "if ! command -v xdotool >/dev/null; then printf ccc-focus-tool-missing; exit 0; fi",
            "xd=(sudo -n -u ccc-desktop env DISPLAY=:0 XAUTHORITY=/home/ccc-desktop/.Xauthority xdotool)",
            "if ! \"${xd[@]}\" getdisplaygeometry >/dev/null 2>&1; then printf ccc-focus-display-unavailable; exit 0; fi",
            "window=$(\"${xd[@]}\" search --onlyvisible --class xfce4-terminal 2>/dev/null | tail -n 1)",
            "if test -z \"$window\"; then printf ccc-focus-window-missing; exit 0; fi",
            "if ! timeout 4s \"${xd[@]}\" windowactivate --sync \"$window\" >/dev/null 2>&1; then printf ccc-focus-activate-failed; exit 0; fi",
            "active=$(\"${xd[@]}\" getactivewindow 2>/dev/null)",
            "if test \"$active\" != \"$window\"; then printf ccc-focus-active-mismatch; exit 0; fi",
            "printf ccc-terminal-focused",
        ].join("\n");
        let stage = "rpc-failed";
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                const result = accepted(await callTool("exec", { detail: true, ...direct, command, timeoutMs: 5000 }), "exec");
                const marker = String(result.stdout || "").trim();
                if (marker === "ccc-terminal-focused") return { focused: true, stage: "focused" };
                if (/^ccc-focus-(?:tool-missing|display-unavailable|window-missing|activate-failed|active-mismatch)$/.test(marker)) {
                    stage = marker.slice("ccc-focus-".length);
                }
            } catch { /* window manager may still be mapping the terminal */ }
            await wait(500);
        }
        return { focused: false, stage };
    };

    accepted(await callTool("key", { detail: true, ...direct, key: "Ctrl+Alt+T" }), "key");
    await wait(1500);
    // The XFCE launcher can remain above an open terminal. The disposable
    // desktop places the terminal's text viewport in this upper-left region.
    accepted(await callTool("click", { detail: true, ...direct, x: 100, y: 100 }), "click");
    if ((await focusTerminal()).focused) {
        await typeFileCommand();
        if (await fileExists(3)) return;
    }

    // A terminal process or a changed frame does not prove keyboard focus. Try
    // the XFCE application launcher and accept only the guest file as proof.
    accepted(await callTool("key", { detail: true, ...direct, key: "Alt+F2" }), "key");
    await wait(800);
    accepted(await callTool("type", { detail: true, ...direct, text: "xfce4-terminal" }), "type");
    accepted(await callTool("key", { detail: true, ...direct, key: "Enter" }), "key");
    await wait(1500);
    accepted(await callTool("click", { detail: true, ...direct, x: 100, y: 100 }), "click");
    const terminal = await focusTerminal();
    assert.ok(terminal.focused, `hyper-v-gui-linux-terminal-not-focused[stage=${terminal.stage}]`);
    await typeFileCommand();
    assert.ok(await fileExists(8), "hyper-v-gui-keyboard-guest-file-missing");
}

export async function focusHyperVGuiWindow(
    callTool: (tool: string, args: Record<string, unknown>) => Promise<any>,
    direct: Record<string, unknown>,
    guest: "windows" | "linux",
    nonce: string,
    wait: (milliseconds: number) => Promise<unknown> = delay,
): Promise<void> {
    // X11 listings need not expose process names or English terminal titles.
    // Identify the existing terminal through its class, then require its exact
    // handle in the public listing before exercising public focus.
    const command = "timeout 4s sudo -n -u ccc-desktop env DISPLAY=:0 XAUTHORITY=/home/ccc-desktop/.Xauthority bash -c 'set -eo pipefail; xdotool search --onlyvisible --class xfce4-terminal | tail -n 1'";
    for (let attempt = 0; attempt < 6; attempt++) {
        const terminalHandle = guest === "linux"
            ? String(accepted(await callTool("exec", { detail: true, ...direct, command, timeoutMs: 5000 }), "exec").stdout || "").trim()
            : undefined;
        const listing = accepted(await callTool("window_list", { detail: true, ...direct }), "window_list");
        assert.ok(Array.isArray(listing?.windows), "hyper-v-gui-window-list-invalid");
        for (const row of listing.windows) {
            assert.ok(row && typeof row.title === "string" && typeof row.handle === "string"
                && /^[1-9][0-9]{0,15}$/.test(row.handle) && Number.isSafeInteger(Number(row.handle)),
            "hyper-v-gui-window-list-invalid");
        }
        const target = listing.windows.find((row: { title: string; handle: string }) => guest === "windows"
            ? row.title.includes(`ccc-gui-${nonce}`)
            : row.handle === terminalHandle);
        if (target) {
            const focused = accepted(await callTool("focus_window", { detail: true, ...direct, handle: target.handle }), "focus_window");
            assert.equal(focused?.ok, true, "hyper-v-gui-focus-window-failed");
            return;
        }
        if (attempt < 5) await wait(500);
    }
    throw new Error("hyper-v-gui-window-target-missing");
}

export async function proveHyperVGuiDrag(
    callTool: (tool: string, args: Record<string, unknown>) => Promise<any>,
    direct: Record<string, unknown>,
): Promise<void> {
    const dragged = accepted(await callTool("drag", { detail: true, ...direct, x1: 280, y1: 200, x2: 320, y2: 240, durationMs: 300 }), "drag");
    assert.equal(dragged?.applied, true, "hyper-v-gui-drag-failed");
    const cursor = accepted(await callTool("cursor_position", { detail: true, ...direct }), "cursor_position");
    assert.ok(Math.abs(Number(cursor.x) - 320) <= 2 && Math.abs(Number(cursor.y) - 240) <= 2,
        "hyper-v-gui-drag-cursor-position-failed");
}

export async function runHyperVGuiE2E(
    callTool: (tool: string, args: Record<string, unknown>) => Promise<any>,
    direct: Record<string, unknown>,
    guest: "windows" | "linux",
): Promise<{ tools: readonly string[]; visibleChange: boolean }> {
    const nonce = randomBytes(6).toString("hex");
    const first = screenshot(await callTool("screenshot", { detail: true, ...direct }), String(direct.deviceId));
    if (guest === "windows") {
        accepted(await callTool("key", { detail: true, ...direct, key: "Win+R" }), "key");
        await delay(800);
        accepted(await callTool("type", { detail: true, ...direct, text: `cmd /c echo ${nonce} > "%PUBLIC%\\Documents\\ccc-gui-${nonce}.txt"` }), "type");
        accepted(await callTool("key", { detail: true, ...direct, key: "Enter" }), "key");
    } else {
        await proveHyperVLinuxGuiKeyboardFile(callTool, direct, nonce);
    }
    const file = guest === "windows" ? `C:\\Users\\Public\\Documents\\ccc-gui-${nonce}.txt` : `/tmp/cccgui${nonce}`;
    if (guest === "windows") {
        let observed = "";
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                const execution = accepted(await callTool("exec", { detail: true, ...direct, command: `Get-Content -LiteralPath '${file}'` }), "exec");
                observed = String(execution.stdout || "").trim();
                if (observed === nonce) break;
            } catch { /* the input may still be reaching the guest */ }
            await delay(1000);
        }
        assert.ok(observed === nonce, "hyper-v-gui-keyboard-guest-file-missing");
    }
    if (guest === "windows") {
        // Keep a visible editor open: the earlier `cmd /c` Run action closes immediately,
        // so its successful guest-file proof alone cannot prove a changed final frame.
        accepted(await callTool("key", { detail: true, ...direct, key: "Win+R" }), "key");
        await delay(800);
        accepted(await callTool("type", { detail: true, ...direct, text: `notepad "${file}"` }), "type");
        accepted(await callTool("key", { detail: true, ...direct, key: "Enter" }), "key");
        await delay(1500);
        await focusHyperVGuiWindow(callTool, direct, guest, nonce);
        accepted(await callTool("key", { detail: true, ...direct, key: "Win+Up" }), "key");
        // The lines must be visually distinct: a wheel movement over nearly identical
        // line numbers changes too few pixels to prove a real viewport scroll.
        accepted(await callTool("type", { detail: true, ...direct, text: Array.from({ length: 40 }, (_, index) => `CCC ${index.toString().padStart(2, "0")} ${String.fromCharCode(65 + index % 26).repeat(28)}\r\n`).join("") }), "type");
    } else {
        await focusHyperVGuiWindow(callTool, direct, guest, nonce);
        accepted(await callTool("type", { detail: true, ...direct, text: "awk 'BEGIN {for(n=0;n<200;n++){c=sprintf(\"%c\",65+n%26);s=\"\";for(i=0;i<60;i++)s=s c;print n,s}}'" }), "type");
        accepted(await callTool("key", { detail: true, ...direct, key: "Enter" }), "key");
    }
    const rejected = markExpectedToolError(await callTool("click", { detail: true, ...direct, x: 640, y: 240 }));
    assert.ok(/hyper-v-console-pixel-invalid/.test(JSON.stringify(rejected)), "hyper-v-gui-out-of-bounds-click-accepted");
    accepted(await callTool("move", { detail: true, ...direct, x: 10, y: 10 }), "cursor_position");
    const movedAway = accepted(await callTool("cursor_position", { detail: true, ...direct }), "cursor_position");
    assert.ok(Math.abs(Number(movedAway.x) - 10) <= 2 && Math.abs(Number(movedAway.y) - 10) <= 2,
        "hyper-v-gui-cursor-first-position-failed");
    await proveHyperVGuiDrag(callTool, direct);
    accepted(await callTool("move", { detail: true, ...direct, x: 320, y: 240 }), "cursor_position");
    const cursor = accepted(await callTool("cursor_position", { detail: true, ...direct }), "cursor_position");
    assert.ok(Math.abs(Number(cursor.x) - 320) <= 2 && Math.abs(Number(cursor.y) - 240) <= 2,
        "hyper-v-gui-cursor-second-position-failed");
    // Clear any drag selection before taking the scroll baseline.
    accepted(await callTool("click", { detail: true, ...direct, x: 320, y: 240 }), "click");
    accepted(await callTool("click", { count: 2, detail: true, ...direct, x: 320, y: 240 }), "click count=2");
    await delay(700);
    const beforeScroll = screenshot(await callTool("screenshot", { detail: true, ...direct }), String(direct.deviceId));
    accepted(await callTool("scroll", { detail: true, ...direct, x: 320, y: 240, direction: "up", amount: 10 }), "scroll");
    let last = beforeScroll;
    let scrollChangedBytes = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
        await delay(700);
        last = screenshot(await callTool("screenshot", { detail: true, ...direct }), String(direct.deviceId));
        scrollChangedBytes = changedHyperVGuiViewportBytes(beforeScroll, last);
        if (scrollChangedBytes >= 3000) break;
    }
    assert.ok(scrollChangedBytes >= 3000,
        `hyper-v-gui-scroll-no-visible-effect[changed=${scrollChangedBytes}]`);
    assert.ok(changedHyperVGuiViewportBytes(first, last) >= 3000,
        "hyper-v-gui-keyboard-no-visible-effect");
    return { tools: GUI_TOOLS, visibleChange: true };
}
