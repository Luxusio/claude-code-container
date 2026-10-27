// One wire contract shared by the MCP, host CLI and integration runners.
// Bump for incompatible changes or fixes that require replacing an older broker.
// Package releases alone do not change compatibility.
// Version 9 requires Simulator argv forwarding and Mac guest-helper preparation.
// Replace older daemons before reusing their in-memory adapter implementation.
export const DEVICE_BROKER_PROTOCOL_VERSION = 9;
export function isCompatibleBrokerProtocol(value) {
    return value === DEVICE_BROKER_PROTOCOL_VERSION;
}
