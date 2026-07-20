import { spawnSync } from "child_process";

export function runAppleCommand(command, args, timeoutMs = 30000, env = process.env) {
    return spawnSync(command, args, { encoding: "utf-8", env, timeout: timeoutMs, windowsHide: true });
}

export function simctlJson(xcrun, args, options: any = {}) {
    const result = (options.run || runAppleCommand)(xcrun, ["simctl", ...args]);
    if (result.status !== 0) return { error: result.stderr || result.stdout || `exit ${result.status}` };
    try { return { value: JSON.parse(result.stdout || "{}") }; }
    catch { return { error: `invalid simctl JSON: ${result.stdout}` }; }
}

export function simctlDevices(xcrun, options: any = {}): any[] {
    const inventory = simctlJson(xcrun, ["list", "devices", "-j"], options);
    if (inventory.error) throw new Error(inventory.error);
    return Object.values(inventory.value.devices || {}).flat();
}

export function findSimctlDevice(xcrun, predicate, options: any = {}) {
    return simctlDevices(xcrun, options).find(predicate) || null;
}

export function xctraceOutputContainsUdid(output, udid) {
    const wanted = String(udid || "").trim();
    if (!wanted) return false;
    const parenthesized = [...String(output || "").matchAll(/\(([^()]*)\)/g)].map((match) => match[1].trim());
    if (parenthesized.includes(wanted)) return true;
    const tokens: string[] = String(output || "").match(/[A-Za-z0-9._:-]+/g) || [];
    return tokens.includes(wanted);
}

export function parseXctracePhysicalIosDevices(output) {
    const devices: Array<{ name: string; udid: string }> = [];
    let physicalSection = false;
    for (const rawLine of String(output || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (/^==\s*Devices\s*==$/i.test(line)) { physicalSection = true; continue; }
        if (/^==.*==$/i.test(line)) { physicalSection = false; continue; }
        if (!physicalSection || !line) continue;
        const groups = [...line.matchAll(/\(([^()]*)\)/g)].map((match) => match[1].trim());
        const udid = groups.findLast((value) => /^[0-9a-f]{8}-[0-9a-f]{16}$/i.test(value) || /^[0-9a-f]{40}$/i.test(value));
        if (udid) devices.push({ name: line.slice(0, line.indexOf("(")).trim() || "iOS device", udid });
    }
    return devices;
}

export function selectPhysicalIosDevice(output, configuredUdid = "") {
    const devices = parseXctracePhysicalIosDevices(output);
    const explicit = String(configuredUdid || "").trim();
    if (explicit) return xctraceOutputContainsUdid(output, explicit)
        ? { ok: true, udid: explicit, autoSelected: false, devices }
        : { ok: false, reason: `CCC_REAL_IOS_DEVICE_UDID not visible to xctrace: ${explicit}`, devices };
    if (devices.length === 1) return { ok: true, udid: devices[0].udid, autoSelected: true, devices };
    return { ok: false, reason: devices.length === 0
        ? "no physical iOS device visible to xctrace"
        : `multiple physical iOS devices visible; set CCC_REAL_IOS_DEVICE_UDID (${devices.map((device) => device.udid).join(", ")})`, devices };
}
