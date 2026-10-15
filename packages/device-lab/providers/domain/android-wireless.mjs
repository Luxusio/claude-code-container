/** @param {unknown} value
 * @param {unknown} [fallbackPort] */
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

/** @param {unknown} host
 * @param {unknown} [port] */
export function androidWifiSerial(host, port = 5555) {
    const endpoint = parseAndroidWifiEndpoint(host, port || 5555);
    if (!endpoint) return null;
    const formattedHost = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
    return `${formattedHost}:${endpoint.port}`;
}

/** @param {unknown} host
 * @param {unknown} [port]
 * @param {unknown} [serial] */
export function androidWifiTarget(host, port = 5555, serial = "") {
    if (serial) return androidWifiSerial(serial, port);
    if (!host) return null;
    return androidWifiSerial(host, port);
}

/** @param {unknown} serial
 * @param {unknown} host
 * @param {unknown} port */
export function androidWifiTransport(serial, host, port) {
    const endpoint = parseAndroidWifiEndpoint(serial, port || 5555);
    return {
        type: "wifi",
        host: parseAndroidWifiEndpoint(host, port || 5555)?.host || endpoint?.host || null,
        port: endpoint?.port || Number(port || 5555),
    };
}

/** @param {unknown} backend
 * @param {unknown} target
 * @param {unknown} [fallbackPort] */
export function androidWifiAttachNext(backend, target, fallbackPort = 5555) {
    const endpoint = parseAndroidWifiEndpoint(target, fallbackPort);
    return endpoint ? { tool: "device_attach", arguments: { backend, connection: "wifi", ...endpoint } } : null;
}

