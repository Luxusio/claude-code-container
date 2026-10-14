// One wire contract shared by the MCP, host CLI and integration runners.
// Bump for incompatible changes or fixes that require replacing an older broker.
// Package releases alone do not change compatibility.
// Version 5 gives each VM definition a generated public deviceId and selects
// subsequent operations with that ID alone. Replace older daemons first.
export const DEVICE_BROKER_PROTOCOL_VERSION = 5;
export function isCompatibleBrokerProtocol(value) {
    return value === DEVICE_BROKER_PROTOCOL_VERSION;
}
