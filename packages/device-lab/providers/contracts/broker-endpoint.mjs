export function configuredDeviceBrokerPort(env = process.env) {
    const value = env.CCC_DEVICE_BROKER_PORT;
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
        throw new Error("invalid-device-broker-port");
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port > 65535) throw new Error("invalid-device-broker-port");
    return port;
}

export function deviceBrokerRuntimeFilename(env = process.env) {
    const port = configuredDeviceBrokerPort(env);
    return port === undefined || port === 17373 ? "runtime.json" : `runtime-${port}.json`;
}
