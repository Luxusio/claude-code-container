/** @typedef {{deviceId?:string,x?:number,y?:number,x1?:number,y1?:number,x2?:number,y2?:number,durationMs?:number,button?:string,key?:string,text?:string|null,direction?:string,amount?:number,handle?:string,helperTimeoutMs?:number,localPath?:string,remotePath?:string}} DesktopArguments */
/** @typedef {{kind:'json',value:object}|{kind:'text',ok:boolean,text:string}|{kind:'command-failure',receipt:{status:number|null,stdout:string,stderr:string}}|{kind:'native',value:object}|undefined} DesktopOutcome */
/** @param {unknown} x @param {unknown} y */
export function desktopPointValid(x, y) {
    return [x, y].every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2147483647);
}
/** @param {DesktopArguments} args */
export function desktopDragValid(args) {
    return desktopPointValid(args.x1, args.y1) && desktopPointValid(args.x2, args.y2)
        && Number.isInteger(args.durationMs ?? 700) && (args.durationMs ?? 700) >= 1 && (args.durationMs ?? 700) <= 10000;
}
/** @param {string} key */
export function windowsSendKeysExpression(key) {
    const value = String(key || "");
    /** @type {Record<string,string>} */
    const aliases = {
        Enter: "{ENTER}",
        Return: "{ENTER}",
        Escape: "{ESC}",
        Esc: "{ESC}",
        Tab: "{TAB}",
        Backspace: "{BACKSPACE}",
        Delete: "{DELETE}",
        Del: "{DELETE}",
        Insert: "{INSERT}",
        Space: " ",
        ArrowUp: "{UP}",
        Up: "{UP}",
        ArrowDown: "{DOWN}",
        Down: "{DOWN}",
        ArrowLeft: "{LEFT}",
        Left: "{LEFT}",
        ArrowRight: "{RIGHT}",
        Right: "{RIGHT}",
        PageUp: "{PGUP}",
        PageDown: "{PGDN}",
        Home: "{HOME}",
        End: "{END}",
    };
    for (let index = 1; index <= 24; index += 1) aliases[`F${index}`] = `{F${index}}`;
    const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
    if (parts.length <= 1) return aliases[value] || value;
    const keyPart = parts[parts.length - 1];
    const base = aliases[keyPart] || (keyPart.length === 1 ? keyPart.toLowerCase() : keyPart);
    const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
    let prefix = "";
    if (modifiers.some((part) => part === "control" || part === "ctrl")) prefix += "^";
    if (modifiers.includes("alt")) prefix += "%";
    if (modifiers.includes("shift")) prefix += "+";
    return `${prefix}${base}`;
}

/** @param {string} text */
export function windowsSendKeysLiteralText(text) {
    return String(text ?? "").replace(/[+^%~()[\]{}]/g, (match) => `{${match}}`);
}

/** @param {string|undefined} key */
export function macosKeySpec(key) {
    const value = String(key || "");
    /** @type {Record<string,number>} */
    const keyCodes = {
        A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38, K: 40, L: 37, M: 46,
        N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17, U: 32, V: 9, W: 13, X: 7, Y: 16, Z: 6,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        Enter: 36, Return: 36, Tab: 48, Space: 49, Delete: 51, Backspace: 51, Escape: 53, Esc: 53,
        ArrowLeft: 123, Left: 123, ArrowRight: 124, Right: 124, ArrowDown: 125, Down: 125, ArrowUp: 126, Up: 126,
        Home: 115, End: 119, PageUp: 116, PageDown: 121,
        F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
    };
    const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
    const keyPart = parts.length > 0 ? parts[parts.length - 1] : value;
    const normalizedKey = keyPart.length === 1 ? keyPart.toUpperCase() : keyPart;
    const keyCode = keyCodes[normalizedKey];
    if (keyCode === undefined) return null;
    const modifiers = [];
    for (const part of parts.slice(0, -1).map((item) => item.toLowerCase())) {
        if (part === "cmd" || part === "command" || part === "meta") modifiers.push("command");
        else if (part === "ctrl" || part === "control") modifiers.push("control");
        else if (part === "alt" || part === "option") modifiers.push("option");
        else if (part === "shift") modifiers.push("shift");
        else return null;
    }
    return { key, keyCode, modifiers };
}

