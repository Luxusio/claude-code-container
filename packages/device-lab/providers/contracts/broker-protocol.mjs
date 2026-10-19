// One wire contract shared by the MCP, host CLI and integration runners.
// Bump for incompatible changes or fixes that require replacing an older broker.
// Package releases alone do not change compatibility.
// Version 6 supplies explicit Linux bootstrap identities to the trusted operation
// asset. Replace older daemons before they use their previous in-memory asset pin.
export const DEVICE_BROKER_PROTOCOL_VERSION = 6;
export function isCompatibleBrokerProtocol(value) {
    return value === DEVICE_BROKER_PROTOCOL_VERSION;
}
