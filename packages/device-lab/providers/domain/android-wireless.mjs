/** @param {any} text */
export function parseAdbDevices(text) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("List of devices"))
        .map((line) => {
            const [serial, state, ...detailParts] = line.split(/\s+/);
            const details = Object.fromEntries(detailParts.map((part) => {
                const index = part.indexOf(":");
                return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, true];
            }));
            const emulator = serial?.startsWith("emulator-") || false;
            const connection = !emulator && parseAndroidWifiEndpoint(serial) ? "wifi" : "usb";
            return { serial, state: state || "unknown", details, emulator, connection };
        })
        .filter((device) => device.serial);
}

/** @param {any} value
 * @param {any} [fallbackPort] */
export function parseAndroidWifiEndpoint(value, fallbackPort = null) {
    const input = String(value || "").trim();
    if (!input) return null;
    const bracketed = input.match(/^\[([^\]]+)](?::(\d+))?$/);
    if (bracketed) {
        const port = bracketed[2] ? Number(bracketed[2]) : Number(fallbackPort);
        return Number.isInteger(port) && port > 0 && port <= 65535 ? { host: bracketed[1], port } : null;
    }
    const colonCount = (input.match(/:/g) || []).length;
    if (colonCount === 1) {
        const separator = input.lastIndexOf(":");
        const port = Number(input.slice(separator + 1));
        if (Number.isInteger(port) && port > 0 && port <= 65535) return { host: input.slice(0, separator), port };
    }
    const port = Number(fallbackPort);
    if (colonCount !== 1 && Number.isInteger(port) && port > 0 && port <= 65535) return { host: input, port };
    return null;
}

/** @param {any} host
 * @param {any} [port] */
export function androidWifiSerial(host, port = 5555) {
    const endpoint = parseAndroidWifiEndpoint(host, port || 5555);
    if (!endpoint) return null;
    const formattedHost = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
    return `${formattedHost}:${endpoint.port}`;
}

/** @param {any} host
 * @param {any} [port]
 * @param {any} [serial] */
export function androidWifiTarget(host, port = 5555, serial = "") {
    if (serial) return androidWifiSerial(serial, port);
    if (!host) return null;
    return androidWifiSerial(host, port);
}

/** @param {any} serial
 * @param {any} host
 * @param {any} port */
export function androidWifiTransport(serial, host, port) {
    const endpoint = parseAndroidWifiEndpoint(serial, port || 5555);
    return {
        type: "wifi",
        host: parseAndroidWifiEndpoint(host, port || 5555)?.host || endpoint?.host || null,
        port: endpoint?.port || Number(port || 5555),
    };
}

/** @param {any} backend
 * @param {any} target
 * @param {any} [fallbackPort] */
export function androidWifiAttachNext(backend, target, fallbackPort = 5555) {
    const endpoint = parseAndroidWifiEndpoint(target, fallbackPort);
    return endpoint ? { tool: "device_attach", arguments: { backend, connection: "wifi", ...endpoint } } : null;
}

/** @param {any[]} command
 * @param {any} result
 * @param {number[]} [redactedIndices] */
export function androidWirelessCommandPayload(command, result, redactedIndices = []) {
    const redacted = new Set(redactedIndices);
    return {
        provider: "adb",
        args: command.map((value, index) => redacted.has(index) ? "[redacted]" : value),
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        signal: result.signal || null,
        error: result.error?.message || null,
    };
}

/** Project the existing raw untimed inventory outcome without normalizing it.
 * @param {any} r
 */
export function androidWirelessDeviceList(r) {
    if (r.status !== 0) {
        return {
            available: false,
            missing: [],
            devices: [],
            error: r.stderr || r.stdout || `exit ${r.status}`,
        };
    }
    return { available: true, missing: [], devices: parseAdbDevices(r.stdout) };
}
